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

// 起動時にDBを削除して毎回CSVから作り直す
if (fs.existsSync(DB_PATH)) { fs.unlinkSync(DB_PATH); console.log('古いDBを削除しました'); }

const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('DB接続エラー:', err); process.exit(1); }
  console.log('DB接続OK（新規作成）');
});

const TYPE_MAP = { '武器':'weapon', '防具':'armor', '奇跡':'miracle', '雑貨':'sundry' };
// 属性マップ（フル形式・短縮形・別表記すべて対応）
const ATTR_MAP = {
  '無属性':'none',
  '火属性':'fire',  '火':'fire',  '炎属性':'fire',  '炎':'fire',
  '水属性':'water', '水':'water', '氷属性':'water', '氷':'water',
  '木属性':'wood',  '木':'wood',
  '土属性':'earth', '土':'earth',
  '光属性':'light', '光':'light',
  '闇属性':'dark',  '闇':'dark',
};

// ── 属性システム ─────────────────────────────────────────────
// 攻撃属性に対して有効な防御属性かどうかを判定
// 光属性は火・水・木・土の代わりになれる（防御側として）
function defenseCanBlock(atkAttr, defAttr) {
  if (atkAttr === 'light') return false;          // 光：どの属性でも防御できない（貫通）
  if (atkAttr === 'none' || atkAttr === 'dark') return true; // 無・闇：どの属性でも防御できる

  // 光属性の防具は火・水・木・土すべての攻撃を防げる
  if (defAttr === 'light') return ['fire','water','wood','earth'].includes(atkAttr);

  // 各属性の有効なカウンター
  const COUNTER = {
    fire:  'water',  // 火の攻撃は水で防御
    water: 'fire',   // 水の攻撃は火で防御
    wood:  'earth',  // 木の攻撃は土で防御
    earth: 'wood',   // 土の攻撃は木で防御
  };
  return COUNTER[atkAttr] === defAttr;
}

// 複数カードのコンボ属性を決定（異なる属性が混在→無属性）
function combineAttrs(attrs) {
  const unique = [...new Set(attrs.filter(a => a && a !== 'none'))];
  if (unique.length === 0) return 'none';
  if (unique.length === 1) return unique[0];
  return 'none'; // 属性が混在→無属性に
}

// 属性の日本語表示
const ATTR_LABEL = {
  none:'無属性', fire:'火属性', water:'水属性',
  wood:'木属性', earth:'土属性', light:'光属性', dark:'闇属性',
};
// ── ターゲット選択が必要な雑貨かチェック ─────────────────────────────
function needsTargetSelect(card) {
  const ab = (card.ability || '').toLowerCase();
  return ab.startsWith('hp_plus') || ab.startsWith('mp_plus');
}



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

  const stmt = db.prepare(
    'INSERT INTO cards (id,icon,name,type,attribute,power,is_plus_atk,defense,ability,gift_rate,price) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  let count = 0;
  lines.forEach(line => {
    const p = line.split(',');
    if (p.length < 6 || !p[2]) return;
    const iconRaw  = (p[1]||'').trim();
    const iconFile = iconRaw.replace(/\\/g, '/').split('/').pop();
    const isPlusAtk = (p[5]||'').trim().startsWith('+') ? 1 : 0;
    const power   = Number((p[5]||'0').replace('+','').trim()) || 0;
    const defense = Number((p[6]||'0').trim()) || 0;
    const price   = Number((p[9]||'0').trim()) || 0;
    const gifRate = Number((p[8]||'1').trim()) || 1;
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
      const typeCount = {};
      CARDS = rows.map(r => {
        const t = r.type || 'weapon';
        typeCount[t] = (typeCount[t]||0)+1;
        return {
          id:r.id, icon:r.icon, name:r.name, type:t, attribute:r.attribute,
          power:r.power, isPlusAtk:r.is_plus_atk===1,
          defense:r.defense, ability:r.ability, giftRate:r.gift_rate, price:r.price,
          typeIndex: typeCount[t],
        };
      });
      const armorCards = CARDS.filter(c=>c.type==='armor');
      console.log('カード読込: '+CARDS.length+'枚 (武器:'
        +CARDS.filter(c=>c.type==='weapon').length+'枚, 防具:'+armorCards.length+'枚, 奇跡:'
        +CARDS.filter(c=>c.type==='miracle').length+'枚)');
      // 防具カードのiconを確認
      console.log('--- 防具カード例 ---');
      armorCards.slice(0,3).forEach(c=>console.log('  ['+c.id+'] '+c.name+' type:'+c.type+' icon:"'+c.icon+'" defense:'+c.defense));
      if(armorCards.length>0&&!armorCards[0].icon){
        console.error('⚠️ 防具カードのiconが空です！CSVを確認してください');
      }
    });
  });
});

// ── ランダム取得 ──────────────────────────────────────────────
function getRandomCards(n) {
  const pool = [];
  CARDS.forEach(c => { for (let i=0;i<c.giftRate;i++) pool.push(c); });
  const shuffled = pool.sort(()=>Math.random()-0.5);
  const seen=new Set(), picked=[];
  for (const c of shuffled) { if (!seen.has(c.id)){seen.add(c.id);picked.push(c);} if(picked.length>=n) break; }
  if (picked.length<n) CARDS.filter(c=>!seen.has(c.id)).sort(()=>Math.random()-0.5).slice(0,n-picked.length).forEach(c=>picked.push(c));
  return picked.slice(0,n).map((c,i)=>({...c, uid:Date.now()+'-'+i+'-'+Math.random().toString(36).slice(2)}));
}

// ── 1枚ドロー ────────────────────────────────────────────────
function drawOne(sess, who) {
  if (CARDS.length===0) return null;
  const pool=[];
  CARDS.forEach(c=>{for(let i=0;i<c.giftRate;i++) pool.push(c);});
  const base=pool[Math.floor(Math.random()*pool.length)];
  const card={...base, uid:Date.now()+'-d-'+Math.random().toString(36).slice(2)};
  (who==='player'?sess.player:sess.cpu).hand.push(card);
  return card;
}

// ── 攻守両用カード判定 ────────────────────────────────────────
function isDualCard(card) {
  return card.type==='weapon' && card.defense>0;
}
// 守備に使えるカード
function canDefend(card) {
  return card.type==='armor' || isDualCard(card);
}



// ── CPU AI ────────────────────────────────────────────────────
function cpuDecide(cpu) {
  const weapons  = cpu.hand.filter(c=>c.type==='weapon');
  const miracles = cpu.hand.filter(c=>c.type==='miracle');
  const sundries = cpu.hand.filter(c=>c.type==='sundry');
  // HP低いとき：HP回復雑貨を優先
  if (cpu.hp<=15) {
    const hpItem = sundries.find(c=>(c.ability||'').match(/\+HP/i));
    if (hpItem) return {action:'sundry', card:hpItem, plusCards:[]};
    const heal=miracles.find(c=>c.power===0||c.attribute==='light');
    if(heal) return {action:'miracle',card:heal,plusCards:[]};
  }
  if (weapons.length) {
    const normals=weapons.filter(c=>!c.isPlusAtk);
    const base=normals.length?[...normals].sort((a,b)=>b.power-a.power)[0]:[...weapons].sort((a,b)=>b.power-a.power)[0];
    return {action:'attack',card:base,plusCards:weapons.filter(c=>c.isPlusAtk)};
  }
  if (miracles.length) return {action:'miracle',card:miracles[0],plusCards:[]};
  return {action:'pass',plusCards:[]};
}
function cpuPickDefense(cpu) {
  // 攻守両用カード含め防御力の高い順に選ぶ
  const defenders = cpu.hand.filter(c=>canDefend(c));
  if (!defenders.length) return [];
  // 最も防御力の高い1枚だけ使う（複数重ねはCPUは今回1枚のみ）
  return [[...defenders].sort((a,b)=>(b.defense||b.power)-(a.defense||a.power))[0]];
}

function addLog(sess,msg){sess.log.unshift(msg);if(sess.log.length>35)sess.log.pop();}
function playerSnap(p){return{name:p.name,hp:p.hp,mp:p.mp,money:p.money,hand:p.hand,handCount:p.hand.length};}
function cpuSnap(c){return{name:c.name,hp:c.hp,mp:c.mp,money:c.money,handCount:c.hand.length};}

const sessions={};

io.on('connection', socket=>{
  console.log('接続:',socket.id);

  socket.on('game-start',({playerName,cpuName})=>{
    if(CARDS.length===0){socket.emit('warn','カードがまだ読み込まれていません');return;}
    const all=getRandomCards(18);
    const first=Math.random()<0.5?'player':'cpu';
    const sess={
      player:{name:playerName||'あなた',hp:40,mp:10,money:20,hand:all.slice(0,9)},
      cpu:   {name:cpuName||'CPU',     hp:40,mp:10,money:20,hand:all.slice(9,18)},
      turn:first,gf:0,
      phase:'select',  // select | adding | player-defense | defending | cpu-defense | over
      atk:null,        // 攻撃情報
      def:null,        // 守備情報 { cards:[], totalDefense }
      log:[],
    };
    sessions[socket.id]=sess;
    addLog(sess,first==='player'?sess.player.name+' の先攻！':sess.cpu.name+' の先攻！守備カードを選ぼう');
    socket.emit('init-game',{player:playerSnap(sess.player),cpu:cpuSnap(sess.cpu),firstTurn:first,log:sess.log});
    if(first==='cpu') setTimeout(()=>doCpuTurn(socket,sess),1200);
  });

  // ── カード使用 ───────────────────────────────────────────────
  socket.on('use-card',({uid})=>{
    const sess=sessions[socket.id];
    if(!sess||sess.phase==='over') return;
    const idx=sess.player.hand.findIndex(c=>c.uid===uid);
    if(idx===-1) return;
    const card=sess.player.hand[idx];

    // ── 守備フェーズ（1枚目）or 守備重ねフェーズ ────────────────
    if(sess.phase==='player-defense'||sess.phase==='defending'){
      if(!canDefend(card)){socket.emit('warn','防具か攻守両用カードを選んでください');return;}
      sess.player.hand.splice(idx,1);

      if(sess.phase==='player-defense'){
        // 1枚目：守備開始
        sess.def={cards:[card],totalDefense: card.defense>0?card.defense:card.power};
        sess.phase='defending';
        addLog(sess,'🛡 「'+card.name+'」(守'+sess.def.totalDefense+')で守備！ 重ねるか「守備決定」を');
        socket.emit('def-started',{defCard:card,totalDefense:sess.def.totalDefense,player:playerSnap(sess.player),log:sess.log});
      } else {
        // 2枚目以降：重ね守備
        const dv = card.defense>0?card.defense:card.power;
        sess.def.cards.push(card);
        sess.def.totalDefense += dv;
        addLog(sess,'🛡➕ 「'+card.name+'」(+守'+dv+') 重ね！ 合計守'+sess.def.totalDefense);
        socket.emit('def-added',{defCard:card,totalDefense:sess.def.totalDefense,player:playerSnap(sess.player),log:sess.log});
      }
      return;
    }

    // ── 攻撃選択フェーズ ─────────────────────────────────────────
    if(sess.phase==='select'&&sess.turn==='player'){
      if(card.type==='weapon'&&!card.isPlusAtk){
        sess.player.hand.splice(idx,1);
        sess.atk={by:'player',baseCard:card,plusCards:[],totalPower:card.power};
        sess.phase='adding';
        addLog(sess,'⚔ 「'+card.name+'」を選択。+カードを重ねるか「決定」を！');
        socket.emit('atk-started',{baseCard:card,totalPower:card.power,player:playerSnap(sess.player),log:sess.log});
        return;
      }
      if(card.type==='weapon'&&card.isPlusAtk){
        sess.player.hand.splice(idx,1);
        sess.atk={by:'player',baseCard:card,plusCards:[],totalPower:card.power};
        sess.phase='adding';
        addLog(sess,'⚔ 「'+card.name+'」(+'+card.power+')を選択。さらに重ねるか「決定」を！');
        socket.emit('atk-started',{baseCard:card,totalPower:card.power,player:playerSnap(sess.player),log:sess.log});
        return;
      }
      if(card.type==='miracle'){
        sess.player.hand.splice(idx,1);
        const drew=drawOne(sess,'player');
        if(drew) addLog(sess,'🎴 '+sess.player.name+' 「'+drew.name+'」をドロー');
        applyMiracle(socket,sess,card,'player');
        return;
      }
      if(card.type==='sundry'){
        sess.player.hand.splice(idx,1);
        const drew=drawOne(sess,'player');
        if(drew) addLog(sess,'🎴 '+sess.player.name+' 「'+drew.name+'」をドロー');
        // HP/MP回復系は使用先を選ばせる
        if(needsTargetSelect(card)){
          sess.phase='target-select';
          sess.pendingSundry=card;
          socket.emit('need-target',{card,player:playerSnap(sess.player),cpu:cpuSnap(sess.cpu)});
        } else {
          applySundry(socket,sess,card,'player','player');
        }
        return;
      }
      socket.emit('warn','攻撃フェーズでは武器か奇跡カードを使ってください');
      return;
    }

    // ── +カード追加フェーズ ──────────────────────────────────────
    if(sess.phase==='adding'&&sess.turn==='player'){
      if(!card.isPlusAtk||card.type!=='weapon'){socket.emit('warn','+カードのみ追加できます');return;}
      sess.player.hand.splice(idx,1);
      sess.atk.plusCards.push(card);
      sess.atk.totalPower+=card.power;
      addLog(sess,'➕ 「'+card.name+'」(+'+card.power+') 追加！ 合計攻'+sess.atk.totalPower);
      socket.emit('atk-added',{plusCard:card,totalPower:sess.atk.totalPower,player:playerSnap(sess.player),log:sess.log});
    }
  });

  // ── 攻撃決定 ─────────────────────────────────────────────────
  socket.on('atk-confirm',()=>{
    const sess=sessions[socket.id];
    if(!sess||sess.phase!=='adding'||sess.turn!=='player') return;
    const combinedCard={...sess.atk.baseCard,power:sess.atk.totalPower};
    sess.atk.card=combinedCard; sess.phase='cpu-defense';
    const plusNames=sess.atk.plusCards.map(c=>c.name).join('＋');
    addLog(sess,'⚔ '+sess.player.name+'「'+(plusNames?sess.atk.baseCard.name+'＋'+plusNames:sess.atk.baseCard.name)+'」攻'+sess.atk.totalPower+'で攻撃！');
    // 使った枚数分ドロー
    const usedCount=1+sess.atk.plusCards.length;
    for(let i=0;i<usedCount;i++){const drew=drawOne(sess,'player');if(drew) addLog(sess,'🎴 '+sess.player.name+' 「'+drew.name+'」をドロー');}
    socket.emit('player-attacked',{atkCard:combinedCard,player:playerSnap(sess.player),log:sess.log});
    setTimeout(()=>{
      const defCards=cpuPickDefense(sess.cpu);
      let totalDef=0;
      defCards.forEach(def=>{
        sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===def.uid),1);
        const dv=def.defense>0?def.defense:def.power;
        totalDef+=dv;
        addLog(sess,'🛡 '+sess.cpu.name+'「'+def.name+'」(守'+dv+')で防御！');
        drawOne(sess,'cpu');
      });
      if(!defCards.length) addLog(sess,sess.cpu.name+' は防御できず！');
      resolveAttack(socket,sess,totalDef>0?{name:defCards.map(c=>c.name).join('＋'),defense:totalDef,attribute:combineAttrs(defCards.map(c=>c.attribute))}:null);
    },1000);
  });

  // ── 守備決定 ─────────────────────────────────────────────────
  socket.on('def-confirm',()=>{
    const sess=sessions[socket.id];
    if(!sess||(sess.phase!=='player-defense'&&sess.phase!=='defending')) return;
    // 守備フェーズで何も選んでいない場合（def-confirmだけ送ってきた）→ 許すと同じ
    if(sess.phase==='player-defense'){ resolveAttack(socket,sess,null); return; }
    // 守備カードを消費した分ドロー
    const count=sess.def.cards.length;
    for(let i=0;i<count;i++){const drew=drawOne(sess,'player');if(drew) addLog(sess,'🎴 '+sess.player.name+' 「'+drew.name+'」をドロー');}
    const defAttrCombined=combineAttrs(sess.def.cards.map(c=>c.attribute));
    const combinedDef={name:sess.def.cards.map(c=>c.name).join('＋'),defense:sess.def.totalDefense,attribute:defAttrCombined};
    sess.def=null;
    resolveAttack(socket,sess,combinedDef);
  });


  // ── 雑貨のターゲット決定 ─────────────────────────────────────────
  socket.on('sundry-target', ({ target }) => {
    const sess = sessions[socket.id];
    if (!sess || sess.phase !== 'target-select' || !sess.pendingSundry) return;
    const card = sess.pendingSundry;
    sess.pendingSundry = null;
    sess.phase = 'select';
    applySundry(socket, sess, card, 'player', target);
  });

  // ── 許す（無防備）────────────────────────────────────────────
  socket.on('forgive',()=>{
    const s=sessions[socket.id];
    if(!s||(s.phase!=='player-defense'&&s.phase!=='defending')) return;
    // 守備で使ったカードがある場合は手札に戻す
    if(s.def){s.def.cards.forEach(c=>s.player.hand.push(c));s.def=null;}
    resolveAttack(socket,s,null);
  });

  // ── キャンセル ───────────────────────────────────────────────
  socket.on('atk-cancel',()=>{
    const sess=sessions[socket.id];
    if(!sess||sess.phase!=='adding') return;
    sess.player.hand.push(sess.atk.baseCard);
    sess.atk.plusCards.forEach(c=>sess.player.hand.push(c));
    sess.atk=null; sess.phase='select';
    addLog(sess,sess.player.name+' がキャンセル');
    socket.emit('atk-cancelled',{player:playerSnap(sess.player),log:sess.log});
  });

  // ── 守備キャンセル（選んだ守備カードを手札に戻す）─────────────
  socket.on('def-cancel',()=>{
    const sess=sessions[socket.id];
    if(!sess||sess.phase!=='defending') return;
    sess.def.cards.forEach(c=>sess.player.hand.push(c));
    sess.def=null; sess.phase='player-defense';
    addLog(sess,sess.player.name+' が守備をやり直し');
    socket.emit('def-cancelled',{player:playerSnap(sess.player),log:sess.log});
  });

  socket.on('disconnect',()=>{delete sessions[socket.id];});
});

// ── 攻撃解決（新属性システム） ────────────────────────────────
function resolveAttack(socket,sess,defCard){
  const atk=sess.atk; if(!atk) return;
  const defender=atk.by==='player'?sess.cpu:sess.player;
  const atkPow=(atk.card?atk.card.power:atk.totalPower||atk.baseCard.power);

  // コンボ攻撃の属性決定（異なる属性が混在→無属性）
  const atkCards=[atk.baseCard,...(atk.plusCards||[])];
  const atkAttr=combineAttrs(atkCards.map(c=>c.attribute));

  // 防御が属性的に有効かチェック
  const defAttr=defCard?defCard.attribute:'none';
  const defEffective=!!defCard&&defenseCanBlock(atkAttr,defAttr);
  const defVal=defEffective?(defCard.defense>0?defCard.defense:defCard.power):0;
  let dmg=Math.max(0,atkPow-defVal);

  // 闇属性：ダメージを少しでも受けるとHP0になる
  let isDarkInstakill=false;
  if(atkAttr==='dark'&&dmg>0){
    isDarkInstakill=true;
    defender.hp=0;
  } else {
    defender.hp=Math.max(0,defender.hp-dmg);
  }

  sess.gf=Math.min(100,sess.gf+Math.ceil(dmg/4));
  sess.atk=null; sess.def=null;

  // ログメッセージ
  const aLabel=ATTR_LABEL[atkAttr]||atkAttr;
  let attrTag='';
  if(atkAttr==='light')      attrTag='✨ 光属性！防御不能！ ';
  else if(isDarkInstakill)   attrTag='🌑 闇属性！HP0！ ';
  else if(atkAttr==='dark')  attrTag='🌑 闇属性 ';
  else if(defCard&&!defEffective&&atkAttr!=='none') attrTag='⚠ 属性不一致！防御無効 ';
  else if(defCard&&defEffective&&atkAttr!=='none')  attrTag='✅ 属性有効！ ';

  const defInfo=defCard
    ?(defEffective?'「'+defCard.name+'」(守'+defVal+')':'「'+defCard.name+'」(無効)')
    :'無防備';
  addLog(sess,attrTag+defInfo+' → '+(dmg>0?dmg+'ダメージ！':'ガード！')+' '+defender.name+' HP:'+defender.hp);

  const payload={
    damage:dmg,
    atkAttr,
    defEffective,
    isDark:atkAttr==='dark',
    isLight:atkAttr==='light',
    isDarkInstakill,
    defCard:defCard?{name:defCard.name}:null,
    player:playerSnap(sess.player),cpu:cpuSnap(sess.cpu),gf:sess.gf,log:sess.log
  };
  if(checkOver(socket,sess,payload)) return;
  sess.phase='select';
  socket.emit('attack-resolved',payload);
  if(atk.by==='player') endPlayerTurn(socket,sess);
  else{sess.turn='player';addLog(sess,'🔷 '+sess.player.name+' のターン');socket.emit('your-turn',{player:playerSnap(sess.player),log:sess.log});}
}

function applyMiracle(socket,sess,card,who){
  const me=who==='player'?sess.player:sess.cpu,enemy=who==='player'?sess.cpu:sess.player;
  if(card.power===0){me.hp=Math.min(40,me.hp+10);addLog(sess,'💊 '+me.name+'「'+card.name+'」HP+10！ HP:'+me.hp);}
  else if(card.attribute==='light'){const h=Math.ceil(card.power*0.5);me.hp=Math.min(40,me.hp+h);addLog(sess,'✨ '+me.name+'「'+card.name+'」HP+'+h+'！ HP:'+me.hp);}
  else{enemy.hp=Math.max(0,enemy.hp-card.power);sess.gf=Math.min(100,sess.gf+Math.ceil(card.power/4));addLog(sess,'🌑 '+me.name+'「'+card.name+'」'+enemy.name+'に'+card.power+'ダメージ！ HP:'+enemy.hp);}
  const payload={player:playerSnap(sess.player),cpu:cpuSnap(sess.cpu),gf:sess.gf,log:sess.log};
  if(checkOver(socket,sess,payload)) return;
  sess.phase='select';socket.emit('miracle-used',payload);
  if(who==='player') endPlayerTurn(socket,sess);
}

function applySundry(socket, sess, card, who, target) {
  // who    = 'player' | 'cpu'  （カードを使ったのは誰か）
  // target = 'player' | 'cpu'  （効果の対象。未指定なら使用者に適用）
  const ab  = (card.ability || '').trim();
  const abL = ab.toLowerCase();

  // HP/MP回復系
  const hpMatch = abL.match(/^hp_plus_(\d+)/);
  const mpMatch = abL.match(/^mp_plus_(\d+)/);

  if (hpMatch || mpMatch) {
    const targetWho = target || who;
    const tgt = targetWho === 'player' ? sess.player : sess.cpu;
    let msg = '';
    if (hpMatch) {
      const val = Number(hpMatch[1]);
      tgt.hp = Math.min(40, tgt.hp + val);
      msg = '💖 HP+' + val + '！(HP:' + tgt.hp + ')';
    }
    if (mpMatch) {
      const val = Number(mpMatch[1]);
      tgt.mp = Math.min(40, tgt.mp + val);
      msg = '💙 MP+' + val + '！(MP:' + tgt.mp + ')';
    }
    addLog(sess, sess[who === 'player' ? 'player' : 'cpu'].name + '「' + card.name + '」→ ' + tgt.name + ' ' + msg);
    const payload = { player:playerSnap(sess.player), cpu:cpuSnap(sess.cpu), gf:sess.gf, log:sess.log };
    if (checkOver(socket, sess, payload)) return;
    sess.phase = 'select';
    socket.emit('sundry-used', payload);
    if (who === 'player') endPlayerTurn(socket, sess);
    return;
  }

  // 旧フォールバック（+HP10 など日本語形式）
  let msg = '';
  const hpMatchJp = ab.match(/[+＋]HP(\d+)/i);
  const mpMatchJp = ab.match(/[+＋]MP(\d+)/i);
  const me = who === 'player' ? sess.player : sess.cpu;
  if (hpMatchJp) { const val=Number(hpMatchJp[1]); me.hp=Math.min(40,me.hp+val); msg+='💖 HP+'+val+'！(HP:'+me.hp+') '; }
  if (mpMatchJp) { const val=Number(mpMatchJp[1]); me.mp=Math.min(40,me.mp+val); msg+='💙 MP+'+val+'！(MP:'+me.mp+') '; }
  if (!msg) msg = '（' + (ab || '効果なし') + '）';
  addLog(sess, me.name + '「' + card.name + '」' + msg.trim());
  const payload = { player:playerSnap(sess.player), cpu:cpuSnap(sess.cpu), gf:sess.gf, log:sess.log };
  if (checkOver(socket, sess, payload)) return;
  sess.phase = 'select';
  socket.emit('sundry-used', payload);
  if (who === 'player') endPlayerTurn(socket, sess);
}

function doCpuTurn(socket,sess){
  if(sess.phase==='over') return;
  sess.turn='cpu';
  const {action,card,plusCards}=cpuDecide(sess.cpu);
  if(action==='attack'){
    sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===card.uid),1);
    let totalPow=card.power; const usedPlus=[];
    if(plusCards&&plusCards.length>0){const pc=plusCards[0];sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===pc.uid),1);totalPow+=pc.power;usedPlus.push(pc);}
    const cpuDrawCount=1+usedPlus.length;
    for(let i=0;i<cpuDrawCount;i++) drawOne(sess,'cpu');
    const combinedCard={...card,power:totalPow};
    sess.atk={by:'cpu',baseCard:card,plusCards:usedPlus,totalPower:totalPow,card:combinedCard};
    sess.phase='player-defense';
    addLog(sess,'⚔ '+sess.cpu.name+'「'+card.name+(usedPlus.length?'＋'+usedPlus[0].name:'')+'」攻'+totalPow+'で攻撃！ 守備カードを選ぼう');
    socket.emit('cpu-attacked',{atkCard:combinedCard,log:sess.log});
  } else if(action==='miracle'){
    sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===card.uid),1);
    drawOne(sess,'cpu');
    applyMiracle(socket,sess,card,'cpu');
  } else if(action==='sundry'){
    sess.cpu.hand.splice(sess.cpu.hand.findIndex(c=>c.uid===card.uid),1);
    drawOne(sess,'cpu');
    // CPU 雑貨: HP/MP回復は自分に使う（将来的にHP低い方を選ぶ余地あり）
    const cpuTarget = needsTargetSelect(card) ? 'cpu' : 'cpu';
    applySundry(socket,sess,card,'cpu',cpuTarget);
  } else {
    addLog(sess,sess.cpu.name+' はパス');sess.turn='player';
    addLog(sess,'🔷 '+sess.player.name+' のターン');
    socket.emit('your-turn',{player:playerSnap(sess.player),log:sess.log});
  }
}

function endPlayerTurn(socket,sess){
  sess.phase='select';
  addLog(sess,'⬛ '+sess.cpu.name+' のターン');
  socket.emit('cpu-thinking',{player:playerSnap(sess.player),log:sess.log});
  setTimeout(()=>doCpuTurn(socket,sess),1300);
}

function checkOver(socket,sess,payload){
  if(sess.player.hp>0&&sess.cpu.hp>0&&sess.gf<100) return false;
  sess.phase='over';
  const winner=sess.gf>=100?(sess.player.hp>=sess.cpu.hp?sess.player.name:sess.cpu.name):(sess.player.hp>0?sess.player.name:sess.cpu.name);
  addLog(sess,(sess.gf>=100?'⏰ G.F.100！ ':'💀 ')+winner+' の勝利！');
  socket.emit('game-over',{winner,log:payload.log});
  return true;
}

server.listen(3000,()=>console.log('🎮 起動: http://localhost:3000'));