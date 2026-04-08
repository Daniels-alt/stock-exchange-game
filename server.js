// ============================================================
// === STOCK EXCHANGE CARD GAME — MULTIPLAYER SERVER ===========
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const GL = require('./game-logic');

const PORT = process.env.PORT || 3000;

// ============================================================
// === IN-MEMORY STATE ========================================
// ============================================================

const rooms = new Map();   // roomId -> Room
const clients = new Map(); // WebSocket -> ClientInfo

// Room: { id, hostName, maxPlayers, players[], state, gameState, disconnectTimers }
// players[i]: { ws, name, connected, playerId }
// ClientInfo: { roomId, playerId, name }

// ============================================================
// === HTTP SERVER (serve index.html) =========================
// ============================================================

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    // Serve static files from project directory
    filePath = path.join(__dirname, req.url);
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ============================================================
// === WEBSOCKET SERVER =======================================
// ============================================================

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.set(ws, { roomId: null, playerId: null, name: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    handleDisconnect(ws);
    clients.delete(ws);
  });
});

// ============================================================
// === MESSAGE HANDLER ========================================
// ============================================================

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create':     return handleCreate(ws, msg);
    case 'join':       return handleJoin(ws, msg);
    case 'list':       return handleList(ws);
    case 'play_card':  return handlePlayCard(ws, msg);
    case 'choose_action': return handleChooseAction(ws, msg);
    case 'leave':      return handleLeave(ws);
    case 'reconnect':  return handleReconnect(ws, msg);
  }
}

// ============================================================
// === ROOM MANAGEMENT ========================================
// ============================================================

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for clarity
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

function handleCreate(ws, msg) {
  const name = (msg.name || '').trim().substring(0, 20) || 'Player';
  const maxPlayers = [2, 3, 4].includes(msg.maxPlayers) ? msg.maxPlayers : 2;
  const variant = ['standard', 'classic'].includes(msg.variant) ? msg.variant : 'standard';
  const validProfiles = ['rookie', 'daytrader', 'tactician', 'strategist', 'expert'];
  const aiSlots = Array.isArray(msg.aiSlots)
    ? msg.aiSlots.slice(0, maxPlayers - 1).map(s => ({
        profile: validProfiles.includes(s.profile) ? s.profile : 'rookie',
        name: GL.AI_PROFILE_NAMES[s.profile] || 'AI'
      }))
    : [];
  const humanSlots = maxPlayers - aiSlots.length; // at least 1 (the creator)

  // Leave current room if in one
  leaveCurrentRoom(ws);

  const roomId = generateRoomId();
  const room = {
    id: roomId,
    hostName: name,
    maxPlayers,
    humanSlots,
    aiSlots,
    variant,
    players: [{ ws, name, connected: true, playerId: 0 }],
    state: 'waiting',
    gameState: null,
    disconnectTimers: new Map()
  };

  rooms.set(roomId, room);
  clients.set(ws, { roomId, playerId: 0, name });

  // Build initial player list including AI slots
  const initialPlayers = [
    { name, connected: true, isAI: false },
    ...aiSlots.map(s => ({ name: s.name, connected: true, isAI: true, aiProfile: s.profile }))
  ];
  send(ws, {
    type: 'room_created',
    roomId,
    you: 0,
    players: initialPlayers,
    maxPlayers,
    humanSlots,
    aiSlots,
    variant
  });

  console.log(`[Room ${roomId}] Created by ${name} (max ${maxPlayers})`);

  // If all slots are AI (humanSlots === 1 = just the creator), start immediately
  if (humanSlots === 1) {
    startOnlineGame(room);
  }
}

function handleJoin(ws, msg) {
  const name = (msg.name || '').trim().substring(0, 20) || 'Player';
  const roomId = (msg.roomId || '').toUpperCase().trim();

  const room = rooms.get(roomId);
  if (!room) return sendError(ws, 'Room not found');
  if (room.state !== 'waiting') return sendError(ws, 'Game already in progress');
  if (room.players.length >= (room.humanSlots || room.maxPlayers)) return sendError(ws, 'Room is full');

  // Leave current room if in one
  leaveCurrentRoom(ws);

  const playerId = room.players.length;
  room.players.push({ ws, name, connected: true, playerId });
  clients.set(ws, { roomId, playerId, name });

  const playerList = room.players.map(p => ({ name: p.name, connected: p.connected }));

  // Notify the new player
  send(ws, {
    type: 'room_joined',
    roomId,
    you: playerId,
    players: playerList,
    maxPlayers: room.maxPlayers
  });

  // Notify existing players
  room.players.forEach((p, i) => {
    if (i !== playerId && p.ws && p.connected) {
      send(p.ws, { type: 'player_joined', name, playerIndex: playerId, players: playerList });
    }
  });

  console.log(`[Room ${roomId}] ${name} joined (${room.players.length}/${room.maxPlayers})`);

  // Auto-start when all human slots are filled
  if (room.players.length === (room.humanSlots || room.maxPlayers)) {
    startOnlineGame(room);
  }
}

function handleList(ws) {
  const openRooms = [];
  for (const [id, room] of rooms) {
    if (room.state === 'waiting' && room.players.length < room.maxPlayers) {
      openRooms.push({
        id,
        hostName: room.hostName,
        playerCount: room.players.length,
        maxPlayers: room.humanSlots || room.maxPlayers,
        variant: room.variant || 'standard'
      });
    }
  }
  send(ws, { type: 'room_list', rooms: openRooms });
}

function handleLeave(ws) {
  leaveCurrentRoom(ws);
}

function leaveCurrentRoom(ws) {
  const client = clients.get(ws);
  if (!client || !client.roomId) return;

  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    client.playerId = null;
    return;
  }

  if (room.state === 'waiting') {
    // Cancel any pending disconnect timer for this player
    const existingTimer = room.disconnectTimers.get(client.playerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      room.disconnectTimers.delete(client.playerId);
    }

    // Remove player immediately (intentional leave)
    room.players = room.players.filter(p => p.ws !== ws && p.name !== client.name);
    // Re-index remaining players
    room.players.forEach((p, i) => {
      p.playerId = i;
      const c = clients.get(p.ws);
      if (c) c.playerId = i;
    });

    if (room.players.length === 0) {
      rooms.delete(client.roomId);
      console.log(`[Room ${client.roomId}] Deleted (empty)`);
    } else {
      // Update host if needed
      room.hostName = room.players[0].name;
      const playerList = room.players.map(p => ({ name: p.name, connected: p.connected }));
      broadcastToRoom(room, {
        type: 'player_left',
        name: client.name,
        playerIndex: client.playerId,
        players: playerList
      });
    }
  }
  // If game is playing, mark as disconnected (handled by handleDisconnect)

  client.roomId = null;
  client.playerId = null;
}

// ============================================================
// === GAME START =============================================
// ============================================================

function startOnlineGame(room) {
  // Combine human and AI player names
  const humanNames = room.players.map(p => p.name);
  const aiNames = (room.aiSlots || []).map(s => s.name);
  const playerNames = [...humanNames, ...aiNames];

  room.gameState = GL.initializeGame(playerNames, room.variant || 'standard');
  room.state = 'playing';

  // Mark AI players in game state
  (room.aiSlots || []).forEach((slot, i) => {
    const idx = humanNames.length + i;
    room.gameState.players[idx].isAI = true;
    room.gameState.players[idx].aiProfile = slot.profile;
  });

  room.gameState.gameLog.push('Market opens! Trading has begun.');
  console.log(`[Room ${room.id}] Game started! (${playerNames.join(', ')})`);

  broadcastState(room);
  sendYourTurn(room);
  triggerAITurns(room);
}

function triggerAITurns(room) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;

  const currentPlayer = gs.players[gs.currentPlayerIndex];
  if (!currentPlayer || !currentPlayer.isAI) return;

  const delay = 900 + Math.random() * 600;
  setTimeout(() => {
    if (!room.gameState || room.gameState.phase !== 'playing') return;

    const { chosenPlay, willScore } = GL.aiChoosePlay(gs, gs.currentPlayerIndex);
    if (!chosenPlay) return;

    GL.playCard(gs, gs.currentPlayerIndex, chosenPlay.card);

    GL.chooseAction(gs, gs.currentPlayerIndex, willScore ? 'score' : 'draw');

    const { gameOver } = GL.advanceTurn(gs);

    if (gameOver) {
      room.state = 'finished';
      broadcastState(room);
      broadcastToRoom(room, { type: 'game_over', rankings: GL.getRankings(gs) });
      console.log(`[Room ${room.id}] Game over! Winner: ${GL.getRankings(gs)[0].name}`);
      setTimeout(() => {
        if (rooms.has(room.id) && room.state === 'finished') {
          rooms.delete(room.id);
          console.log(`[Room ${room.id}] Cleaned up`);
        }
      }, 5 * 60 * 1000);
    } else {
      broadcastState(room);
      sendYourTurn(room);
      triggerAITurns(room); // chain to next AI if needed
    }
  }, delay);
}

// ============================================================
// === GAME ACTIONS ===========================================
// ============================================================

function handlePlayCard(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.roomId) return sendError(ws, 'Not in a room');

  const room = rooms.get(client.roomId);
  if (!room || room.state !== 'playing') return sendError(ws, 'No active game');

  const gs = room.gameState;
  if (gs.currentPlayerIndex !== client.playerId) return sendError(ws, 'Not your turn');
  if (gs.turnPhase !== 'play') return sendError(ws, 'Wrong phase — choose draw or score first');

  const player = gs.players[client.playerId];
  const cardIndex = player.hand.findIndex(c => c.suit === msg.suit && c.value === msg.value);
  if (cardIndex === -1) return sendError(ws, 'Card not in your hand');

  const card = player.hand[cardIndex];

  // Execute
  GL.playCard(gs, client.playerId, card);
  broadcastState(room);
  sendYourTurn(room); // same player, now in 'choose' phase
  triggerAITurns(room); // No-op if current player is human (choose phase)
}

function handleChooseAction(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.roomId) return sendError(ws, 'Not in a room');

  const room = rooms.get(client.roomId);
  if (!room || room.state !== 'playing') return sendError(ws, 'No active game');

  const gs = room.gameState;
  if (gs.currentPlayerIndex !== client.playerId) return sendError(ws, 'Not your turn');
  if (gs.turnPhase !== 'choose') return sendError(ws, 'Play a card first');
  if (msg.action !== 'draw' && msg.action !== 'score') return sendError(ws, 'Invalid action');

  // endgame forces sell (chooseAction handles this internally too, belt-and-suspenders)
  const action = gs.endgame ? 'score' : msg.action;

  GL.chooseAction(gs, client.playerId, action);
  const { gameOver } = GL.advanceTurn(gs);

  if (gameOver) {
    const rankings = GL.getRankings(gs);
    room.state = 'finished';
    broadcastToRoom(room, { type: 'game_over', rankings });
    console.log(`[Room ${room.id}] Game over! Winner: ${rankings[0].name} (${rankings[0].score} VP)`);
    // Clean up room after 5 minutes
    setTimeout(() => {
      if (rooms.has(room.id) && room.state === 'finished') {
        rooms.delete(room.id);
        console.log(`[Room ${room.id}] Cleaned up`);
      }
    }, 5 * 60 * 1000);
    return;
  }

  broadcastState(room);
  sendYourTurn(room);
  triggerAITurns(room);
}

// ============================================================
// === DISCONNECT HANDLING ====================================
// ============================================================

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client || !client.roomId) return;

  const room = rooms.get(client.roomId);
  if (!room) return;

  const player = room.players[client.playerId];
  if (!player) return;

  player.connected = false;
  player.ws = null;

  console.log(`[Room ${room.id}] ${player.name} disconnected`);

  // Notify other players in the room
  broadcastToRoom(room, {
    type: 'player_disconnected',
    name: player.name,
    playerIndex: client.playerId
  });

  // 60-second grace period for reconnection (both waiting and playing states)
  const timer = setTimeout(() => {
    room.disconnectTimers.delete(client.playerId);

    if (room.state === 'waiting') {
      // Remove the disconnected player from the waiting room
      room.players = room.players.filter(p => p !== player);
      // Re-index remaining players
      room.players.forEach((p, i) => {
        p.playerId = i;
        const c = clients.get(p.ws);
        if (c) c.playerId = i;
      });
      if (room.players.length === 0) {
        rooms.delete(room.id);
        console.log(`[Room ${room.id}] Deleted (all players timed out)`);
      } else {
        room.hostName = room.players[0].name;
        const playerList = room.players.map(p => ({ name: p.name, connected: p.connected }));
        broadcastToRoom(room, {
          type: 'player_left',
          name: player.name,
          playerIndex: client.playerId,
          players: playerList
        });
        console.log(`[Room ${room.id}] ${player.name} removed after grace period (${room.players.length} remaining)`);
      }
    } else {
      // In-game: replace with a simple bot
      player.isBot = true;
      const gs = room.gameState;
      gs.gameLog.push(`${player.name} was replaced by an AI (disconnected).`);
      broadcastState(room);
      if (gs.currentPlayerIndex === client.playerId && gs.phase === 'playing') {
        makeAIMove(room, client.playerId);
      }
    }
  }, 60 * 1000);

  room.disconnectTimers.set(client.playerId, timer);
}

function handleReconnect(ws, msg) {
  const name = (msg.name || '').trim();
  const roomId = (msg.roomId || '').toUpperCase().trim();

  const room = rooms.get(roomId);
  if (!room) return sendError(ws, 'Room not found');

  // Find the disconnected player slot matching name
  const playerIndex = room.players.findIndex(p => p.name === name && !p.connected);
  if (playerIndex === -1) return sendError(ws, 'No matching disconnected player');

  // Clear disconnect timer
  const timer = room.disconnectTimers.get(playerIndex);
  if (timer) {
    clearTimeout(timer);
    room.disconnectTimers.delete(playerIndex);
  }

  // Reattach
  const player = room.players[playerIndex];
  player.ws = ws;
  player.connected = true;
  player.isBot = false;
  clients.set(ws, { roomId, playerId: playerIndex, name });

  console.log(`[Room ${roomId}] ${name} reconnected`);

  // Notify others
  broadcastToRoom(room, {
    type: 'player_reconnected',
    name: player.name,
    playerIndex
  });

  // Restore state for reconnected player
  if (room.state === 'waiting') {
    const playerList = room.players.map(p => ({ name: p.name, connected: p.connected }));
    send(ws, {
      type: 'room_joined',
      roomId: room.id,
      you: playerIndex,
      players: playerList,
      maxPlayers: room.maxPlayers
    });
  } else if (room.state === 'playing') {
    const gs = room.gameState;
    send(ws, { type: 'game_state', state: GL.sanitizeState(gs, playerIndex) });
    if (gs.currentPlayerIndex === playerIndex) {
      const plays = GL.getValidPlays(gs.players[playerIndex].hand, gs.piles);
      send(ws, {
        type: 'your_turn',
        turnPhase: gs.turnPhase,
        validPlays: plays.map(p => ({ suit: p.card.suit, value: p.card.value, pileKey: p.pileKey, points: p.points }))
      });
    }
  } else if (room.state === 'finished') {
    send(ws, { type: 'game_over', rankings: GL.getRankings(room.gameState) });
  }
}

// ============================================================
// === AI FALLBACK (for disconnected players) ==================
// ============================================================

function makeAIMove(room, playerIndex) {
  const gs = room.gameState;
  if (gs.phase !== 'playing') return;
  if (gs.currentPlayerIndex !== playerIndex) return;

  const player = gs.players[playerIndex];
  if (player.hand.length === 0) {
    const { gameOver } = GL.advanceTurn(gs);
    if (gameOver) {
      room.state = 'finished';
      broadcastToRoom(room, { type: 'game_over', rankings: GL.getRankings(gs) });
      return;
    }
    broadcastState(room);
    checkAndRunAI(room);
    return;
  }

  if (gs.turnPhase === 'play') {
    // Random play
    const plays = GL.getValidPlays(player.hand, gs.piles);
    const chosen = plays[Math.floor(Math.random() * plays.length)];

    setTimeout(() => {
      GL.playCard(gs, playerIndex, chosen.card);
      broadcastState(room);

      // Auto choose: 50% score, 50% draw
      setTimeout(() => {
        const action = Math.random() < 0.5 ? 'score' : 'draw';
        GL.chooseAction(gs, playerIndex, action);
        const { gameOver } = GL.advanceTurn(gs);

        if (gameOver) {
          room.state = 'finished';
          broadcastToRoom(room, { type: 'game_over', rankings: GL.getRankings(gs) });
          return;
        }

        broadcastState(room);
        sendYourTurn(room);
        checkAndRunAI(room);
      }, 800);
    }, 1000);
  }
}

function checkAndRunAI(room) {
  const gs = room.gameState;
  if (gs.phase !== 'playing') return;
  const currentPlayer = room.players[gs.currentPlayerIndex];
  if (currentPlayer && currentPlayer.isBot) {
    makeAIMove(room, gs.currentPlayerIndex);
  }
}

// ============================================================
// === BROADCAST HELPERS ======================================
// ============================================================

function send(ws, msg) {
  if (ws && ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function broadcastToRoom(room, msg) {
  room.players.forEach(p => {
    if (p.ws && p.connected) send(p.ws, msg);
  });
}

function broadcastState(room) {
  const gs = room.gameState;
  room.players.forEach((p, i) => {
    if (p.ws && p.connected) {
      send(p.ws, { type: 'game_state', state: GL.sanitizeState(gs, i) });
    }
  });
}

function sendYourTurn(room) {
  const gs = room.gameState;
  const idx = gs.currentPlayerIndex;
  const player = room.players[idx];
  if (!player || !player.ws || !player.connected) return;

  const plays = GL.getValidPlays(gs.players[idx].hand, gs.piles);
  send(player.ws, {
    type: 'your_turn',
    turnPhase: gs.turnPhase,
    validPlays: plays.map(p => ({
      suit: p.card.suit,
      value: p.card.value,
      pileKey: p.pileKey,
      points: p.points
    }))
  });
}

// ============================================================
// === START ==================================================
// ============================================================

server.listen(PORT, () => {
  console.log(`\n  Stock Exchange Card Game Server`);
  console.log(`  ================================`);
  console.log(`  HTTP:      http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  Ready for players!\n`);
});
