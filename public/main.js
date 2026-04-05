document.addEventListener('DOMContentLoaded', () => {

    const socket = io();

    // ── 要素取得 ─────────────────────────────────────────────
    const overlay       = document.getElementById('name-input-overlay');
    const lobby         = document.getElementById('lobby-container');
    const battle        = document.getElementById('battle-container');
    const resultOverlay = document.getElementById('result-overlay');
    const nameInput     = document.getElementById('user-name-input');
    const submitBtn     = document.getElementById('submit-name-btn');
    const joinSoloBtn   = document.getElementById('join-solo-btn');
    const addCpuBtn     = document.getElementById('add-cpu-btn');
    const playerSlot    = document.getElementById('player-slot-0');
    const startBtn      = document.getElementById('start-battle-btn');
    const shuffleBtn    = document.querySelector('.shuffle-btn');
    const teamSlots     = document.querySelectorAll('.team-slot');
    const phaseLabel    = document.getElementById('battle-phase-label');
    const gfBar         = document.getElementById('gf-bar');
    const gfNum         = document.getElementById('gf-num');
    const attackerEl    = document.getElementById('attacker-name');
    const targetEl      = document.getElementById('target-name');
    const actionIcon    = document.getElementById('action-icon');
    const actionName    = document.getElementById('action-card-name');
    const actionStats   = document.getElementById('action-card-stats');
    const dmgBadge      = document.getElementById('damage-badge');
    const forgiveBtn    = document.getElementById('forgive-btn');
    const handArea      = document.getElementById('hand-area');
    const logEl         = document.getElementById('battle-log');
    const retryBtn      = document.getElementById('retry-btn');
    const backBtn       = document.getElementById('battle-back-btn');
    const pName         = document.getElementById('player-sc-name');
    const pHpBar        = document.getElementById('player-hp-bar');
    const pHpVal        = document.getElementById('player-hp-val');
    const pMpVal        = document.getElementById('player-mp-val');
    const pMoneyVal     = document.getElementById('player-money-val');
    const pHandCnt      = document.getElementById('player-hand-cnt');
    const cName         = document.getElementById('cpu-sc-name');
    const cHpBar        = document.getElementById('cpu-hp-bar');
    const cHpVal        = document.getElementById('cpu-hp-val');
    const cMpVal        = document.getElementById('cpu-mp-val');
    const cMoneyVal     = document.getElementById('cpu-money-val');
    const cHandCnt      = document.getElementById('cpu-hand-cnt');
    const cardDetail    = document.getElementById('card-detail-panel');
    const cdImg         = document.getElementById('cd-img');
    const cdName        = document.getElementById('cd-name');
    const cdPower       = document.getElementById('cd-power');
    const cdAbility     = document.getElementById('cd-ability');
    const cdPrice       = document.getElementById('cd-price');
    // +カード重ねUI
    const atkBar        = document.getElementById('atk-bar');
    const atkBarName    = document.getElementById('atk-bar-name');
    const atkBarPower   = document.getElementById('atk-bar-power');
    const atkConfirmBtn = document.getElementById('atk-confirm-btn');
    const atkCancelBtn  = document.getElementById('atk-cancel-btn');

    // ── 状態 ─────────────────────────────────────────────────
    let userName     = '';
    let cpuNameG     = 'CPU';
    let isJoined     = false;
    let myHand       = [];
    let currentPhase = 'select';
    let currentAtk   = null;  // { baseCard, plusCards[], totalPower }

    const cpuNames   = ['修行僧','守護龍','一般兵','バハムート','名無しの神','モアイ','占い師'];
    const teamColors = ['green','red','yellow','purple'];

    // ── 画像・SVGフォールバック ───────────────────────────────
    const ATTR_PALETTE = {
        none:  { grad:['#d4c9b0','#b8a88a'], icon:'⚔️' },
        fire:  { grad:['#ffb380','#ff6600'], icon:'🔥' },
        water: { grad:['#80c4ff','#0088ff'], icon:'💧' },
        wood:  { grad:['#a8e080','#44aa00'], icon:'🌿' },
        light: { grad:['#fff080','#ffcc00'], icon:'✨' },
        dark:  { grad:['#c080e8','#8800cc'], icon:'🌑' },
    };

    function makeSVGUrl(card) {
        const p = ATTR_PALETTE[card.attribute] || ATTR_PALETTE.none;
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">' +
          '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="'+p.grad[0]+'"/>' +
          '<stop offset="100%" stop-color="'+p.grad[1]+'"/>' +
          '</linearGradient></defs>' +
          '<rect width="80" height="80" rx="8" fill="url(#g)"/>' +
          '<text x="40" y="52" text-anchor="middle" font-size="36">'+p.icon+'</text>' +
          '</svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    // 画像パス生成：
    // iconがあれば images/icon を使う、なければSVGフォールバック
    function setImgWithFallback(imgEl, card) {
        if (card.icon && card.icon.trim() !== '') {
            const imgPath = 'images/' + card.icon;
            console.log('[画像]', card.name, '→', imgPath);
            imgEl.src = imgPath;
            imgEl.onerror = () => {
                console.warn('[画像 404]', imgPath, '→ SVGフォールバック');
                imgEl.onerror = null;
                imgEl.src = makeSVGUrl(card);
            };
        } else {
            console.log('[画像なし]', card.name, '→ SVGフォールバック');
            imgEl.src = makeSVGUrl(card);
        }
    }

    function getPowerLabel(card) {
        if (card.type === 'armor')  return '守' + (card.defense > 0 ? card.defense : card.power);
        if (card.power === 0)       return '回復';
        if (card.isPlusAtk)         return '+' + card.power;
        return '攻' + card.power;
    }

    // ━━━━━━━━━━━━━━ ロビー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    submitBtn.addEventListener('click', () => {
        const v = nameInput.value.trim();
        if (!v) { alert('名前を入力してください'); return; }
        userName = v; overlay.style.display='none'; lobby.style.display='flex';
    });
    nameInput.addEventListener('keydown', e => { if (e.key==='Enter') submitBtn.click(); });

    joinSoloBtn.addEventListener('click', () => {
        if (!isJoined) {
            playerSlot.innerHTML='<span style="color:#9e9e9e;margin-right:40px;">●</span>'+userName;
            playerSlot.classList.remove('empty'); playerSlot.classList.add('joined'); isJoined=true;
        } else {
            playerSlot.innerHTML=''; playerSlot.className='list-item empty'; isJoined=false;
        }
    });

    addCpuBtn.addEventListener('click', () => {
        const all=document.querySelectorAll('.list-item');
        for(let i=1;i<all.length;i++){
            if(all[i].classList.contains('empty')){
                const n=cpuNames[Math.floor(Math.random()*cpuNames.length)];
                cpuNameG=n;
                all[i].innerHTML='<span style="color:#9e9e9e;margin-right:40px;">●</span>'+n;
                all[i].classList.remove('empty'); all[i].classList.add('cpu-joined'); return;
            }
        }
    });

    teamSlots.forEach(slot=>{
        slot.addEventListener('click',()=>{
            const joined=document.querySelectorAll('.joined,.cpu-joined');
            if(joined.length<2){alert('修行者を呼んでください');return;}
            const col=[...slot.classList].find(c=>teamColors.includes(c));
            const opp=col==='red'?'green':'red';
            joined.forEach((p,i)=>{p.classList.remove(...teamColors.map(c=>'team-'+c));p.classList.add('team-'+(i%2===0?col:opp));});
        });
    });

    shuffleBtn.addEventListener('click',()=>{
        document.querySelectorAll('.joined,.cpu-joined').forEach(p=>{
            const c=teamColors[Math.floor(Math.random()*teamColors.length)];
            p.classList.remove(...teamColors.map(t=>'team-'+t)); p.classList.add('team-'+c);
        });
    });

    startBtn.addEventListener('click',()=>{
        const joined=document.querySelectorAll('.joined,.cpu-joined');
        if(!isJoined||joined.length<2){alert('準備ができていません');return;}
        lobby.style.display='none'; battle.style.display='flex';
        socket.emit('game-start',{playerName:userName,cpuName:cpuNameG});
    });

    backBtn.addEventListener('click',()=>location.reload());
    retryBtn.addEventListener('click',()=>location.reload());

    // ━━━━━━━━━━━━━━ 攻撃バー（+カード重ねUI）━━━━━━━━━━━━━━━

    // 攻撃バー：重ねたカード画像を並べて表示
    const atkCardsRow = document.getElementById('atk-cards-row');

    function renderAtkCards() {
        if (!atkCardsRow || !currentAtk) return;
        atkCardsRow.innerHTML = '';

        // baseCardを追加
        atkCardsRow.appendChild(makeAtkCardThumb(currentAtk.baseCard, false));

        // plusCardsを追加（＋マーク付き）
        currentAtk.plusCards.forEach(c => {
            const plus = document.createElement('div');
            plus.className = 'atk-plus-sign';
            plus.textContent = '＋';
            atkCardsRow.appendChild(plus);
            atkCardsRow.appendChild(makeAtkCardThumb(c, true));
        });
    }

    function makeAtkCardThumb(card, isPlus) {
        const wrap = document.createElement('div');
        wrap.className = 'atk-card-thumb' + (isPlus ? ' is-plus' : '');
        const img = document.createElement('img');
        setImgWithFallback(img, card);
        img.className = 'atk-thumb-img';
        const lbl = document.createElement('div');
        lbl.className = 'atk-thumb-lbl';
        lbl.textContent = isPlus ? '+'+card.power : '攻'+card.power;
        wrap.appendChild(img);
        wrap.appendChild(lbl);
        return wrap;
    }

    function showAtkBar(baseCard, totalPower) {
        currentAtk = { baseCard, plusCards: [], totalPower };
        atkBarPower.textContent = totalPower;
        renderAtkCards();
        atkBar.style.display = 'flex';
    }
    function updateAtkBar(plusCard, totalPower) {
        if (!currentAtk) return;
        currentAtk.plusCards.push(plusCard);
        currentAtk.totalPower = totalPower;
        atkBarPower.textContent = totalPower;
        renderAtkCards();
    }
    function hideAtkBar() {
        atkBar.style.display = 'none';
        currentAtk = null;
        if (atkCardsRow) atkCardsRow.innerHTML = '';
    }

    atkConfirmBtn.addEventListener('click', () => {
        socket.emit('atk-confirm');
        hideAtkBar();
        currentPhase = 'cpu-thinking';
        phaseLabel.textContent = '⏳ CPUが守備を選んでいます…';
        renderHand();
    });
    atkCancelBtn.addEventListener('click', () => {
        socket.emit('atk-cancel');
        hideAtkBar();
    });

    // ━━━━━━━━━━━━━━ Socket.IO イベント ━━━━━━━━━━━━━━━━━━━━━

    function receiveHand(player) {
        if (player && Array.isArray(player.hand)) myHand = player.hand;
    }

    socket.on('init-game', ({ player, cpu, firstTurn, log }) => {
        receiveHand(player);
        pName.textContent=player.name; cName.textContent=cpu.name;
        updateStatus(player,cpu,0); renderHand(); renderLog(log);
        setAttackerTarget(firstTurn==='player'?player.name:cpu.name, firstTurn==='player'?cpu.name:player.name);
        if(firstTurn==='player'){setPhase('select');showCardDisplay(null);}
        else{setPhase('cpu-turn');showCardDisplay(null);forgiveBtn.style.display='none';}
    });

    // 通常武器カードを選択した → addingフェーズ
    socket.on('atk-started', ({ baseCard, totalPower, player, log }) => {
        receiveHand(player);
        updateStatusPlayer(player);
        renderLog(log);
        currentPhase = 'adding';
        phaseLabel.textContent = '➕ +カードを重ねるか「決定」を押そう';
        showAtkBar(baseCard, totalPower);
        showCardDisplay(baseCard);
        dmgBadge.textContent = '攻' + totalPower;
        renderHand();
    });

    // +カードを追加した
    socket.on('atk-added', ({ plusCard, totalPower, player, log }) => {
        receiveHand(player);
        updateStatusPlayer(player);
        renderLog(log);
        updateAtkBar(plusCard, totalPower);   // plusCardを渡してサムネイル追加
        dmgBadge.textContent = '攻' + totalPower;
        renderHand();
    });

    // キャンセルした
    socket.on('atk-cancelled', ({ player, log }) => {
        receiveHand(player);
        updateStatusPlayer(player);
        renderLog(log);
        hideAtkBar();
        currentPhase = 'select';
        phaseLabel.textContent = '🃏 武器 or 奇跡カードを選ぼう';
        showCardDisplay(null);
        dmgBadge.textContent = '';
        renderHand();
    });

    socket.on('player-attacked', ({ atkCard, player, log }) => {
        receiveHand(player); renderHand(); renderLog(log);
        showCardDisplay(atkCard); setAttackerTarget(pName.textContent,cName.textContent);
        dmgBadge.textContent='攻'+atkCard.power;
        currentPhase='cpu-thinking'; phaseLabel.textContent='⏳ CPUが守備を選んでいます…';
        if(player) updateStatusPlayer(player);
        hideAtkBar();
    });

    socket.on('cpu-attacked', ({ atkCard, log }) => {
        renderLog(log); showCardDisplay(atkCard);
        setAttackerTarget(cName.textContent,pName.textContent);
        dmgBadge.textContent='攻'+atkCard.power;
        forgiveBtn.style.display='block';
        currentPhase='player-defense'; phaseLabel.textContent='🛡 守備カードを選ぶか「許す」';
        renderHand();
    });

    socket.on('attack-resolved', ({ damage, bonus, defCard, player, cpu, gf, log }) => {
        receiveHand(player); updateStatus(player,cpu,gf); renderLog(log);
        renderHand(); showDamageFlash(damage,bonus);
        forgiveBtn.style.display='none'; dmgBadge.textContent='';
        hideAtkBar();
    });

    socket.on('miracle-used', ({ player, cpu, gf, log }) => {
        receiveHand(player); updateStatus(player,cpu,gf); renderLog(log);
        renderHand(); forgiveBtn.style.display='none';
    });

    socket.on('your-turn', ({ player, log }) => {
        receiveHand(player); if(player) updateStatusPlayer(player);
        renderLog(log); currentPhase='select';
        setAttackerTarget(pName.textContent,cName.textContent);
        showCardDisplay(null); phaseLabel.textContent='🃏 武器 or 奇跡カードを選ぼう';
        forgiveBtn.style.display='none'; hideAtkBar(); renderHand();
    });

    socket.on('cpu-thinking', ({ player, log }) => {
        receiveHand(player); renderLog(log);
        currentPhase='cpu-turn'; phaseLabel.textContent='⬛ CPUのターン…';
        forgiveBtn.style.display='none'; renderHand();
    });

    socket.on('game-over', ({ winner, log }) => {
        renderLog(log); currentPhase='over'; phaseLabel.textContent='🏆 ゲーム終了';
        document.getElementById('result-msg').textContent=winner+' の勝利！';
        resultOverlay.style.display='flex';
    });

    socket.on('warn', msg => flashWarn(msg));

    forgiveBtn.addEventListener('click', () => {
        if(currentPhase!=='player-defense') return;
        socket.emit('forgive'); forgiveBtn.style.display='none';
        currentPhase='cpu-thinking'; phaseLabel.textContent='⏳ ダメージ計算中…'; renderHand();
    });

    // パスボタンは廃止

    // ━━━━━━━━━━━━━━ カード詳細パネル ━━━━━━━━━━━━━━━━━━━━━━━

    function showCardDetail(card, wrapEl) {
        setImgWithFallback(cdImg, card);
        cdName.textContent    = card.name;
        cdPower.textContent   = getPowerLabel(card);
        cdAbility.textContent = card.ability || '';
        cdAbility.style.display = card.ability ? 'block' : 'none';
        cdPrice.textContent   = '¥' + card.price;
        cardDetail.className  = 'card-detail-panel ' + (card.type||'weapon');
        cardDetail.style.display = 'block';
        // 位置：カードの上に表示
        const rect   = wrapEl.getBoundingClientRect();
        const panelW = 165;
        let left = rect.left + rect.width/2 - panelW/2;
        left = Math.max(4, Math.min(left, window.innerWidth-panelW-4));
        cardDetail.style.left   = left + 'px';
        cardDetail.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        cardDetail.style.top    = 'auto';
    }
    function hideCardDetail() { cardDetail.style.display='none'; }

    // ━━━━━━━━━━━━━━ 手札描画 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    function renderHand() {
        handArea.innerHTML = '';
        hideCardDetail();

        const isDefPhase = currentPhase === 'player-defense';
        const isAdding   = currentPhase === 'adding';
        const isBusy     = currentPhase === 'cpu-thinking' || currentPhase === 'cpu-turn' || currentPhase === 'over';

        myHand.forEach(card => {
            // 選択可否
            let unplayable;
            if (isBusy)        unplayable = true;
            else if (isDefPhase) unplayable = card.type !== 'armor';
            else if (isAdding)   unplayable = !(card.isPlusAtk && card.type === 'weapon');
            else                 unplayable = card.type === 'armor';  // selectフェーズ：防具は使えない

            const wrap = document.createElement('div');
            wrap.className = 'hc-wrap' + (unplayable ? ' unplayable' : '');

            // カード画像（typeIndexから自動生成→フォールバック）
            const img = document.createElement('img');
            img.className = 'hc-img';
            img.alt       = '';
            img.draggable = false;
            setImgWithFallback(img, card);

            // 攻守ラベル
            const label = document.createElement('div');
            label.className   = 'hc-label ' + card.type;
            label.textContent = getPowerLabel(card);

            wrap.appendChild(img);
            wrap.appendChild(label);

            // ホバーで詳細
            wrap.addEventListener('mouseenter', () => { if(!unplayable) showCardDetail(card, wrap); });
            wrap.addEventListener('mouseleave', hideCardDetail);

            if (!unplayable) wrap.addEventListener('click', () => onCardClick(card));

            handArea.appendChild(wrap);
        });
    }

    function onCardClick(card) {
        hideCardDetail();
        if (currentPhase === 'player-defense') {
            if (card.type!=='armor') { flashWarn('🛡 守備フェーズでは防具カードを選んでください'); return; }
            socket.emit('use-card',{uid:card.uid});
            forgiveBtn.style.display='none';
            currentPhase='cpu-thinking'; phaseLabel.textContent='⏳ ダメージ計算中…'; renderHand();

        } else if (currentPhase === 'select') {
            if (card.type==='weapon'||card.type==='miracle') {
                socket.emit('use-card',{uid:card.uid});
                currentPhase='cpu-thinking'; // サーバー応答待ち（atk-startedで上書き）
                renderHand();
            } else {
                flashWarn('攻撃フェーズでは武器か奇跡カードを使ってください');
            }

        } else if (currentPhase === 'adding') {
            // +カードを追加
            if (!card.isPlusAtk || card.type!=='weapon') { flashWarn('+カードのみ追加できます'); return; }
            socket.emit('use-card',{uid:card.uid});
        }
    }

    // ━━━━━━━━━━━━━━ UI関数 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    function setPhase(phase) {
        currentPhase=phase;
        const labels={
            'select':'🃏 武器 or 奇跡カードを選ぼう',
            'adding':'➕ +カードを重ねるか「決定」を押そう',
            'player-defense':'🛡 守備カードを選ぶか「許す」',
            'cpu-thinking':'⏳ CPUが守備を選んでいます…',
            'cpu-turn':'⬛ CPUのターン…',
            'over':'🏆 ゲーム終了',
        };
        phaseLabel.textContent=labels[phase]||phase; renderHand();
    }

    function setAttackerTarget(a,t){ attackerEl.textContent=a; targetEl.textContent=t; }

    const TYPE_ICONS={weapon:'⚔️',armor:'🛡️',miracle:'✨'};
    function showCardDisplay(card) {
        if(!card){ actionIcon.textContent='─';actionName.textContent='待機中';actionStats.textContent='';dmgBadge.textContent='';return;}
        actionIcon.textContent=TYPE_ICONS[card.type]||'🃏';
        actionName.textContent=card.name;
        actionStats.textContent=getPowerLabel(card);
    }

    function updateStatus(player,cpu,gf){
        updateStatusPlayer(player);
        cHpVal.textContent=cpu.hp; cMpVal.textContent=cpu.mp; cMoneyVal.textContent=cpu.money;
        cHandCnt.textContent=cpu.handCount;
        cHpBar.style.width=Math.max(0,(cpu.hp/40)*100)+'%';
        if(cpu.hp<=10)cHpBar.classList.add('danger'); else cHpBar.classList.remove('danger');
        gfNum.textContent=gf; gfBar.style.width=gf+'%';
        if(gf>=70)gfBar.classList.add('gf-danger');
    }
    function updateStatusPlayer(player){
        if(!player)return;
        pHpVal.textContent=player.hp; pMpVal.textContent=player.mp; pMoneyVal.textContent=player.money;
        pHandCnt.textContent=player.handCount!==undefined?player.handCount:myHand.length;
        pHpBar.style.width=Math.max(0,(player.hp/40)*100)+'%';
        if(player.hp<=10)pHpBar.classList.add('danger'); else pHpBar.classList.remove('danger');
    }
    function renderLog(logArr){
        if(!logArr)return;
        logEl.innerHTML=logArr.map(l=>'<div class="log-line">'+l+'</div>').join('');
        logEl.scrollTop=0;
    }
    function showDamageFlash(damage,bonus){
        const el=document.createElement('div');
        el.className='dmg-flash'; el.textContent=damage===0?'GUARD!':'-'+damage;
        if(bonus>=2)el.classList.add('bonus-2x'); else if(bonus>=1.5)el.classList.add('bonus');
        document.body.appendChild(el); setTimeout(()=>el.remove(),900);
    }
    function flashWarn(msg){
        const el=document.createElement('div');
        el.className='warn-flash'; el.textContent=msg;
        document.body.appendChild(el); setTimeout(()=>el.remove(),2000);
    }
});