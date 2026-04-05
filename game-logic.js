// ============================================================
// === STOCK EXCHANGE CARD GAME — SHARED GAME LOGIC ===========
// ============================================================
// Pure game functions used by the server. No DOM, no rendering.

const VARIANT_CONFIG = {
  standard: {
    suits: {
      tech: { name: 'Tech', icon: '\u{1F4BB}', color: '#00d4ff', cssClass: 'tech' },
      realEstate: { name: 'Real Estate', icon: '\u{1F3E2}', color: '#ffc107', cssClass: 'realestate' },
      energy: { name: 'Energy', icon: '\u26A1', color: '#00e676', cssClass: 'energy' }
    },
    suitKeys: ['tech', 'realEstate', 'energy'],
    startValue: 8,
    maxValue: 15
  },
  classic: {
    suits: {
      classic: { name: 'Classic', icon: '\u{1F3AF}', color: '#8b5cf6', cssClass: 'classic' }
    },
    suitKeys: ['classic'],
    startValue: 15,
    maxValue: 30
  }
};

// Backwards compat
const SUITS = VARIANT_CONFIG.standard.suits;
const SUIT_KEYS = VARIANT_CONFIG.standard.suitKeys;
const CARDS_PER_PLAYER = { 2: 6, 3: 5, 4: 4 };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck(variant = 'standard') {
  const cfg = VARIANT_CONFIG[variant] || VARIANT_CONFIG.standard;
  const deck = [];
  for (const suit of cfg.suitKeys) {
    for (let v = 1; v <= cfg.maxValue; v++) {
      if (v === cfg.startValue) continue;
      deck.push({ suit, value: v });
    }
  }
  return deck;
}

function suitName(suit, suits) {
  const s = suits || SUITS;
  return (s[suit] || { name: suit }).name;
}

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

function initializeGame(playerNames, variant = 'standard') {
  const cfg = VARIANT_CONFIG[variant] || VARIANT_CONFIG.standard;
  const pCount = playerNames.length;
  const deck = shuffle(createDeck(variant));
  const cardsPerPlayer = CARDS_PER_PLAYER[pCount];

  const players = playerNames.map((name, i) => {
    const hand = deck.splice(0, cardsPerPlayer);
    hand.sort((a, b) => cfg.suitKeys.indexOf(a.suit) - cfg.suitKeys.indexOf(b.suit) || a.value - b.value);
    return { id: i, name, hand, score: 0, scoreHistory: [], connected: true };
  });

  const piles = {};
  const stockState = {};
  for (const key of cfg.suitKeys) {
    piles[key] = { value: cfg.startValue };
    stockState[key] = { name: cfg.suits[key].name, value: cfg.startValue, delta: null };
  }

  return {
    phase: 'playing',
    variant,
    suitKeys: cfg.suitKeys,
    suits: cfg.suits,
    players,
    piles,
    drawPile: deck,
    playedCards: [],
    currentPlayerIndex: 0,
    turnPhase: 'play',
    lastPlay: null,
    lastScore: null,
    lastActionText: null,
    gameLog: [],
    finalRound: false,
    finalRoundPlayers: new Set(),
    stockState
  };
}

function playCard(gs, playerIndex, card) {
  const player = gs.players[playerIndex];
  const pileKey = card.suit;
  const pileValue = gs.piles[pileKey].value;
  const points = Math.abs(pileValue - card.value);

  player.hand = player.hand.filter(c => !(c.suit === card.suit && c.value === card.value));
  gs.piles[pileKey].value = card.value;
  gs.playedCards.push(card);
  gs.lastScore = null; // clear previous score popup

  gs.lastPlay = { card, pileKey, points, oldValue: pileValue, playerName: player.name };
  gs.turnPhase = 'choose';

  gs.stockState[pileKey].value = card.value;
  gs.stockState[pileKey].delta = card.value - pileValue;

  const direction = card.value > pileValue ? '\u2191' : (card.value < pileValue ? '\u2193' : '\u2194');
  const sName = suitName(card.suit, gs.suits);
  const logMsg = `${player.name} played ${sName} ${card.value} ${direction}`;
  gs.gameLog.push(logMsg);
  gs.lastActionText = logMsg;
}

function chooseAction(gs, playerIndex, action) {
  const player = gs.players[playerIndex];

  if (action === 'draw') {
    if (gs.drawPile.length > 0) {
      const drawn = gs.drawPile.pop();
      player.hand.push(drawn);
      player.hand.sort((a, b) => gs.suitKeys.indexOf(a.suit) - gs.suitKeys.indexOf(b.suit) || a.value - b.value);
      const logMsg = `${player.name} drew a card. (${gs.drawPile.length} remaining)`;
      gs.gameLog.push(logMsg);
      gs.lastActionText = logMsg;
    }
    gs.lastScore = null;
  } else if (action === 'score') {
    const pts = gs.lastPlay.points;
    player.score += pts;
    player.scoreHistory.push({
      suit: gs.lastPlay.card.suit,
      cardValue: gs.lastPlay.card.value,
      pileValue: gs.lastPlay.oldValue,
      points: pts
    });
    const logMsg = `${player.name} sold for +${pts} VP! (Total: ${player.score})`;
    gs.gameLog.push(logMsg);
    gs.lastActionText = logMsg;
    gs.lastScore = { points: pts, suit: gs.lastPlay.card.suit };
  }

  gs.lastPlay = null;
  gs.turnPhase = 'play';

  if (gs.drawPile.length === 0 && !gs.finalRound) {
    gs.finalRound = true;
    gs.gameLog.push('Draw pile empty! Final round begins.');
  }
}

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
    if (p.hand.length === 0) { next = (next + 1) % n; checked++; continue; }
    if (gs.finalRound && gs.finalRoundPlayers.has(next)) { next = (next + 1) % n; checked++; continue; }
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

function getRankings(gs) {
  return [...gs.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ name: p.name, score: p.score, rank: i + 1 }));
}

function sanitizeState(gs, forPlayerIndex) {
  return {
    variant: gs.variant || 'standard',
    suitKeys: gs.suitKeys,
    suits: gs.suits,
    piles: gs.piles,
    drawPileCount: gs.drawPile.length,
    currentPlayerIndex: gs.currentPlayerIndex,
    turnPhase: gs.turnPhase,
    lastPlay: gs.lastPlay,
    lastScore: gs.lastScore || null,
    lastActionText: gs.lastActionText || null,
    finalRound: gs.finalRound,
    gameLog: gs.gameLog.slice(-50),
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
  VARIANT_CONFIG, SUITS, SUIT_KEYS, CARDS_PER_PLAYER,
  shuffle, createDeck, suitName,
  getValidPlays, initializeGame,
  playCard, chooseAction, advanceTurn,
  nextPlayer, checkGameEnd, getRankings,
  sanitizeState
};
