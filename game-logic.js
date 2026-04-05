// ============================================================
// === STOCK EXCHANGE CARD GAME — SHARED GAME LOGIC ===========
// ============================================================
// Pure game functions used by the server. No DOM, no rendering.

const SUITS = {
  tech: { name: 'Tech', icon: '\u{1F4BB}', color: '#00d4ff' },
  realEstate: { name: 'Real Estate', icon: '\u{1F3E2}', color: '#ffc107' },
  energy: { name: 'Energy', icon: '\u26A1', color: '#00e676' }
};

const SUIT_KEYS = ['tech', 'realEstate', 'energy'];
const CARDS_PER_PLAYER = { 2: 6, 3: 5, 4: 4 };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck() {
  const deck = [];
  for (const suit of SUIT_KEYS) {
    for (let v = 1; v <= 15; v++) {
      if (v === 8) continue; // 8s start as pile tops
      deck.push({ suit, value: v });
    }
  }
  return deck;
}

function suitName(suit) { return SUITS[suit].name; }

function getValidPlays(hand, piles) {
  const plays = [];
  for (const card of hand) {
    const pileKey = card.suit;
    const pileValue = piles[pileKey].value;
    const points = Math.abs(pileValue - card.value);
    plays.push({ card, pileKey, points });
  }
  return plays;
}

// Initialize a new game state for the given player names
function initializeGame(playerNames) {
  const pCount = playerNames.length;
  const deck = shuffle(createDeck());
  const cardsPerPlayer = CARDS_PER_PLAYER[pCount];

  const players = playerNames.map((name, i) => {
    const hand = deck.splice(0, cardsPerPlayer);
    hand.sort((a, b) => SUIT_KEYS.indexOf(a.suit) - SUIT_KEYS.indexOf(b.suit) || a.value - b.value);
    return {
      id: i,
      name,
      hand,
      score: 0,
      scoreHistory: [],
      connected: true
    };
  });

  return {
    phase: 'playing',
    players,
    piles: {
      tech: { value: 8 },
      realEstate: { value: 8 },
      energy: { value: 8 }
    },
    drawPile: deck,
    playedCards: [],
    currentPlayerIndex: 0,
    turnPhase: 'play',
    lastPlay: null,
    gameLog: [],
    finalRound: false,
    finalRoundPlayers: new Set(),
    stockState: {
      tech:       { name: 'Tech',        value: 8, delta: null },
      realEstate: { name: 'Real Estate', value: 8, delta: null },
      energy:     { name: 'Energy',      value: 8, delta: null }
    }
  };
}

// Play a card: removes from hand, updates pile, sets lastPlay
function playCard(gs, playerIndex, card) {
  const player = gs.players[playerIndex];
  const pileKey = card.suit;
  const pileValue = gs.piles[pileKey].value;
  const points = Math.abs(pileValue - card.value);

  // Remove card from hand
  player.hand = player.hand.filter(c => !(c.suit === card.suit && c.value === card.value));

  // Update pile
  gs.piles[pileKey].value = card.value;
  gs.playedCards.push(card);

  // Store last play
  gs.lastPlay = { card, pileKey, points, oldValue: pileValue, playerName: player.name };
  gs.turnPhase = 'choose';

  // Update stock ticker state
  gs.stockState[pileKey].value = card.value;
  gs.stockState[pileKey].delta = card.value - pileValue;

  const direction = card.value > pileValue ? '\u2191' : (card.value < pileValue ? '\u2193' : '\u2194');
  gs.gameLog.push(`${player.name} played ${suitName(card.suit)} ${card.value} ${direction}`);
}

// Choose draw or score after playing a card
function chooseAction(gs, playerIndex, action) {
  const player = gs.players[playerIndex];

  if (action === 'draw') {
    if (gs.drawPile.length > 0) {
      const drawn = gs.drawPile.pop();
      player.hand.push(drawn);
      player.hand.sort((a, b) => SUIT_KEYS.indexOf(a.suit) - SUIT_KEYS.indexOf(b.suit) || a.value - b.value);
      gs.gameLog.push(`${player.name} drew a card. (${gs.drawPile.length} remaining)`);
    }
  } else if (action === 'score') {
    const pts = gs.lastPlay.points;
    player.score += pts;
    player.scoreHistory.push({
      suit: gs.lastPlay.card.suit,
      cardValue: gs.lastPlay.card.value,
      pileValue: gs.lastPlay.oldValue,
      points: pts
    });
    gs.gameLog.push(`${player.name} sold for +${pts} VP! (Total: ${player.score})`);
  }

  gs.lastPlay = null;
  gs.turnPhase = 'play';

  // Check if draw pile just emptied
  if (gs.drawPile.length === 0 && !gs.finalRound) {
    gs.finalRound = true;
    gs.gameLog.push('Draw pile empty! Final round begins.');
  }
}

// Advance to next turn: mark final round, find next player
// Returns { gameOver: boolean }
function advanceTurn(gs) {
  const player = gs.players[gs.currentPlayerIndex];

  if (player.hand.length === 0) {
    gs.gameLog.push(`${player.name} has no cards left.`);
  }

  if (gs.finalRound) {
    gs.finalRoundPlayers.add(gs.currentPlayerIndex);
  }

  if (checkGameEnd(gs)) {
    gs.phase = 'gameOver';
    return { gameOver: true };
  }

  nextPlayer(gs);
  return { gameOver: false };
}

function nextPlayer(gs) {
  const n = gs.players.length;
  let next = (gs.currentPlayerIndex + 1) % n;
  let checked = 0;

  while (checked < n) {
    const p = gs.players[next];
    if (p.hand.length === 0) {
      next = (next + 1) % n;
      checked++;
      continue;
    }
    if (gs.finalRound && gs.finalRoundPlayers.has(next)) {
      next = (next + 1) % n;
      checked++;
      continue;
    }
    break;
  }

  gs.currentPlayerIndex = next;
}

function checkGameEnd(gs) {
  if (gs.players.every(p => p.hand.length === 0)) return true;

  if (gs.finalRound) {
    const playersWithCards = gs.players.filter(p => p.hand.length > 0);
    if (playersWithCards.every(p => gs.finalRoundPlayers.has(p.id))) return true;
  }

  return false;
}

// Returns rankings sorted by score descending
function getRankings(gs) {
  return [...gs.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ name: p.name, score: p.score, rank: i + 1 }));
}

// Sanitize game state for a specific player — hides other hands
function sanitizeState(gs, forPlayerIndex) {
  return {
    piles: gs.piles,
    drawPileCount: gs.drawPile.length,
    currentPlayerIndex: gs.currentPlayerIndex,
    turnPhase: gs.turnPhase,
    lastPlay: gs.lastPlay,
    finalRound: gs.finalRound,
    gameLog: gs.gameLog.slice(-50), // last 50 entries
    stockState: gs.stockState,
    players: gs.players.map((p, i) => ({
      name: p.name,
      score: p.score,
      cardCount: p.hand.length,
      connected: p.connected !== false,
      isYou: i === forPlayerIndex
    })),
    yourHand: gs.players[forPlayerIndex].hand,
    yourIndex: forPlayerIndex
  };
}

module.exports = {
  SUITS, SUIT_KEYS, CARDS_PER_PLAYER,
  shuffle, createDeck, suitName,
  getValidPlays, initializeGame,
  playCard, chooseAction, advanceTurn,
  nextPlayer, checkGameEnd, getRankings,
  sanitizeState
};
