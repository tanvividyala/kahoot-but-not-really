const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/OverusedGrotesk-VF.woff2', (_, res) => res.sendFile(path.join(__dirname, 'OverusedGrotesk-VF.woff2')));
app.get('/play', (_, res) => res.sendFile(path.join(__dirname, 'public/play.html')));
app.get('/host', (_, res) => res.sendFile(path.join(__dirname, 'public/host.html')));

const questions = require('./questions.json');
const games = new Map(); // code → game state

function generateCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (games.has(code));
  return code;
}

function getLeaderboard(game) {
  return [...game.players.values()]
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function showQuestion(game) {
  if (game.questionTimer) clearTimeout(game.questionTimer);
  game.phase = 'question';
  game.questionStartTime = Date.now();

  const q = questions[game.currentQuestion];
  const payload = {
    index: game.currentQuestion,
    total: questions.length,
    question: q.question,
    type: q.type,
    options: q.options,
    timeLimit: q.timeLimit || 60,
    image: q.image || null,
  };

  io.to(`host-${game.code}`).emit('question:show', payload);
  io.to(`players-${game.code}`).emit('question:show', payload);

  game.questionTimer = setTimeout(() => {
    if (game.phase === 'question') showResults(game);
  }, (q.timeLimit || 60) * 1000);
}

function showResults(game) {
  if (game.questionTimer) clearTimeout(game.questionTimer);
  game.phase = 'results';

  const q = questions[game.currentQuestion];

  // Build answer tally
  const tally = {};
  q.options.forEach((_, i) => { tally[i] = 0; });

  game.players.forEach(player => {
    const ans = player.answers[game.currentQuestion];
    if (ans === undefined) return;
    const arr = Array.isArray(ans.answer) ? ans.answer : [ans.answer];
    arr.forEach(a => { if (tally[a] !== undefined) tally[a]++; });
  });

  const leaderboard = getLeaderboard(game);
  const correctCount = [...game.players.values()].filter(p => {
    const a = p.answers[game.currentQuestion];
    return a && a.correct;
  }).length;

  const base = {
    correctAnswer: q.correct,
    tally,
    correctCount,
    totalAnswered: [...game.players.values()].filter(p => p.answers[game.currentQuestion] !== undefined).length,
    leaderboard: leaderboard.slice(0, 5),
  };

  io.to(`host-${game.code}`).emit('results:show', { ...base, explanation: q.explanation || '' });

  game.players.forEach((player, socketId) => {
    const ans = player.answers[game.currentQuestion];
    const rank = leaderboard.findIndex(p => p.name === player.name) + 1;
    io.to(socketId).emit('results:show', {
      ...base,
      playerResult: ans ? { correct: ans.correct, points: ans.points } : { correct: false, points: 0 },
      score: player.score,
      rank,
    });
  });
}

function endGame(game) {
  if (game.questionTimer) clearTimeout(game.questionTimer);
  game.phase = 'end';
  const leaderboard = getLeaderboard(game);
  io.to(`host-${game.code}`).emit('game:end', { leaderboard });
  io.to(`players-${game.code}`).emit('game:end', { leaderboard });
  setTimeout(() => games.delete(game.code), 2 * 60 * 60 * 1000);
}

io.on('connection', socket => {

  socket.on('host:create', cb => {
    const code = generateCode();
    const game = {
      code,
      hostId: socket.id,
      players: new Map(),
      phase: 'lobby',
      currentQuestion: -1,
      questionTimer: null,
      questionStartTime: null,
    };
    games.set(code, game);
    socket.join(`host-${code}`);
    cb({ code });
  });

  socket.on('player:join', ({ code, name }, cb) => {
    const game = games.get(code);
    if (!game) return cb({ error: 'Game not found. Check your code!' });
    if (game.phase !== 'lobby') return cb({ error: 'This game has already started.' });
    if (!name || name.trim().length < 1) return cb({ error: 'Please enter a nickname.' });
    if (name.trim().length > 20) return cb({ error: 'Nickname too long (max 20 chars).' });

    const trimmed = name.trim();
    const nameTaken = [...game.players.values()].some(p => p.name.toLowerCase() === trimmed.toLowerCase());
    if (nameTaken) return cb({ error: 'That nickname is already taken!' });

    game.players.set(socket.id, { name: trimmed, score: 0, answers: {} });
    socket.join(`players-${code}`);
    socket.data.gameCode = code;

    io.to(`host-${code}`).emit('player:joined', {
      name: trimmed,
      count: game.players.size,
    });

    cb({ success: true });
  });

  socket.on('host:start', ({ code }) => {
    const game = games.get(code);
    if (!game || game.hostId !== socket.id) return;
    if (game.players.size === 0) return;
    game.currentQuestion = 0;
    showQuestion(game);
  });

  socket.on('host:next', ({ code }) => {
    const game = games.get(code);
    if (!game || game.hostId !== socket.id) return;

    if (game.phase === 'question') {
      showResults(game);
    } else if (game.phase === 'results') {
      game.currentQuestion++;
      if (game.currentQuestion >= questions.length) {
        endGame(game);
      } else {
        showQuestion(game);
      }
    }
  });

  socket.on('player:answer', ({ code, answer }) => {
    const game = games.get(code);
    if (!game || game.phase !== 'question') return;

    const player = game.players.get(socket.id);
    if (!player) return;
    if (player.answers[game.currentQuestion] !== undefined) return; // already answered

    const q = questions[game.currentQuestion];
    const timeElapsed = Date.now() - game.questionStartTime;
    const timeLimit = (q.timeLimit || 60) * 1000;

    let correct = false;
    if (q.type === 'multiple') {
      const correctSet = new Set(q.correct);
      const answerSet = new Set(answer);
      correct = correctSet.size === answerSet.size && [...correctSet].every(a => answerSet.has(a));
    } else {
      correct = answer === q.correct;
    }

    let points = 0;
    if (correct) {
      points = Math.round(500 + 500 * Math.max(0, 1 - timeElapsed / timeLimit));
      player.score += points;
    }

    player.answers[game.currentQuestion] = { answer, correct, points };

    socket.emit('answer:received');

    const answered = [...game.players.values()].filter(p => p.answers[game.currentQuestion] !== undefined).length;
    io.to(`host-${code}`).emit('answer:count', { count: answered, total: game.players.size });

    // Auto-show results once everyone has answered
    if (answered === game.players.size) {
      showResults(game);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.gameCode;
    if (!code) return;

    const game = games.get(code);
    if (!game) return;

    if (game.hostId === socket.id) {
      io.to(`players-${code}`).emit('game:host_left');
      games.delete(code);
      return;
    }

    const player = game.players.get(socket.id);
    if (player) {
      game.players.delete(socket.id);
      io.to(`host-${code}`).emit('player:left', { name: player.name, count: game.players.size });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Kahoot (but not really) is running!`);
  console.log(`   Host:   http://localhost:${PORT}/host`);
  console.log(`   Players: http://localhost:${PORT}\n`);
});
