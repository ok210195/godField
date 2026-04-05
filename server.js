const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const fs       = require('fs');
const path     = require('path');
const sqlite3  = require('sqlite3').verbose();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH  = path.join(__dirname, 'cards.db');
const CSV_PATH = path.join(__dirname, 'cards.csv');

// 起動時にDBを削除して毎回CSVから作り直す（古いスキーマの混入を防ぐ）
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('古いDBを削除しました');
}

const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('DB接続エラー:', err); process.exit(1); }
  console.log('DB接続OK（新規作成）');
});

const TYPE_MAP = { '\u6b66\u5668':'weapon', '\u9632\u5177':'armor', '\u5947\u8de9':'miracle' };
const ATTR_MAP = {
  '\u7121\u5c5e\u6027':'none', '\u706b':'fire', '\u6c34':'water', '\u6728':'wood',
  '\u5149':'light', '\u95c7':'dark', '\u708e':'fire', '\u6c37':'water',
};

let CARDS = [];

db.serialize(() => {
  db.run(
    'CREATE TABLE IF NOT EXISTS cards (' +
    '  id INTEGER PRIMARY KEY, icon TEXT NOT NULL DEFAULT "",' +
    '  name TEXT NOT NULL, type TEXT NOT NULL,' +
    '  attribute TEXT NOT NULL DEFAULT "none",' +
    '  power INTEGER NOT NULL DEFAULT 0, is_plus_atk INTEGER NOT NULL DEFAULT 0,' +
    '  defense INTEGER NOT NULL DEFAULT 0, ability TEXT NOT NULL DEFAULT "",' +
    '  gift_rate INTEGER NOT NULL DEFAULT 1, price INTEGER NOT NULL DEFAULT 0)',
    err => { if (err) console.error('CREATE TABLE:', err); }
  );
  if (!fs.existsSync(CSV_PATH)) { console.error('cards.csv が見つかりません'); return; }

  const lines = fs.readFileSync(CSV_PATH, 'utf-8')
    .split('\n').slice(1)
    .map(l => l.replace(/\r/g, '').trim())
    .filter(l => l.length > 0);

  db.run('DELETE FROM cards', [], err => {
    if (err) { console.error('DELETE ERROR:', err); return; }
    const stmt = db.prepare(
      'INSERT INTO cards (id,icon,name,type,attribute,power,is_plus_atk,defense,ability,gift_rate,price) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    let count = 0;
    lines.forEach(line => {
      const p = line.split(',');
      if (p.length < 6 || !p[2]) return;
      const isPlusAtk = (p[5]||'').trim().startsWith('+') ? 1 : 0;
      const power   = Number((p[5]||'0').replace('+','').trim()) || 0;
      const defense = Number((p[6]||'0').trim()) || 0;
      const price   = Number((p[9]||'0').trim()) || 0;
      const gifRate = Number((p[8]||'1').trim()) || 1;
      // iconはファイル名のみ抽出（フルパスが入っていても basename だけ使う）
      const iconRaw = (p[1]||'').trim();
      const iconFile = iconRaw.replace(/\\/g, '/').split('/').pop();
      stmt.run(Number(p[0].trim()), iconFile, p[2].trim(),
        TYPE_MAP[p[3].trim()]||'weapon', ATTR_MAP[p[4].trim()]||'none',
        power, isPlusAtk, defense, (p[7]||'').trim(), gifRate, price);
      count++;
    });
    stmt.finalize(err => {
      if (err) { console.error('INSERT ERROR:', err); return; }
      console.log('CSV→DB ' + count + '件完了');
      db.all('SELECT * FROM cards ORDER BY id', [], (err, rows) => {
        if (err) return;
        // 種類ごとにtypeIndexを付与
        const typeCount = {};
        CARDS = rows.map(r => {
          const t = r.type || 'weapon';
          typeCount[t] = (typeCount[t] || 0) + 1;
          return {
            id:r.id, icon:r.icon, name:r.name, type:t, attribute:r.attribute,
            power:r.power, isPlusAtk:r.is_plus_atk===1,
            defense:r.defense, ability:r.ability, giftRate:r.gift_rate, price:r.price,
            typeIndex: typeCount[t],
          };
        });
        console.log('カード読込: ' + CARDS.length + '枚');
        // 最初の3枚のiconを表示して確認
        CARDS.slice(0,3).forEach(c => console.log('  例) ['+c.id+'] '+c.name+' icon:"'+c.icon+'"'));
      });
    });
  });
});

// ── ランダムN枚取得（重み付き・重複IDなし）──────────────────────
function getRandomCards(n) {
  const pool = [];
  CARDS.forEach(c => { for (let i = 0; i < c.giftRate; i++) pool.push(c); });
  const shuffled = pool.sort(() => Math.random() - 0.5);
  const seen = new Set(), picked = [];
  for (const c of shuffled) {
    if (!seen.has(c.id)) { seen.add(c.id); picked.push(c); }
    if (picked.length >= n) break;
  }
  if (picked.length < n) {
    CARDS.filter(c => !seen.has(c.id)).sort(() => Math.random() - 0.5)
      .slice(0, n - picked.length).forEach(c => picked.push(c));
  }
  return picked.slice(0, n).map((c, i) => ({
    ...c, uid: Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2)
  }));
}

// ── 1枚ドロー（カード使用後に補充）──────────────────────────────
// 重み付きランダム。同じカードが複数来てもOK（本物と同様）
function drawOne(sess, who) {
  if (CARDS.length === 0) return null;
  const pool = [];
  CARDS.forEach(c => { for (let i = 0; i < c.giftRate; i++) pool.push(c); });
  const base = pool[Math.floor(Math.random() * pool.length)];
  const card = { ...base, uid: Date.now() + '-d-' + Math.random().toString(36).slice(2) };
  const target = who === 'player' ? sess.player : sess.cpu;
  target.hand.push(card);
  return card;
}

// ── 元素相性 ──────────────────────────────────────────────────
const ELEM = {
  fire:{fire:1.0,water:0.5,wood:1.5,light:1.0,dark:1.0,none:1.0},
  water:{fire:1.5,water:1.0,wood:0.5,light:1.0,dark:1.0,none:1.0},
  wood:{fire:0.5,water:1.5,wood:1.0,light:1.0,dark:1.0,none:1.0},
  light:{fire:1.0,water:1.0,wood:1.0,light:1.0,dark:2.0,none:1.0},
  dark:{fire:1.0,water:1.0,wood:1.0,light:2.0,dark:1.0,none:1.0},
  none:{fire:1.0,water:1.0,wood:1.0,light:1.0,dark:1.0,none:1.0},
};
function elemBonus(a, d) { return ((ELEM[a]||ELEM.none)[d]) || 1.0; }

// ── CPU AI ────────────────────────────────────────────────────
function cpuDecide(cpu) {
  const weapons  = cpu.hand.filter(c => c.type === 'weapon');
  const miracles = cpu.hand.filter(c => c.type === 'miracle');
  if (cpu.hp <= 15) {
    const heal = miracles.find(c => c.power === 0 || c.attribute === 'light');
    if (heal) return { action:'miracle', card:heal, plusCards:[] };
  }
  if (weapons.length) {
    const normals  = weapons.filter(c => !c.isPlusAtk);
    const base     = normals.length
      ? [...normals].sort((a,b) => b.power-a.power)[0]
      : [...weapons].sort((a,b) => b.power-a.power)[0];
    const plusCards = weapons.filter(c => c.isPlusAtk);
    return { action:'attack', card:base, plusCards };
  }
  if (miracles.length) return { action:'miracle', card:miracles[0], plusCards:[] };
  return { action:'pass', plusCards:[] };
}
function cpuPickDefense(cpu) {
  const armors = cpu.hand.filter(c => c.type === 'armor');
  if (!armors.length) return null;
  return [...armors].sort((a,b) => (b.defense||b.power)-(a.defense||a.power))[0];
}

// ── ログ・スナップ ────────────────────────────────────────────
function addLog(sess, msg) { sess.log.unshift(msg); if (sess.log.length > 35) sess.log.pop(); }

// ★ 常にhand配列を含めて返す
function playerSnap(p) {
  return { name:p.name, hp:p.hp, mp:p.mp, money:p.money, hand:p.hand, handCount:p.hand.length };
}
function cpuSnap(c) {
  return { name:c.name, hp:c.hp, mp:c.mp, money:c.money, handCount:c.hand.length };
}

const sessions = {};

// ════════════════════════════════════════════════════════════
// Socket.IO
// ════════════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log('接続:', socket.id);

  socket.on('game-start', ({ playerName, cpuName }) => {
    if (CARDS.length === 0) { socket.emit('warn','カードがまだ読み込まれていません'); return; }
    const all = getRandomCards(18);
    const first = Math.random() < 0.5 ? 'player' : 'cpu';
    const sess = {
      player: { name:playerName||'あなた', hp:40, mp:10, money:20, hand:all.slice(0,9) },
      cpu:    { name:cpuName||'CPU',       hp:40, mp:10, money:20, hand:all.slice(9,18) },
      turn:first, gf:0, phase:'select', atk:null, log:[],
    };
    sessions[socket.id] = sess;
    addLog(sess, first==='player'
      ? sess.player.name+' の先攻！武器カードで攻撃しよう'
      : sess.cpu.name+' の先攻！守備カードで守ろう');
    socket.emit('init-game', {
      player:playerSnap(sess.player), cpu:cpuSnap(sess.cpu), firstTurn:first, log:sess.log
    });
    if (first==='cpu') setTimeout(()=>doCpuTurn(socket,sess), 1200);
  });

  // ── カード使用 ───────────────────────────────────────────────
  socket.on('use-card', ({ uid }) => {
    const sess = sessions[socket.id];
    if (!sess || sess.phase==='over') return;
    const idx = sess.player.hand.findIndex(c => c.uid===uid);
    if (idx===-1) return;
    const card = sess.player.hand[idx];

    // 守備フェーズ：防具カードで受ける
    if (sess.phase==='player-defense') {
      if (card.type!=='armor') { socket.emit('warn','守備フェーズでは防具カードを選んでください'); return; }
      sess.player.hand.splice(idx, 1);
      // ★ 守備カード消費 → 即ドロー
      const drew = drawOne(sess, 'player');
      if (drew) addLog(sess, '🎴 '+sess.player.name+' 「'+drew.name+'」をドロー');
      resolveAttack(socket, sess, card);
      return;
    }

    // 攻撃選択フェーズ
    if (sess.phase==='select' && sess.turn==='player') {
      if (card.type==='weapon' && !card.isPlusAtk) {
        sess.player.hand.splice(idx, 1);
        sess.atk = { by:'player', baseCard:card, plusCards:[], totalPower:card.power };
        sess.phase = 'adding';
        addLog(sess, '⚔ 「'+card.name+'」を選択。+カードを重ねるか「決定」を！');
        socket.emit('atk-started', {
          baseCard:card, totalPower:card.power, player:playerSnap(sess.player), log:sess.log
        });
        return;
      }
      if (card.type==='weapon' && card.isPlusAtk) {
        sess.player.hand.splice(idx, 1);
        sess.atk = { by:'player', baseCard:card, plusCards:[], totalPower:card.power };
        sess.phase = 'adding';
        addLog(sess, '⚔ 「'+card.name+'」(+'+card.power+')を選択。さらに+カードを重ねるか「決定」を！');
        socket.emit('atk-started', {
          baseCard:card, totalPower:card.power, player:playerSnap(sess.player), log:sess.log
        });
        return;
      }
      if (card.type==='miracle') {
        sess.player.hand.splice(idx, 1);
        // ★ 奇跡消費 → 即ドロー
        const drew = drawOne(sess, 'player');
        if (drew) addLog(sess, '🎴 '+sess.player.name+' 「'+drew.name+'」をドロー');
        applyMiracle(socket, sess, card, 'player');
        return;
      }
      socket.emit('warn','攻撃フェーズでは武器か奇跡カードを使ってください');
      return;
    }

    // +カード追加フェーズ
    if (sess.phase==='adding' && sess.turn==='player') {
      if (!card.isPlusAtk || card.type!=='weapon') { socket.emit('warn','+カードのみ追加できます'); return; }
      sess.player.hand.splice(idx, 1);
      sess.atk.plusCards.push(card);
      sess.atk.totalPower += card.power;
      addLog(sess, '➕ 「'+card.name+'」(+'+card.power+') 追加！ 合計攻撃力:'+sess.atk.totalPower);
      socket.emit('atk-added', {
        plusCard:card, totalPower:sess.atk.totalPower, player:playerSnap(sess.player), log:sess.log
      });
    }
  });

  // ── 攻撃決定 ─────────────────────────────────────────────────
  socket.on('atk-confirm', () => {
    const sess = sessions[socket.id];
    if (!sess || sess.phase!=='adding' || sess.turn!=='player') return;

    const combinedCard = { ...sess.atk.baseCard, power: sess.atk.totalPower };
    sess.atk.card = combinedCard;
    sess.phase    = 'cpu-defense';

    const plusNames = sess.atk.plusCards.map(c=>c.name).join('＋');
    const logTxt = plusNames
      ? '⚔ '+sess.player.name+'「'+sess.atk.baseCard.name+'＋'+plusNames+'」合計攻'+sess.atk.totalPower+'で攻撃！'
      : '⚔ '+sess.player.name+'「'+sess.atk.baseCard.name+'」攻'+sess.atk.totalPower+'で攻撃！';
    addLog(sess, logTxt);

    // ★ 決定ボタン時点で使った枚数分まとめてドロー
    const usedCount = 1 + sess.atk.plusCards.length;
    for (let i = 0; i < usedCount; i++) {
      const drew = drawOne(sess, 'player');
      if (drew) addLog(sess, '🎴 '+sess.player.name+' 「'+drew.name+'」をドロー');
    }

    socket.emit('player-attacked', { atkCard:combinedCard, player:playerSnap(sess.player), log:sess.log });

    setTimeout(() => {
      const def = cpuPickDefense(sess.cpu);
      if (def) {
        sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===def.uid), 1);
        addLog(sess, '🛡 '+sess.cpu.name+'「'+def.name+'」で防御！');
        // ★ CPU守備カード消費 → ドロー
        drawOne(sess, 'cpu');
      } else {
        addLog(sess, sess.cpu.name+' は防御できず！');
      }
      resolveAttack(socket, sess, def);
    }, 1000);
  });

  // ── キャンセル ───────────────────────────────────────────────
  socket.on('atk-cancel', () => {
    const sess = sessions[socket.id];
    if (!sess || sess.phase!=='adding') return;
    sess.player.hand.push(sess.atk.baseCard);
    sess.atk.plusCards.forEach(c => sess.player.hand.push(c));
    sess.atk = null;
    sess.phase = 'select';
    addLog(sess, sess.player.name+' がキャンセル');
    socket.emit('atk-cancelled', { player:playerSnap(sess.player), log:sess.log });
  });

  socket.on('forgive', () => {
    const s = sessions[socket.id];
    if (!s || s.phase!=='player-defense') return;
    resolveAttack(socket, s, null);
  });

  // パス機能は廃止

  socket.on('disconnect', () => { delete sessions[socket.id]; });
});

// ── 攻撃解決 ─────────────────────────────────────────────────
function resolveAttack(socket, sess, defCard) {
  const atk = sess.atk; if (!atk) return;
  const defender = atk.by==='player' ? sess.cpu : sess.player;
  const atkPow  = atk.card ? atk.card.power : atk.totalPower || atk.baseCard.power;
  const atkAttr = (atk.card||atk.baseCard).attribute;
  const bonus   = elemBonus(atkAttr, defCard ? defCard.attribute : 'none');
  const atkVal  = Math.round(atkPow * bonus);
  const defVal  = defCard ? (defCard.defense > 0 ? defCard.defense : defCard.power) : 0;
  const dmg     = Math.max(0, atkVal - defVal);
  defender.hp   = Math.max(0, defender.hp - dmg);
  sess.gf       = Math.min(100, sess.gf + Math.ceil(dmg / 4));
  sess.atk      = null;

  const bt = bonus>=2?'🔥相性2倍！ ':bonus>=1.5?'⚡相性有利！ ':bonus<=0.5?'💧相性不利 ':'';
  const dt = defCard ? '「'+defCard.name+'」(守'+defVal+') → ' : '無防備 → ';
  addLog(sess, bt+dt+(dmg>0?dmg+'ダメージ！':'ガード！')+' '+defender.name+' HP:'+defender.hp);

  // ★ attack-resolvedには常に最新のhand（ドロー済み）を含める
  const payload = {
    damage:dmg, bonus,
    defCard: defCard ? { name:defCard.name } : null,
    player: playerSnap(sess.player),
    cpu:    cpuSnap(sess.cpu),
    gf: sess.gf, log: sess.log
  };

  if (checkOver(socket, sess, payload)) return;
  sess.phase = 'select';
  socket.emit('attack-resolved', payload);

  if (atk.by==='player') {
    endPlayerTurn(socket, sess);
  } else {
    // CPU攻撃が解決 → プレイヤーのターン
    sess.turn = 'player';
    addLog(sess, '🔷 '+sess.player.name+' のターン');
    socket.emit('your-turn', { player:playerSnap(sess.player), log:sess.log });
  }
}

// ── 奇跡カード ───────────────────────────────────────────────
function applyMiracle(socket, sess, card, who) {
  const me    = who==='player' ? sess.player : sess.cpu;
  const enemy = who==='player' ? sess.cpu    : sess.player;
  if (card.power===0) {
    me.hp = Math.min(40, me.hp+10);
    addLog(sess, '💊 '+me.name+'「'+card.name+'」HP+10！ HP:'+me.hp);
  } else if (card.attribute==='light') {
    const h = Math.ceil(card.power*0.5);
    me.hp = Math.min(40, me.hp+h);
    addLog(sess, '✨ '+me.name+'「'+card.name+'」HP+'+h+'！ HP:'+me.hp);
  } else {
    enemy.hp = Math.max(0, enemy.hp-card.power);
    sess.gf  = Math.min(100, sess.gf+Math.ceil(card.power/4));
    addLog(sess, '🌑 '+me.name+'「'+card.name+'」'+enemy.name+'に'+card.power+'ダメージ！ HP:'+enemy.hp);
  }
  const payload = { player:playerSnap(sess.player), cpu:cpuSnap(sess.cpu), gf:sess.gf, log:sess.log };
  if (checkOver(socket, sess, payload)) return;
  sess.phase = 'select';
  socket.emit('miracle-used', payload);
  if (who==='player') endPlayerTurn(socket, sess);
}

// ── CPUターン ────────────────────────────────────────────────
function doCpuTurn(socket, sess) {
  if (sess.phase==='over') return;
  sess.turn = 'cpu';
  const { action, card, plusCards } = cpuDecide(sess.cpu);

  if (action==='attack') {
    sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===card.uid), 1);
    let totalPow = card.power;
    const usedPlus = [];
    if (plusCards && plusCards.length > 0) {
      const pc = plusCards[0];
      sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===pc.uid), 1);
      totalPow += pc.power;
      usedPlus.push(pc);
    }
    // ★ CPU攻撃カード消費 → ドロー（使った枚数分）
    const cpuDrawCount = 1 + usedPlus.length;
    for (let i = 0; i < cpuDrawCount; i++) { drawOne(sess, 'cpu'); }

    const combinedCard = { ...card, power:totalPow };
    sess.atk   = { by:'cpu', baseCard:card, plusCards:usedPlus, totalPower:totalPow, card:combinedCard };
    sess.phase = 'player-defense';
    addLog(sess, '⚔ '+sess.cpu.name+'「'+card.name+(usedPlus.length?'＋'+usedPlus[0].name:'')+
      '」攻'+totalPow+'で攻撃！ 守備カードを選ぼう');
    socket.emit('cpu-attacked', { atkCard:combinedCard, log:sess.log });

  } else if (action==='miracle') {
    sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===card.uid), 1);
    // ★ CPU奇跡消費 → ドロー
    drawOne(sess, 'cpu');
    applyMiracle(socket, sess, card, 'cpu');

  } else {
    addLog(sess, sess.cpu.name+' はパス');
    sess.turn = 'player';
    addLog(sess, '🔷 '+sess.player.name+' のターン');
    socket.emit('your-turn', { player:playerSnap(sess.player), log:sess.log });
  }
}

function endPlayerTurn(socket, sess) {
  sess.phase = 'select';
  addLog(sess, '⬛ '+sess.cpu.name+' のターン');
  socket.emit('cpu-thinking', { player:playerSnap(sess.player), log:sess.log });
  setTimeout(() => doCpuTurn(socket, sess), 1300);
}

function checkOver(socket, sess, payload) {
  if (sess.player.hp>0 && sess.cpu.hp>0 && sess.gf<100) return false;
  sess.phase = 'over';
  const winner = sess.gf>=100
    ? (sess.player.hp>=sess.cpu.hp ? sess.player.name : sess.cpu.name)
    : (sess.player.hp>0 ? sess.player.name : sess.cpu.name);
  addLog(sess, (sess.gf>=100?'⏰ G.F.100！ ':'💀 ')+winner+' の勝利！');
  socket.emit('game-over', { winner, log:payload.log });
  return true;
}

server.listen(3000, () => console.log('🎮 起動: http://localhost:3000'));