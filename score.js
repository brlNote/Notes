// =========================================
//  ScorePlayer - score.js
//  PDF楽譜ビューア + メトロノーム + 自動ページめくり
// =========================================

// --- PDF.js worker ---
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ===== State =====
let pdfDoc      = null;
let curPage     = 1;
let totalPages  = 0;
let scale       = 1.5;
let rendering   = false;
let pendingPage = null;

// Annotations per page: { page: [{type,x1,y1,x2,y2,color,size}] }
let annotations  = {};
let drawing      = false;
let drawColor    = '#ef4444';
let drawSize     = 3;
let eraseMode    = false;
let lastX = 0, lastY = 0;

// Sections: [{name, page}]
let sections = [];

// Metronome
let audioCtx    = null;
let metroBpm    = 120;
let metroBeats  = 4;
let metroActive = false;
let metroBeat   = 0;
let metroNext   = 0;
let metroTimer  = null;
const AHEAD     = 0.12;
const LOOK_MS   = 25;

// Auto page turn
let measPerPage  = 4;
let beatCounter  = 0;
let autoActive   = false;
let totalBeats   = 0;  // beatsPerPage = metroBeats * measPerPage
let warnBeats    = 0;  // show countdown for last N beats

let tapTimes = [];

// ===== DOM helpers =====
const $  = id => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

function toast(msg, dur = 2000) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), dur);
}
function setStatus(msg) { $('status-msg').textContent = msg; }

// ===== PDF Loading =====
function loadPDF(file) {
    if (!file || file.type !== 'application/pdf') {
        if (file && !file.name.toLowerCase().endsWith('.pdf')) {
            toast('⚠️ PDFファイルを選択してください');
            return;
        }
    }
    setStatus('読み込み中...');
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const pdf = await pdfjsLib.getDocument({ data: e.target.result }).promise;
            pdfDoc     = pdf;
            totalPages = pdf.numPages;
            curPage    = 1;
            annotations = {};
            sections    = [];
            renderSectionList();

            $('tot-page').textContent = totalPages;
            $('goto-input').max = totalPages;
            $('goto-input').disabled = false;
            $('goto-btn').disabled   = false;
            $('prev-btn').disabled   = false;
            $('next-btn').disabled   = false;
            $('autoturn-btn').disabled = false;

            $('upload-prompt').style.display = 'none';
            $('canvas-wrapper').style.display = 'block';

            await renderPage(curPage);
            fitToWindow();
            setStatus('✅ ' + file.name + ' (' + totalPages + 'ページ)');
        } catch (err) {
            console.error(err);
            toast('❌ PDF読み込み失敗: ' + err.message, 4000);
            setStatus('読み込みエラー');
        }
    };
    reader.readAsArrayBuffer(file);
}

// ===== Page Rendering =====
async function renderPage(num) {
    if (!pdfDoc) return;
    if (rendering) { pendingPage = num; return; }
    rendering = true;

    const page = await pdfDoc.getPage(num);
    const vp   = page.getViewport({ scale });
    const canvas = $('pdf-canvas');
    const ctx    = canvas.getContext('2d');
    canvas.width  = vp.width;
    canvas.height = vp.height;

    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // Annotation canvas
    const ac = $('annot-canvas');
    ac.width  = vp.width;
    ac.height = vp.height;
    drawAnnotations(num);

    curPage = num;
    $('cur-page').textContent = num;
    updateNavButtons();
    updateSectionHighlight();

    rendering = false;
    if (pendingPage !== null) {
        const p = pendingPage; pendingPage = null;
        renderPage(p);
    }
}

function goToPage(num) {
    num = Math.max(1, Math.min(totalPages, num));
    if (num !== curPage) renderPage(num);
}

function updateNavButtons() {
    $('prev-btn').disabled = curPage <= 1;
    $('next-btn').disabled = curPage >= totalPages;
}

// ===== Zoom =====
function setZoom(newScale) {
    scale = Math.max(0.5, Math.min(4.0, newScale));
    $('zoom-val').textContent = Math.round(scale * 100) + '%';
    if (pdfDoc) renderPage(curPage);
}

function fitToWindow() {
    if (!pdfDoc) return;
    const area = $('canvas-area');
    const W = area.clientWidth - 48;
    const H = area.clientHeight - 48;
    pdfDoc.getPage(curPage).then(page => {
        const vp = page.getViewport({ scale: 1 });
        const s  = Math.min(W / vp.width, H / vp.height);
        setZoom(parseFloat(s.toFixed(2)));
    });
}

// ===== Annotations (Drawing) =====
function drawAnnotations(pageNum) {
    const ac  = $('annot-canvas');
    const ctx = ac.getContext('2d');
    ctx.clearRect(0, 0, ac.width, ac.height);
    const list = annotations[pageNum] || [];
    list.forEach(seg => {
        ctx.beginPath();
        ctx.strokeStyle = seg.color;
        ctx.lineWidth   = seg.size;
        ctx.lineCap     = 'round';
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
    });
}

function getCanvasPos(e) {
    const r = $('annot-canvas').getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
}

function startDraw(e) {
    e.preventDefault();
    drawing = true;
    const p = getCanvasPos(e);
    lastX = p.x; lastY = p.y;
}

function moveDraw(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = getCanvasPos(e);
    if (eraseMode) {
        // Erase segments near cursor
        const r = drawSize * 5;
        annotations[curPage] = (annotations[curPage] || []).filter(seg => {
            const dx = (seg.x1 + seg.x2) / 2 - p.x;
            const dy = (seg.y1 + seg.y2) / 2 - p.y;
            return Math.sqrt(dx*dx + dy*dy) > r;
        });
        drawAnnotations(curPage);
    } else {
        const seg = { x1: lastX, y1: lastY, x2: p.x, y2: p.y, color: drawColor, size: drawSize };
        if (!annotations[curPage]) annotations[curPage] = [];
        annotations[curPage].push(seg);
        // Draw just this segment
        const ctx = $('annot-canvas').getContext('2d');
        ctx.beginPath();
        ctx.strokeStyle = seg.color; ctx.lineWidth = seg.size; ctx.lineCap = 'round';
        ctx.moveTo(seg.x1, seg.y1); ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
    }
    lastX = p.x; lastY = p.y;
}

function endDraw() { drawing = false; }

// ===== Sections =====
function addSection(name, page) {
    if (!name.trim()) return;
    sections.push({ name: name.trim(), page });
    sections.sort((a, b) => a.page - b.page);
    renderSectionList();
    toast('✅ セクション追加: ' + name + ' (p.' + page + ')');
}

function renderSectionList() {
    const list = $('section-list');
    if (sections.length === 0) {
        list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px;text-align:center">セクションなし</div>';
        return;
    }
    list.innerHTML = sections.map((s, i) => `
        <div class="section-item${s.page === curPage ? ' active' : ''}" data-page="${s.page}">
            <span style="font-size:14px">${getSectionIcon(s.name)}</span>
            <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</span>
            <span class="section-page">p.${s.page}</span>
            <button class="section-del" data-idx="${i}" title="削除">✕</button>
        </div>
    `).join('');

    list.querySelectorAll('.section-item').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.classList.contains('section-del')) return;
            goToPage(parseInt(el.dataset.page));
        });
    });
    list.querySelectorAll('.section-del').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            sections.splice(parseInt(btn.dataset.idx), 1);
            renderSectionList();
        });
    });
}

function getSectionIcon(name) {
    const n = name.toLowerCase();
    if (n.includes('イントロ') || n.includes('intro')) return '🎬';
    if (n.includes('サビ') || n.includes('chorus')) return '⭐';
    if (n.includes('ソロ') || n.includes('solo')) return '🎸';
    if (n.includes('アウトロ') || n.includes('outro')) return '🏁';
    if (n.includes('ブリッジ') || n.includes('bridge')) return '🌉';
    if (n.includes('コーダ') || n.includes('coda')) return '🔚';
    return '📌';
}

function updateSectionHighlight() {
    document.querySelectorAll('.section-item').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.page) === curPage);
    });
}

// ===== Audio Context =====
function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ===== Metronome =====
function setupBeatRow() {
    const row = $('beat-row');
    row.innerHTML = '';
    for (let i = 0; i < metroBeats; i++) {
        const d = document.createElement('div');
        d.className = 'beat-dot' + (i === 0 ? ' accent' : '');
        d.id = 'mbd-' + i;
        row.appendChild(d);
    }
    totalBeats = metroBeats * measPerPage;
    warnBeats  = metroBeats;  // warn for last measure
}

function scheduleBeat() {
    while (metroNext < audioCtx.currentTime + AHEAD) {
        const beat = metroBeat, isAcc = beat === 0, t = metroNext;

        // Sound
        const osc = audioCtx.createOscillator();
        const env = audioCtx.createGain();
        osc.connect(env); env.connect(audioCtx.destination);
        osc.frequency.value = isAcc ? 1200 : 900;
        env.gain.setValueAtTime(isAcc ? 0.85 : 0.5, t);
        env.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
        osc.start(t); osc.stop(t + 0.1);

        // Auto-turn logic
        if (autoActive) {
            beatCounter++;
            const beatsLeft = totalBeats - (beatCounter % totalBeats || totalBeats);
            const delay = Math.max(0, (t - audioCtx.currentTime) * 1000);

            // Update countdown display
            setTimeout(() => {
                $('beats-left-disp').textContent = beatsLeft;
                // Countdown overlay
                const overlay = $('countdown-overlay');
                if (beatsLeft <= warnBeats && beatsLeft > 0) {
                    overlay.textContent = beatsLeft;
                    overlay.style.opacity = '1';
                    overlay.style.color =
                        beatsLeft === 1 ? 'rgba(239,68,68,0.95)' :
                        beatsLeft === 2 ? 'rgba(249,115,22,0.9)' : 'rgba(167,139,250,0.85)';
                } else {
                    overlay.style.opacity = '0';
                }
            }, delay);

            // Page turn
            if (beatCounter % totalBeats === 0) {
                setTimeout(() => {
                    if (curPage < totalPages) {
                        goToPage(curPage + 1);
                        toast('📖 ページめくり → p.' + (curPage));
                    } else {
                        // End of score
                        stopAutoTurn();
                        toast('🏁 最終ページに到達しました');
                    }
                    $('countdown-overlay').style.opacity = '0';
                }, delay + 50);
            }
        }

        // Visual beat
        const b = beat;
        setTimeout(() => {
            document.querySelectorAll('.beat-dot').forEach(d => {
                d.classList.remove('active');
                if (autoActive) {
                    const rem = totalBeats - (beatCounter % totalBeats || totalBeats);
                    d.classList.toggle('warn', rem <= warnBeats && rem > 0);
                } else {
                    d.classList.remove('warn');
                }
            });
            const dot = $('mbd-' + b);
            if (dot) dot.classList.add('active');
        }, Math.max(0, (t - audioCtx.currentTime) * 1000));

        metroNext += 60.0 / metroBpm;
        metroBeat = (metroBeat + 1) % metroBeats;
    }
}

function startMetro() {
    initAudio();
    metroActive = true; metroBeat = 0;
    metroNext = audioCtx.currentTime + 0.05;
    metroTimer = setInterval(scheduleBeat, LOOK_MS);
    $('metro-btn').textContent = '⏹ 停止';
    $('metro-btn').classList.add('active');
    $('metro-dot').classList.add('on');
}

function stopMetro() {
    metroActive = false;
    clearInterval(metroTimer);
    document.querySelectorAll('.beat-dot').forEach(d => {
        d.classList.remove('active', 'warn');
    });
    $('metro-btn').textContent = '▶ 開始';
    $('metro-btn').classList.remove('active');
    $('metro-dot').classList.remove('on');
    if (!autoActive) { stopAutoTurn(); }
}

function toggleMetro() {
    initAudio();
    metroActive ? stopMetro() : startMetro();
}

// ===== Auto Page Turn =====
function startAutoTurn() {
    if (!pdfDoc) { toast('先にPDFを読み込んでください'); return; }
    measPerPage = parseInt($('mpp-input').value) || 4;
    totalBeats  = metroBeats * measPerPage;
    warnBeats   = metroBeats;
    beatCounter = 0;
    autoActive  = true;
    $('autoturn-btn').textContent = '⏹ 停止';
    $('autoturn-btn').classList.add('active');
    $('autoturn-dot').classList.add('on');
    $('beats-left-disp').textContent = totalBeats;
    if (!metroActive) startMetro();
    toast('▶ 自動めくり開始 (' + measPerPage + '小節/ページ)', 2500);
}

function stopAutoTurn() {
    autoActive = false;
    beatCounter = 0;
    $('autoturn-btn').textContent = '▶ 自動めくり';
    $('autoturn-btn').classList.remove('active');
    $('autoturn-dot').classList.remove('on');
    $('beats-left-disp').textContent = '—';
    $('countdown-overlay').style.opacity = '0';
}

function resetTurn() {
    beatCounter = 0;
    $('beats-left-disp').textContent = autoActive ? totalBeats : '—';
    $('countdown-overlay').style.opacity = '0';
}

// ===== Tap Tempo =====
function tapTempo() {
    initAudio();
    const now = Date.now();
    tapTimes.push(now);
    if (tapTimes.length > 8) tapTimes.shift();
    if (tapTimes.length >= 2) {
        let sum = 0;
        for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i-1];
        metroBpm = Math.round(Math.max(40, Math.min(240, 60000 / (sum / (tapTimes.length - 1)))));
        $('bpm-slider').value  = metroBpm;
        $('bpm-disp').textContent = metroBpm;
        if (metroActive) { stopMetro(); startMetro(); }
    }
    clearTimeout(tapTimes._tid);
    tapTimes._tid = setTimeout(() => { tapTimes = []; }, 2500);
}

// ===== Event Listeners =====
document.addEventListener('DOMContentLoaded', () => {
    setupBeatRow();

    // PDF load
    $('pdf-input').addEventListener('change', e => {
        if (e.target.files[0]) loadPDF(e.target.files[0]);
        e.target.value = '';
    });

    // Drag & drop onto canvas area
    const ca = $('canvas-area');
    ca.addEventListener('dragover', e => e.preventDefault());
    ca.addEventListener('drop', e => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) loadPDF(f);
    });

    // Page navigation
    $('prev-btn').addEventListener('click', () => goToPage(curPage - 1));
    $('next-btn').addEventListener('click', () => goToPage(curPage + 1));
    $('goto-btn').addEventListener('click', () => {
        const v = parseInt($('goto-input').value);
        if (!isNaN(v)) goToPage(v);
    });
    $('goto-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { const v = parseInt(e.target.value); if (!isNaN(v)) goToPage(v); }
    });

    // Zoom
    $('zoom-out-btn').addEventListener('click', () => setZoom(scale - 0.2));
    $('zoom-in-btn').addEventListener('click',  () => setZoom(scale + 0.2));
    $('zoom-fit-btn').addEventListener('click', fitToWindow);

    // Drawing
    const ac = $('annot-canvas');
    ac.addEventListener('mousedown',  startDraw);
    ac.addEventListener('mousemove',  moveDraw);
    ac.addEventListener('mouseup',    endDraw);
    ac.addEventListener('mouseleave', endDraw);
    ac.addEventListener('touchstart', startDraw, { passive: false });
    ac.addEventListener('touchmove',  moveDraw,  { passive: false });
    ac.addEventListener('touchend',   endDraw);

    // Draw toolbar
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            drawColor  = btn.dataset.color;
            eraseMode  = false;
            $('erase-btn').classList.remove('active');
        });
    });
    $('pen-size').addEventListener('input', e => { drawSize = parseInt(e.target.value); });
    $('erase-btn').addEventListener('click', () => {
        eraseMode = !eraseMode;
        $('erase-btn').classList.toggle('active', eraseMode);
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    });
    $('clear-ann-btn').addEventListener('click', () => {
        if (confirm(curPage + 'ページの書き込みをすべて消去しますか？')) {
            annotations[curPage] = [];
            drawAnnotations(curPage);
        }
    });

    // Sidebar toggle
    $('sidebar-toggle-btn').addEventListener('click', () => {
        $('sidebar').classList.toggle('collapsed');
    });

    // Fullscreen
    $('fullscreen-btn').addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            $('fullscreen-btn').textContent = '✕ 全画面解除';
        } else {
            document.exitFullscreen();
            $('fullscreen-btn').textContent = '⛶ 全画面';
        }
    });

    // Section
    $('add-section-btn').addEventListener('click', () => {
        if (!pdfDoc) { toast('先にPDFを読み込んでください'); return; }
        const name = $('section-name-input').value;
        if (!name.trim()) { toast('セクション名を入力してください'); return; }
        addSection(name, curPage);
        $('section-name-input').value = '';
    });
    $('section-name-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') $('add-section-btn').click();
    });

    // Metronome
    $('metro-btn').addEventListener('click', toggleMetro);
    $('tap-btn').addEventListener('click', tapTempo);
    $('bpm-slider').addEventListener('input', e => {
        metroBpm = parseInt(e.target.value);
        $('bpm-disp').textContent = metroBpm;
        if (metroActive) { stopMetro(); startMetro(); }
    });
    $('timesig-sel').addEventListener('change', e => {
        metroBeats = parseInt(e.target.value);
        setupBeatRow();
        if (metroActive) { stopMetro(); startMetro(); }
    });

    // Auto page turn
    $('autoturn-btn').addEventListener('click', () => {
        autoActive ? stopAutoTurn() : startAutoTurn();
    });
    $('reset-turn-btn').addEventListener('click', resetTurn);
    $('mpp-input').addEventListener('change', () => {
        measPerPage = parseInt($('mpp-input').value) || 4;
        totalBeats  = metroBeats * measPerPage;
        beatCounter = 0;
        $('beats-left-disp').textContent = autoActive ? totalBeats : '—';
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        switch (e.key) {
            case 'ArrowRight': case 'ArrowDown':
                e.preventDefault(); if (pdfDoc) goToPage(curPage + 1); break;
            case 'ArrowLeft': case 'ArrowUp':
                e.preventDefault(); if (pdfDoc) goToPage(curPage - 1); break;
            case ' ':
                e.preventDefault(); toggleMetro(); break;
            case '+': case '=':
                setZoom(scale + 0.15); break;
            case '-':
                setZoom(scale - 0.15); break;
            case 'f': case 'F':
                $('fullscreen-btn').click(); break;
            case 'a': case 'A':
                $('autoturn-btn').click(); break;
        }
    });
});
