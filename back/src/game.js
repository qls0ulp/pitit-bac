import { is_answer_valid, is_answer_accepted, compare_answers } from "ptitbac-commons";
import { log_info } from "./logging";

export class Game {
  constructor(slug, server) {
    this.SCORES = {
      // The answer is valid, accepted by the players, and is not duplicated.
      valid: 10,

      // Same as the above, but another player answered the same thing for this
      // category.
      duplicate: 5,

      // The answer is invalid (does not start with the good letter).
      invalid: 0,

      // The answer is valid, but was refused by the other players.
      refused: 0,

      // The answer is empty.
      empty: 0
    };

    this.slug = slug;
    this.server = server;

    this.players = {};
    this.master_player_uuid = null;

    // If the duration is set to this value, then the round will only
    // stop when the first ends (if stopOnFirstCompletion) or when
    // all players end (else).
    this.infinite_duration = 600;

    this.configuration = {
      categories: [
        "Pays",
        "Ville",
        "Prénom masculin",
        "Prénom féminin",
        "Métier",
        "Objet",
        "Animal",
        "Végétal",
        "Couleur"
      ],
      stopOnFirstCompletion: true,
      turns: 4,
      time: this.infinite_duration
    };

    this.state = "CONFIG";

    this.current_round = 0;
    this.current_letter = null;
    this.current_started = null;
    this.current_timeout = null;
    this.current_round_interrupted_by = null;

    this.current_round_answers_final_received = [];
    this.current_round_votes_ready = [];

    this.rounds = {};
    this.final_scores = [];

    this.letters = "ABCDEFGHIJKLMNOPQRSTUVWXY";
    this.used_letters = [];

    this.pending_deletion_task = null;
    this.pending_deletion_threshold = 1000 * 60 * 20;
  }

  log(message) {
    log_info("[" + this.slug + "] " + message);
  }

  static clean_player_for_users(player) {
    return {
      uuid: player.uuid,
      pseudonym: player.pseudonym,
      ready: player.ready,
      master: player.master,
      online: player.online
    };
  }

  // Checks if all items in the first array are included in the
  // second target array. Returns `true` if so, `false` else.
  static first_included_into_second(array, target) {
    return target.every(value => array.includes(value));
  }

  is_valid_player(uuid) {
    return !!this.players[uuid];
  }

  online_players() {
    return Object.values(this.players).filter(player => player.online);
  }

  online_players_uuids() {
    return this.online_players().map(player => player.uuid);
  }

  is_valid_category(category) {
    return this.configuration.categories.includes(category);
  }

  random_letter() {
    let letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let letter = "";

    if (this.used_letters.length == letters.length) {
      this.used_letters = [];
    }

    while (!letter || this.used_letters.indexOf(letter) !== -1) {
      letter = letters.charAt(Math.floor(Math.random() * letters.length));
    }

    this.used_letters.push(letter);
    return letter;
  }

  broadcast(action, message) {
    this.online_players().filter(player => player.connection !== null).forEach(player => this.server.send_message(player.connection, action, message));
  }

  send_message(uuid, action, message) {
    let player = this.players[uuid];
    if (!player || !player.online || !player.connection) return;

    this.server.send_message(player.connection, action, message);
  }

  start_deletion_process() {
    this.pending_deletion_task = setTimeout(() => {
      this.log(`${this.pending_deletion_threshold / 1000} seconds without players: destroying game.`);
      this.server.delete_game(this.slug);
    }, this.pending_deletion_threshold);
  }

  halt_deletion_process() {
    if (this.pending_deletion_task) {
      clearTimeout(this.pending_deletion_task);
      this.pending_deletion_task = null;
    }
  }

  join(connection, uuid, pseudonym) {
    // This player is the master (can configure the game)
    // if it created the game, i.e. if it's the first player.
    let master_player = (this.online_players().length === 0) || this.master_player_uuid === uuid;

    // Is this a reconnection?
    let player = this.players[uuid];

    if (player && !player.online) {
      player.online = true;
      player.connection = connection;
    }
    else {
      player = {
        connection: connection,
        uuid: uuid,
        pseudonym: pseudonym,
        ready: true,
        online: true,
        master: master_player
      };

      this.players[player.uuid] = player;
    }

    if (master_player) {
      this.master_player_uuid = player.uuid;
    }

    this.broadcast("player-join", {player: Game.clean_player_for_users(player)});

    // We send to this new player all other players
    Object.keys(this.players).filter(uuid => uuid !== player.uuid).forEach(uuid => {
      this.server.send_message(connection, "player-join", {player: Game.clean_player_for_users(this.players[uuid])});
    });

    // And the current game configuration
    this.send_message(uuid, "config-updated", {configuration: this.configuration});

    // And the game state if we're not in CONFIG
    if (this.state !== "CONFIG") {
      this.catch_up(uuid);
    }

    this.log("Player " + player.pseudonym + " (" + player.uuid + ") joined the game (total: " + this.online_players().length + "/" + Object.keys(this.players).length + ").");

    this.halt_deletion_process();
  }

  left(uuid) {
    console.log("Game left", uuid);
    let player = this.players[uuid];
    if (!player) return;
    console.log("Has player", player);

    if (this.state === "CONFIG") {
      delete this.players[uuid];
    }
    else {
      player.online = false;
      player.connection = null;
    }

    this.broadcast("player-left", {player: {
      uuid: player.uuid
    }});

    this.log("Player " + player.pseudonym + " (" + player.uuid + ") left the game (still online: " + this.online_players().length + "/" + Object.keys(this.players).length + ").");

    if (this.state === "ROUND_ANSWERS" || this.state === "ROUND_ANSWERS_FINAL") {
      this.check_for_round_end();
    }
    else if (this.state === "ROUND_VOTES") {
      this.check_for_vote_end();
    }

    if (this.online_players().length === 0) {
      this.start_deletion_process();
    }
  }

  /**
   * When a client connects during the game, this method will send it the
   * current state of the game, so it can catch up.
   */
  catch_up(uuid) {
    if (this.state === "CONFIG") return;

    let catch_up = {
      state: this.state === "ROUND_ANSWERS_FINAL" ? "ROUND_ANSWERS" : this.state
    };

    switch (this.state) {
      case "ROUND_ANSWERS":
      case "ROUND_ANSWERS_FINAL":
        catch_up.round = {
          round: this.current_round,
          letter: this.current_letter,
          time_left: this.configuration.time !== this.infinite_duration ? (this.configuration.time - Math.floor((Date.now() - this.current_started) / 1000)) : null,
          players_ready: Object.keys(this.rounds[this.current_round].answers)
        };
        break;

      case "ROUND_VOTES":
        catch_up.vote = {
          answers: this.rounds[this.current_round].votes,
          interrupted: this.current_round_interrupted_by,
          players_ready: this.current_round_votes_ready
        };
        break;

      case "END":
        catch_up.end = {
          scores: this.final_scores
        };
        break;
    }

    switch (this.state) {
      case "ROUND_ANSWERS_FINAL":
        this.current_round_answers_final_received.push(uuid);
        break;

      case "ROUND_VOTES":
        this.current_round_votes_ready.push(uuid);
        break;
    }

    this.send_message(uuid, "catch-up-game-state", catch_up);
  }

  update_configuration(connection, uuid, configuration) {
    // We don't accept configuration update during the game.
    if (this.state != "CONFIG") return;
    if (!this.is_valid_player(uuid)) return;

    // If the configuration is updated by a non-master player,
    // we ignore it and send a configuration update with the current config
    // to erase client-side its changes.
    if (this.master_player_uuid !== uuid) {
      this.send_message(uuid, "config-updated", {configuration: this.configuration});
      return;
    }

    // Else we update the internal configuration and send the update to everyone.
    this.configuration = {
      categories: configuration.categories
      .filter((a, b) => configuration.categories.indexOf(a) === b)
      .map(c => c.toString().trim()),
      stopOnFirstCompletion: !!configuration.stopOnFirstCompletion,
      turns: Math.max(Math.abs(parseInt(configuration.turns) || 4), 1),
      time: Math.max(Math.abs(parseInt(configuration.time) || 400), 15),
    };

    this.broadcast("config-updated", {configuration: this.configuration});
  }

  start(connection, uuid) {
    if (!this.is_valid_player(uuid)) return;
    if (this.master_player_uuid !== uuid) return; // Nope

    this.log("Starting game");
    this.next_round();
  }

  next_round() {
    this.state = "ROUND_ANSWERS";
    this.current_round++;
    this.current_letter = this.random_letter();

    this.current_round_answers_final_received = [];
    this.current_round_votes_ready = [];

    this.rounds[this.current_round] = {
      letter: this.current_letter,
      answers: {},
      votes: {}
    };

    this.broadcast("round-started", {
      "round": this.current_round,
      "letter": this.current_letter
    });

    this.current_started = Date.now();

    if (this.configuration.time != this.infinite_duration) {
      this.current_timeout = setTimeout(() => {
        this.end_round();
      }, this.configuration.time * 1000);
    }
  }

  receive_answers(uuid, answers) {
    if (!this.is_valid_player(uuid)) return;
    if (this.state !== "ROUND_ANSWERS" && this.state !== "ROUND_ANSWERS_FINAL") return;

    let checked_answers = {};
    let all_valid = true;

    this.configuration.categories.forEach(category => {
      if (Object.prototype.hasOwnProperty.call(answers, category)) {
        let valid = is_answer_valid(this.current_letter, answers[category]);
        all_valid &= valid;

        checked_answers[category] = {
          answer: answers[category],
          valid: valid
        };
      }
      else {
        all_valid = false;
        checked_answers[category] = {
          answer: null,
          valid: false
        };
      }
    });

    this.rounds[this.current_round].answers[uuid] = checked_answers;

    if (this.state == "ROUND_ANSWERS") {
      this.broadcast("player-ready", {player: {uuid: uuid}});

      if (this.configuration.stopOnFirstCompletion) {
        this.current_round_interrupted_by = uuid;
        this.end_round();
      }
    }
    else {
      this.current_round_answers_final_received.push(uuid);
    }

    this.check_for_round_end();
  }

  check_for_round_end() {
    if (this.state !== "ROUND_ANSWERS" && this.state !== "ROUND_ANSWERS_FINAL") return;

    // Normal round answers time: we end the round if everyone answered.
    if (this.state == "ROUND_ANSWERS") {
      if (Game.first_included_into_second(Object.keys(this.rounds[this.current_round].answers), this.online_players_uuids())) {
        this.end_round();
      }
    }

    // Final round answer time: we have to collect the answers for every player.
    // We check for each answers if we have the whole serie; if so, we go to the
    // voting phase.
    else {
      if (Game.first_included_into_second(this.current_round_answers_final_received, this.online_players_uuids())) {
        this.start_vote();
      }
    }
  }

  end_round() {
    if (this.state !== "ROUND_ANSWERS") return;

    this.state = "ROUND_ANSWERS_FINAL";
    this.broadcast("round-ended", {});

    this.log(`Round #${this.current_round} ended. Collecting answers…`);

    // If there is no one logged in when the round ends, we start the vote.
    // If the players log in again, they'll have some kind of vote (sadly,
    // without all answers), and if not, the game will be cleaned up at
    // some point.
    if (this.online_players().length === 0) {
      this.start_vote();
    }
  }

  start_vote() {
    this.log(`Starting vote for round #${this.current_round}.`);

    // We assemble the votes by category, then send them to the clients.

    let votes = {};

    Object.keys(this.rounds[this.current_round].answers).forEach(uuid => {
      let answers = this.rounds[this.current_round].answers[uuid];

      Object.keys(answers).forEach(category => {
        if (!Object.prototype.hasOwnProperty.call(votes, category)) {
          votes[category] = {};
        }

        let answer = answers[category];
        let vote = {
          answer: answer.answer,
          valid: answer.valid,
          votes: {}
        };

        this.online_players_uuids().forEach(uuid => vote.votes[uuid] = answer.valid);

        votes[category][uuid] = vote;
      });
    });

    this.rounds[this.current_round].votes = votes;
    this.broadcast("vote-started", {answers: votes, interrupted: this.current_round_interrupted_by});

    this.state = "ROUND_VOTES";
  }

  receive_vote(uuid, category, author_uuid, vote) {
    if (this.state !== "ROUND_VOTES") return;
    if (!this.is_valid_player(uuid) || !this.is_valid_player(author_uuid) || !this.is_valid_category(category)) return;

    let author_answer = this.rounds[this.current_round].votes[category][author_uuid];

    // We don't want someone messing up with newly-joined players, with a valid
    // UUID but without vote entry. (Not possible with the standard client but
    // prevents abuses.)
    if (!author_answer) return;

    author_answer.votes[uuid] = vote;
    this.broadcast("vote-changed", {
      voter: {
          uuid: uuid
      },
      vote: {
          uuid: author_uuid,
          category: category,
          vote: !!vote
      }
    });
  }

  receive_vote_ready(uuid) {
    this.current_round_votes_ready.push(uuid);
    this.broadcast("player-ready", {player: {uuid: uuid}});
    this.check_for_vote_end();
  }

  check_for_vote_end() {
    if (Game.first_included_into_second(this.current_round_votes_ready, this.online_players_uuids())) {
      if (this.current_round === this.configuration.turns) {
        this.end_game();
      }
      else {
        this.next_round();
      }
    }
  }

  end_game() {
    if (this.state !== "ROUND_VOTES") return;

    this.log("Ending game…");

    // For each connected player, we count its scores
    Object.keys(this.players).forEach(uuid => {
      let score = 0;

      Object.keys(this.rounds).forEach(round => {
        this.configuration.categories.forEach(category => {
          let votes = this.rounds[round].votes[category];
          let player_votes = votes[uuid];

          if (!player_votes || !player_votes.answer) {
            score += this.SCORES.empty;
            return;
          }
          else if (!player_votes.valid) {
            score += this.SCORES.invalid;
            return;
          }
          else if (!is_answer_accepted(player_votes.votes)) {
            score += this.SCORES.refused;
            return;
          }

          // We check if the answer is unique.
          let unique = true;

          Object.keys(votes).forEach(other_answer_author_uuid => {
            // Don't compare with ourself.
            if (other_answer_author_uuid === uuid) return;

            let other_answer = votes[other_answer_author_uuid].answer;
            if (other_answer && compare_answers(player_votes.answer, other_answer)) {
              unique = false;
            }
          });

          if (unique) {
            score += this.SCORES.valid;
          }
          else {
            score += this.SCORES.duplicate;
          }
        });
      });

      this.final_scores.push({
        uuid: uuid,
        score: score
      });
    });

    this.final_scores.sort((a, b) => b.score - a.score);

    let rank = 1;
    this.final_scores.forEach((score, i) => {
      // We only increase the rank if the score is different.
      if (i > 0 && this.final_scores[i].score < this.final_scores[i - 1].score) {
        rank++;
      }

      this.final_scores[i].rank = rank;
    });

    this.broadcast("game-ended", {scores: this.final_scores});
    this.state = "END";
  }

  restart(uuid) {
    if (this.state !== "END") return;
    if (uuid !== this.master_player_uuid) return;

    this.state = "CONFIG";

    this.current_round = 0;
    this.current_letter = null;
    this.current_started = null;
    this.current_timeout = null;
    this.current_round_interrupted_by = null;

    this.current_round_answers_final_received = [];
    this.current_round_votes_ready = [];

    this.rounds = {};
    this.final_scores = [];

    // We remove offline players. The client will do the same on its side.
    Object.values(this.players).filter(player => !player.online).map(player => player.uuid).forEach(uuid => {
      delete this.players[uuid];
    });

    this.broadcast("game-restarted", {});
  }
}