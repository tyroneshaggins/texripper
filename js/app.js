/* TexRipper — application
 * Plain browser JS. Runs from file:// with no build step.
 */
(function () {
  'use strict';

  const G = window.Geo;
  const SL = window.Seamless;
  const clamp = G.clamp;
  const $ = (id) => document.getElementById(id);

  const PALETTE = ['#ff6fc4', '#6fe4ff', '#ffe066', '#8affa1', '#b18cff', '#ffa15c'];
  const MIN_SIZE = 8;
  const MAX_SIZE = 2048;
  const MAX_SRC = 4096;
  const LIVE_PIXEL_BUDGET = 700000;

  const state = {
    image: null,                 // {canvas, width, height, data, name}
    rippers: [],
    selectedId: null,
    nextId: 1,
    view: { scale: 1, x: 0, y: 0 },
    atlasSize: 1024,
    atlasAuto: true,
    atlasView: { zoom: 1, px: 0, py: 0 },
    tiling: { zoom: 1, x: 0, y: 0 },
    drag: null,
    mouse: null,
    space: false,
    undo: [],
    redo: [],
    stash: null,
    pending: new Set(),
    procQueued: false,
    renderQueued: false,
  };

  const el = {};
  let atlasDrag = null;
  let tilingDrag = null;
  let dragDepth = 0;

  /* ============================================================
   * Boot
   * ============================================================ */

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    const ids = [
      'app', 'viewCanvas', 'previewCanvas', 'previewBox', 'previewSize', 'tilingCanvas', 'tilingBox',
      'atlasCanvas', 'atlasWrap', 'atlasPanel', 'atlasInfo', 'atlasSizeSel', 'btnAutoPack',
      'btnExportAtlas', 'btnExportAll', 'btnCollapseAtlas', 'btnOpen', 'btnPaste', 'btnSave', 'btnLoad', 'btnUndo',
      'btnRedo', 'btnHelp', 'btnDemo', 'btnRotate', 'sourceInfo', 'btnAddRipper', 'ripperCount',
      'ripperList', 'ripperSettings', 'ripName', 'outW', 'outH', 'lockAspect', 'btnMatchPoly',
      'hudInfo', 'btnZoomOut', 'btnZoomFit', 'btnZoom100', 'btnZoomIn', 'dropzone', 'status',
      'helpModal', 'btnCloseHelp', 'smGroup', 'smEnabled', 'smMethod', 'smBand', 'smBandOut',
      'smContrast', 'smContrastOut', 'smBrightness', 'smBrightnessOut', 'smSharpen', 'smSharpenOut',
      'btnSmReset', 'btnExportSelected', 'fileInput', 'projectInput', 'sourceInfo'
    ];
    ids.forEach((id) => { el[id] = $(id); });

    buildEmptyState();
    bindUI();
    bindViewport();
    bindAtlas();
    bindTiling();
    bindSeamlessControls();
    bindDropAndPaste();
    bindKeys();

    const ro = new ResizeObserver(() => renderAll());
    [el.viewCanvas.parentElement, el.previewBox, el.tilingBox, el.atlasWrap].forEach((node) => ro.observe(node));
    window.addEventListener('resize', () => { fitCanvasSizes(); renderAll(); });

    fitCanvasSizes();
    refreshUI();
    renderAll();
    toast('Ready — open an image, or press Demo Image to try it.');
  }

  function buildEmptyState() {
    el.previewSize.textContent = '';
    el.atlasInfo.textContent = 'empty';
  }

  /* ============================================================
   * Canvas helpers
   * ============================================================ */

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  function fitCanvasSizes() {
    // Just re-render; begin() resizes each canvas from its CSS box.
    renderAll();
  }

  function begin(canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w < 2 || h < 2) return null;
    const d = dpr();
    const pw = Math.round(w * d);
    const ph = Math.round(h * d);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, d };
  }

  function canvasPoint(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ============================================================
   * Rendering
   * ============================================================ */

  function renderAll() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderView();
      renderPreview();
      renderTiling();
      renderAtlas();
      updateHUD();
      updateUndoButtons();
    });
  }

  function toScreen(p) {
    return { x: p.x * state.view.scale + state.view.x, y: p.y * state.view.scale + state.view.y };
  }

  function toImage(sp) {
    return { x: (sp.x - state.view.x) / state.view.scale, y: (sp.y - state.view.y) / state.view.scale };
  }

  function renderView() {
    const box = begin(el.viewCanvas);
    if (!box) return;
    const { ctx, w, h } = box;

    if (!state.image) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,111,196,.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(28.5, 28.5, w - 57, h - 57);
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(233,230,247,.85)';
      ctx.font = '700 16px monospace';
      ctx.fillText('NO IMAGE LOADED', w / 2, h / 2 - 12);
      ctx.fillStyle = 'rgba(157,152,187,.9)';
      ctx.font = '11px monospace';
      ctx.fillText('Open an image  ·  drop a file  ·  Ctrl+V', w / 2, h / 2 + 10);
      ctx.fillStyle = 'rgba(255,111,196,.9)';
      ctx.font = '10px monospace';
      ctx.fillText('or click "Demo Image" to try it out', w / 2, h / 2 + 32);
      ctx.restore();
      return;
    }

    const img = state.image;
    const v = state.view;

    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.scale, v.scale);
    ctx.imageSmoothingEnabled = v.scale < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.canvas, 0, 0);
    ctx.restore();

    // image frame
    const ix = v.x, iy = v.y, iw = img.width * v.scale, ih = img.height * v.scale;
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(ix) + 0.5, Math.round(iy) + 0.5, Math.round(iw) - 1, Math.round(ih) - 1);

    for (const r of state.rippers) drawRipperOverlay(ctx, r, w, h);

    if (state.drag && state.drag.type === 'point' && state.mouse) {
      const r = state.drag.ripper;
      const p = r.points[state.drag.index];
      if (p) {
        const label = `${Math.round(p.x)}, ${Math.round(p.y)}`;
        drawChip(ctx, label, state.mouse.x + 14, state.mouse.y + 18);
      }
    }
  }

  function drawRipperOverlay(ctx, r, vw, vh) {
    if (!r.points || r.points.length < 2) return;
    const selected = r.id === state.selectedId;
    const pts = r.points.map(toScreen);
    const b = G.bbox(pts);
    if (b.x1 < -40 || b.y1 < -40 || b.x0 > vw + 40 || b.y0 > vh + 40) return;

    ctx.save();

    // polygon
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = hexA(r.color, selected ? 0.16 : 0.07);
    ctx.fill();
    ctx.lineJoin = 'miter';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? r.color : hexA(r.color, 0.55);
    ctx.stroke();

    // edge midpoint add-point markers (selected)
    if (selected && !state.drag) {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b2 = pts[(i + 1) % pts.length];
        const mx = (a.x + b2.x) / 2, my = (a.y + b2.y) / 2;
        ctx.strokeStyle = 'rgba(255,255,255,.42)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx - 3, my); ctx.lineTo(mx + 3, my);
        ctx.moveTo(mx, my - 3); ctx.lineTo(mx, my + 3);
        ctx.stroke();
      }
    }

    // vertices
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const big = selected || (state.drag && state.drag.ripper === r);
      const s = big ? 9 : 6;
      ctx.fillStyle = selected ? r.color : '#e9e6f7';
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
      ctx.strokeStyle = '#0a0910';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(p.x - s / 2) + 0.5, Math.round(p.y - s / 2) + 0.5, s - 1, s - 1);
      if (selected) {
        ctx.fillStyle = 'rgba(10,9,16,.9)';
        ctx.font = '700 8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), p.x, p.y + 0.5);
      }
    }

    // name tag
    if (selected || state.rippers.length <= 6) {
      const label = `${r.name}  ${r.outW}×${r.outH}`;
      const tx = clamp(Math.round(b.x0), 4, vw - 4);
      const ty = clamp(Math.round(b.y0) - 8, 12, vh - 4);
      ctx.font = '700 9px monospace';
      const tw = ctx.measureText(label).width + 10;
      let lx = clamp(tx, 2, vw - tw - 2);
      const ly = ty - 12;
      ctx.fillStyle = selected ? 'rgba(20,12,22,.92)' : 'rgba(10,9,16,.72)';
      ctx.fillRect(lx, ly, tw, 13);
      ctx.strokeStyle = selected ? r.color : hexA(r.color, 0.5);
      ctx.lineWidth = 1;
      ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 12);
      ctx.fillStyle = selected ? '#fff' : 'rgba(233,230,247,.78)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 5, ly + 7);
    }

    ctx.restore();
  }

  function drawChip(ctx, text, x, y) {
    ctx.save();
    ctx.font = '700 9px monospace';
    const tw = ctx.measureText(text).width + 10;
    const tx = clamp(x, 2, el.viewCanvas.clientWidth - tw - 2);
    const ty = clamp(y, 2, el.viewCanvas.clientHeight - 16);
    ctx.fillStyle = 'rgba(10,9,16,.92)';
    ctx.fillRect(tx, ty, tw, 14);
    ctx.strokeStyle = 'rgba(255,111,196,.8)';
    ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, 13);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, tx + 5, ty + 7);
    ctx.restore();
  }

  function hexA(hex, a) {
    if (!hex || hex[0] !== '#') return `rgba(255,255,255,${a})`;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function renderPreview() {
    const box = begin(el.previewCanvas);
    if (!box) return;
    const { ctx, w, h } = box;
    const r = selected();

    if (!r || !r.canvas) {
      ctx.fillStyle = 'rgba(157,152,187,.55)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(r ? 'OUTPUT TOO SMALL' : 'SELECT A RIPPER', w / 2, h / 2);
      el.previewSize.textContent = r ? '' : '—';
      return;
    }

    const scale = Math.min(w / r.canvas.width, h / r.canvas.height);
    const dw = r.canvas.width * scale;
    const dh = r.canvas.height * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(r.canvas, dx, dy, dw, dh);
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(dx) + 0.5, Math.round(dy) + 0.5, Math.round(dw) - 1, Math.round(dh) - 1);
    el.previewSize.textContent = `${r.canvas.width}×${r.canvas.height}`;
  }

  function renderTiling() {
    const box = begin(el.tilingCanvas);
    if (!box) return;
    const { ctx, w, h } = box;
    const r = selected();

    if (!r || !r.canvas) {
      ctx.fillStyle = 'rgba(157,152,187,.55)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO TEXTURE', w / 2, h / 2);
      return;
    }

    const texAspect = r.canvas.width / r.canvas.height;
    const base = Math.max(40, Math.min(w / 2.3, h / 1.5));
    let tw, th;
    if (texAspect >= 1) { tw = base; th = base / texAspect; }
    else { th = base; tw = base * texAspect; }
    tw *= state.tiling.zoom;
    th *= state.tiling.zoom;

    const ox = w / 2 - tw / 2 + state.tiling.x;
    const oy = h / 2 - th / 2 + state.tiling.y;

    ctx.save();
    ctx.imageSmoothingEnabled = tw < r.canvas.width;
    const i0 = Math.floor(-ox / tw) - 1;
    const i1 = Math.ceil((w - ox) / tw) + 1;
    const j0 = Math.floor(-oy / th) - 1;
    const j1 = Math.ceil((h - oy) / th) + 1;
    const maxTiles = 600;
    let count = 0;
    for (let j = j0; j <= j1 && count < maxTiles; j++) {
      for (let i = i0; i <= i1 && count < maxTiles; i++, count++) {
        ctx.drawImage(r.canvas, ox + i * tw, oy + j * th, tw, th);
      }
    }
    ctx.restore();

    // center tile outline
    ctx.strokeStyle = 'rgba(255,111,196,.65)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(ox) + 0.5, Math.round(oy) + 0.5, Math.round(tw) - 1, Math.round(th) - 1);
    ctx.setLineDash([]);
  }

  function atlasTransform(w, h) {
    const base = Math.min(w, h) / state.atlasSize * 0.94;
    const scale = base * state.atlasView.zoom;
    return {
      scale,
      ox: (w - state.atlasSize * scale) / 2 + state.atlasView.px,
      oy: (h - state.atlasSize * scale) / 2 + state.atlasView.py,
    };
  }

  function renderAtlas() {
    const box = begin(el.atlasCanvas);
    if (!box) return;
    const { ctx, w, h } = box;
    const t = atlasTransform(w, h);
    const sizePx = state.atlasSize * t.scale;

    // atlas plate
    ctx.save();
    ctx.fillStyle = 'rgba(8,7,12,.45)';
    ctx.fillRect(t.ox, t.oy, sizePx, sizePx);
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(t.ox) + 0.5, Math.round(t.oy) + 0.5, Math.round(sizePx) - 1, Math.round(sizePx) - 1);

    // grid ticks
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    const step = state.atlasSize / 8;
    for (let i = 1; i < 8; i++) {
      const gx = Math.round(t.ox + i * step * t.scale) + 0.5;
      const gy = Math.round(t.oy + i * step * t.scale) + 0.5;
      ctx.beginPath(); ctx.moveTo(gx, t.oy); ctx.lineTo(gx, t.oy + sizePx); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(t.ox, gy); ctx.lineTo(t.ox + sizePx, gy); ctx.stroke();
    }

    ctx.imageSmoothingEnabled = t.scale < 1.5;
    let placed = 0;
    let used = 0;
    for (const r of state.rippers) {
      if (!r.canvas || !r.atlas) continue;
      placed++;
      used += r.atlas.w * r.atlas.h;
      const x = t.ox + r.atlas.x * t.scale;
      const y = t.oy + r.atlas.y * t.scale;
      const dw = r.atlas.w * t.scale;
      const dh = r.atlas.h * t.scale;
      ctx.drawImage(r.canvas, x, y, dw, dh);
      ctx.strokeStyle = r.id === state.selectedId ? r.color : 'rgba(0,0,0,.55)';
      ctx.lineWidth = r.id === state.selectedId ? 2 : 1;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(dw) - 1, Math.round(dh) - 1);
      if (r.id === state.selectedId) {
        const label = `${r.name} ${r.atlas.w}×${r.atlas.h}`;
        ctx.font = '700 9px monospace';
        const tw = ctx.measureText(label).width + 8;
        let lx = clamp(x, t.ox + 2, t.ox + sizePx - tw - 2);
        let ly = y - 14;
        if (ly < t.oy + 2) ly = y + dh + 2;
        ctx.fillStyle = 'rgba(10,9,16,.92)';
        ctx.fillRect(lx, ly, tw, 12);
        ctx.fillStyle = r.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + 4, ly + 6.5);
      }
    }
    ctx.restore();

    if (!placed) {
      ctx.fillStyle = 'rgba(157,152,187,.5)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(state.image ? 'NO TEXTURES YET — ADD A RIPPER' : 'LOAD AN IMAGE TO BEGIN', w / 2, h / 2);
    }

    const pct = Math.round((used / (state.atlasSize * state.atlasSize)) * 100);
    el.atlasInfo.textContent = placed
      ? `${state.atlasSize}×${state.atlasSize} · ${placed} tex · ${pct}% used`
      : `${state.atlasSize}×${state.atlasSize}`;
  }

  function updateHUD() {
    if (!state.image) {
      el.hudInfo.textContent = 'no image';
      return;
    }
    const img = state.image;
    let txt = `${img.width}×${img.height} · ${Math.round(state.view.scale * 100)}%`;
    if (state.mouse) {
      const ip = toImage(state.mouse);
      if (ip.x >= 0 && ip.y >= 0 && ip.x <= img.width && ip.y <= img.height) {
        txt += ` · ${Math.floor(ip.x)}, ${Math.floor(ip.y)}`;
      }
    }
    const r = selected();
    if (r) txt += ` · ${r.name} ${r.outW}×${r.outH}`;
    el.hudInfo.textContent = txt;
  }

  /* ============================================================
   * Viewport interaction
   * ============================================================ */

  function bindViewport() {
    const c = el.viewCanvas;
    c.addEventListener('pointerdown', onViewDown);
    c.addEventListener('pointermove', onViewMove);
    c.addEventListener('pointerup', onViewUp);
    c.addEventListener('pointercancel', onViewUp);
    c.addEventListener('pointerleave', () => {
      if (!state.drag) { state.mouse = null; updateHUD(); }
    });
    c.addEventListener('wheel', onViewWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', () => { if (state.image) fitView(); });
  }

  function hitHandle(sp) {
    const R = 10;
    for (let i = state.rippers.length - 1; i >= 0; i--) {
      const r = state.rippers[i];
      for (let j = 0; j < r.points.length; j++) {
        const p = toScreen(r.points[j]);
        const dx = p.x - sp.x, dy = p.y - sp.y;
        if (dx * dx + dy * dy <= R * R) return { ripper: r, index: j };
      }
    }
    return null;
  }

  function hitMidpoint(sp) {
    const r = selected();
    if (!r) return null;
    for (let i = 0; i < r.points.length; i++) {
      const a = toScreen(r.points[i]);
      const b = toScreen(r.points[(i + 1) % r.points.length]);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = mx - sp.x, dy = my - sp.y;
      if (dx * dx + dy * dy <= 81) return { ripper: r, index: i };
    }
    return null;
  }

  function hitRipper(ip) {
    for (let i = state.rippers.length - 1; i >= 0; i--) {
      const r = state.rippers[i];
      if (G.pointInPoly(ip.x, ip.y, r.points)) return r;
    }
    return null;
  }

  function onViewDown(e) {
    const sp = canvasPoint(el.viewCanvas, e);

    if (e.button === 1 || (e.button === 0 && state.space)) {
      state.drag = { type: 'pan', start: sp, view: { ...state.view } };
      el.viewCanvas.setPointerCapture(e.pointerId);
      setCursor('grabbing');
      e.preventDefault();
      return;
    }

    if (!state.image) {
      if (e.button === 0) el.fileInput.click();
      return;
    }

    if (e.button === 2) {
      const h = hitHandle(sp);
      if (h && h.ripper.points.length > 4) {
        const before = snapshot();
        h.ripper.points.splice(h.index, 1);
        selectRipper(h.ripper.id);
        queueProcess(h.ripper);
        pushSnapshot(before);
        renderAll();
        toast(`Removed point from ${h.ripper.name}.`);
      }
      return;
    }

    if (e.button !== 0) return;

    const h = hitHandle(sp);
    if (h) {
      selectRipper(h.ripper.id);
      startPointDrag(h.ripper, h.index, sp);
      el.viewCanvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.altKey) {
      const mid = hitMidpoint(sp);
      if (mid) {
        const before = snapshot();
        const r = mid.ripper;
        const a = r.points[mid.index];
        const b = r.points[(mid.index + 1) % r.points.length];
        const p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        r.points.splice(mid.index + 1, 0, p);
        selectRipper(r.id);
        queueProcess(r);
        pushSnapshot(before);
        // immediately drag the new point
        startPointDrag(r, mid.index + 1, sp);
        el.viewCanvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    const ip = toImage(sp);
    const r = hitRipper(ip);
    if (r) {
      selectRipper(r.id);
      startMoveDrag(r, sp, e);
      el.viewCanvas.setPointerCapture(e.pointerId);
      return;
    }

    if (state.selectedId != null) {
      state.selectedId = null;
      refreshUI();
      renderAll();
    }
  }

  function startPointDrag(r, index, sp) {
    state.drag = {
      type: 'point',
      ripper: r,
      index,
      start: toImage(sp),
      points: r.points.map((p) => ({ ...p })),
      snapshot: snapshot(),
      moved: false,
    };
    setCursor('grabbing');
  }

  function startMoveDrag(r, sp, e) {
    state.drag = {
      type: 'move',
      ripper: r,
      start: toImage(sp),
      points: r.points.map((p) => ({ ...p })),
      snapshot: snapshot(),
      moved: false,
    };
    setCursor('grabbing');
  }

  function onViewMove(e) {
    const sp = canvasPoint(el.viewCanvas, e);
    state.mouse = sp;
    const d = state.drag;

    if (d && d.type === 'pan') {
      state.view.x = d.view.x + (sp.x - d.start.x);
      state.view.y = d.view.y + (sp.y - d.start.y);
      renderAll();
      return;
    }

    if (d && (d.type === 'point' || d.type === 'move')) {
      const ip = toImage(sp);
      let dx = ip.x - d.start.x;
      let dy = ip.y - d.start.y;
      if (e.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
      }
      const r = d.ripper;
      const img = state.image;
      if (!img) return;

      if (d.type === 'point') {
        const base = d.points[d.index];
        let nx = base.x + dx;
        let ny = base.y + dy;
        if (e.ctrlKey) { nx = Math.round(nx); ny = Math.round(ny); }
        r.points[d.index] = {
          x: clamp(nx, 0, img.width),
          y: clamp(ny, 0, img.height),
        };
      } else {
        const b = G.bbox(d.points);
        if (b.x0 + dx < 0) dx = -b.x0;
        if (b.x1 + dx > img.width) dx = img.width - b.x1;
        if (b.y0 + dy < 0) dy = -b.y0;
        if (b.y1 + dy > img.height) dy = img.height - b.y1;
        for (let i = 0; i < r.points.length; i++) {
          r.points[i] = { x: d.points[i].x + dx, y: d.points[i].y + dy };
        }
      }

      d.moved = true;
      const budget = r.outW * r.outH;
      if (budget <= LIVE_PIXEL_BUDGET) queueProcess(r);
      renderAll();
      return;
    }

    // hover cursor
    if (!state.space) {
      const h = hitHandle(sp);
      if (h) setCursor('grab');
      else if (state.image && hitRipper(toImage(sp))) setCursor('move');
      else setCursor('default');
    }
    updateHUD();
  }

  function onViewUp(e) {
    const d = state.drag;
    if (!d) return;
    if (d.type === 'point' || d.type === 'move') {
      if (d.moved) {
        pushSnapshot(d.snapshot);
        queueProcess(d.ripper);
        if (d.ripper.outW * d.ripper.outH > LIVE_PIXEL_BUDGET) {
          toast('Large texture: processing on release. Wait a moment.');
        }
      }
    }
    state.drag = null;
    if (el.viewCanvas.hasPointerCapture(e.pointerId)) el.viewCanvas.releasePointerCapture(e.pointerId);
    setCursor(state.space ? 'grab' : 'default');
    renderAll();
  }

  function onViewWheel(e) {
    if (!state.image) return;
    e.preventDefault();
    const sp = canvasPoint(el.viewCanvas, e);
    const before = toImage(sp);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = clamp(state.view.scale * factor, 0.02, 64);
    state.view.scale = next;
    state.view.x = sp.x - before.x * next;
    state.view.y = sp.y - before.y * next;
    renderAll();
  }

  function setCursor(c) {
    el.viewCanvas.style.cursor = c;
  }

  function fitView() {
    if (!state.image) return;
    const rect = el.viewCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w < 2 || h < 2) return;
    const pad = 44;
    const img = state.image;
    const s = clamp(Math.min((w - pad) / img.width, (h - pad) / img.height), 0.02, 8);
    state.view.scale = s;
    state.view.x = (w - img.width * s) / 2;
    state.view.y = (h - img.height * s) / 2;
    renderAll();
  }

  function zoomBy(factor) {
    if (!state.image) return;
    const rect = el.viewCanvas.getBoundingClientRect();
    const sp = { x: rect.width / 2, y: rect.height / 2 };
    const before = toImage(sp);
    const next = clamp(state.view.scale * factor, 0.02, 64);
    state.view.scale = next;
    state.view.x = sp.x - before.x * next;
    state.view.y = sp.y - before.y * next;
    renderAll();
  }

  function zoom100() {
    if (!state.image) return;
    const rect = el.viewCanvas.getBoundingClientRect();
    const before = toImage({ x: rect.width / 2, y: rect.height / 2 });
    state.view.scale = 1;
    state.view.x = rect.width / 2 - before.x;
    state.view.y = rect.height / 2 - before.y;
    renderAll();
  }

  /* ============================================================
   * Ripper model
   * ============================================================ */

  function selected() {
    return state.rippers.find((r) => r.id === state.selectedId) || null;
  }

  function selectRipper(id) {
    if (state.selectedId === id) { renderAll(); return; }
    state.selectedId = id;
    refreshUI();
    renderAll();
  }

  function nextRipperName() {
    let i = 1;
    const used = new Set(state.rippers.map((r) => r.name));
    while (used.has('RIP_' + String(i).padStart(2, '0'))) i++;
    return 'RIP_' + String(i).padStart(2, '0');
  }

  function suggestSize(pts) {
    const b = G.bbox(pts);
    const target = clamp(Math.max(b.w, b.h), 32, 512);
    const aspect = b.w / Math.max(1, b.h);
    let w, h;
    if (aspect >= 1) { w = target; h = Math.max(MIN_SIZE, Math.round(target / aspect)); }
    else { h = target; w = Math.max(MIN_SIZE, Math.round(target * aspect)); }
    return { w: Math.round(w), h: Math.round(h) };
  }

  function addRipper() {
    if (!state.image) {
      toast('Load an image first.', 'warn');
      return null;
    }
    const img = state.image;
    const rect = el.viewCanvas.getBoundingClientRect();
    const c = toImage({ x: rect.width / 2, y: rect.height / 2 });
    const half = Math.max(16, Math.min(img.width, img.height) * 0.2);
    const cx = clamp(c.x, half, Math.max(half, img.width - half));
    const cy = clamp(c.y, half, Math.max(half, img.height - half));
    const pts = [
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx + half, y: cy + half },
      { x: cx - half, y: cy + half },
    ];
    return createRipper(pts, nextRipperName());
  }

  function createRipper(pts, name) {
    const before = snapshot();
    const size = suggestSize(pts);
    const r = {
      id: state.nextId++,
      name: name || nextRipperName(),
      points: pts.map((p) => ({ ...p })),
      outW: size.w,
      outH: size.h,
      link: true,
      color: PALETTE[(state.rippers.length) % PALETTE.length],
      seamless: { enabled: true, method: 'mirror', band: 0.12, contrast: 0, brightness: 0, sharpen: 0 },
      canvas: null,
      atlas: null,
    };
    state.rippers.push(r);
    state.selectedId = r.id;
    processRipper(r);
    placeEntry(r);
    pushSnapshot(before);
    refreshUI();
    renderAll();
    return r;
  }

  function duplicateRipper() {
    const r = selected();
    if (!r) return;
    const before = snapshot();
    const copy = {
      ...r,
      id: state.nextId++,
      name: r.name + '_COPY',
      points: r.points.map((p) => ({ x: clamp(p.x + 12, 0, state.image.width), y: clamp(p.y + 12, 0, state.image.height) })),
      color: PALETTE[state.rippers.length % PALETTE.length],
      seamless: { ...r.seamless },
      canvas: null,
      atlas: null,
    };
    state.rippers.push(copy);
    state.selectedId = copy.id;
    processRipper(copy);
    placeEntry(copy);
    pushSnapshot(before);
    refreshUI();
    renderAll();
    toast('Duplicated ' + r.name + '.');
  }

  function removeRipper(id) {
    const idx = state.rippers.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const before = snapshot();
    const [r] = state.rippers.splice(idx, 1);
    if (state.selectedId === id) {
      state.selectedId = state.rippers.length ? state.rippers[Math.min(idx, state.rippers.length - 1)].id : null;
    }
    pushSnapshot(before);
    refreshUI();
    renderAll();
    toast('Deleted ' + r.name + '.');
  }

  /* ============================================================
   * Processing pipeline
   * ============================================================ */

  function queueProcess(r) {
    if (!r || !state.image) return;
    state.pending.add(r);
    if (state.procQueued) return;
    state.procQueued = true;
    requestAnimationFrame(() => {
      state.procQueued = false;
      const list = [...state.pending];
      state.pending.clear();
      for (const item of list) {
        if (state.rippers.includes(item)) processRipper(item);
      }
      renderAll();
    });
  }

  function processRipper(r) {
    if (!state.image || !r) return;
    if (!r.points || r.points.length < 3) { r.canvas = null; return; }
    const W = clamp(Math.round(r.outW) || 64, MIN_SIZE, MAX_SIZE);
    const H = clamp(Math.round(r.outH) || 64, MIN_SIZE, MAX_SIZE);
    r.outW = W;
    r.outH = H;

    let data = G.extract(state.image.data.data, state.image.width, state.image.height, r.points, W, H);
    if (r.seamless && r.seamless.enabled) {
      data = SL.process(data, {
        method: r.seamless.method,
        band: r.seamless.band,
        contrast: r.seamless.contrast,
        brightness: r.seamless.brightness,
        sharpen: r.seamless.sharpen,
      });
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').putImageData(data, 0, 0);
    r.canvas = canvas;

    if (!r.atlas) {
      placeEntry(r);
    } else {
      r.atlas.w = W;
      r.atlas.h = H;
    }
  }

  function processAll() {
    if (!state.image) return;
    for (const r of state.rippers) processRipper(r);
    renderAll();
  }

  /* ============================================================
   * Atlas packing
   * ============================================================ */

  const ATLAS_PAD = 2;

  function shelfPack(size) {
    const list = state.rippers.filter((r) => r.canvas).slice()
      .sort((a, b) => b.canvas.height - a.canvas.height);
    let x = ATLAS_PAD, y = ATLAS_PAD, rowH = 0;
    const map = new Map();
    for (const r of list) {
      const w = r.canvas.width;
      const h = r.canvas.height;
      if (w + ATLAS_PAD * 2 > size || h + ATLAS_PAD * 2 > size) return null;
      if (x + w + ATLAS_PAD > size) { x = ATLAS_PAD; y += rowH + ATLAS_PAD; rowH = 0; }
      if (y + h + ATLAS_PAD > size) return null;
      map.set(r, { x, y, w, h });
      x += w + ATLAS_PAD;
      rowH = Math.max(rowH, h);
    }
    return map;
  }

  function autoPack(manualSize) {
    const list = state.rippers.filter((r) => r.canvas);
    if (!list.length) {
      toast('No textures to pack.', 'warn');
      return false;
    }
    const sizes = state.atlasAuto ? [512, 1024, 2048, 4096] : [manualSize || state.atlasSize];
    for (const size of sizes) {
      const map = shelfPack(size);
      if (map) {
        state.atlasSize = size;
        map.forEach((pos, r) => { r.atlas = { x: pos.x, y: pos.y, w: pos.w, h: pos.h }; });
        el.atlasSizeSel.value = state.atlasAuto ? 'auto' : String(size);
        refreshAtlasControls();
        renderAll();
        return true;
      }
    }
    toast('Textures do not fit in a ' + state.atlasSize + 'px atlas. Reduce output sizes.', 'warn');
    return false;
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh, pad) {
    return ax < bx + bw + pad && ax + aw + pad > bx && ay < by + bh + pad && ay + ah + pad > by;
  }

  function placeEntry(r) {
    if (!r.canvas) return;
    const size = state.atlasSize;
    const w = r.canvas.width, h = r.canvas.height;
    const others = state.rippers.filter((o) => o !== r && o.atlas);
    const cands = [{ x: ATLAS_PAD, y: ATLAS_PAD }];
    for (const o of others) {
      cands.push({ x: o.atlas.x + o.atlas.w + ATLAS_PAD, y: ATLAS_PAD });
      cands.push({ x: ATLAS_PAD, y: o.atlas.y + o.atlas.h + ATLAS_PAD });
      cands.push({ x: o.atlas.x, y: o.atlas.y + o.atlas.h + ATLAS_PAD });
    }
    let best = null;
    for (const c of cands) {
      if (c.x < ATLAS_PAD || c.y < ATLAS_PAD) continue;
      if (c.x + w + ATLAS_PAD > size || c.y + h + ATLAS_PAD > size) continue;
      if (others.some((o) => rectsOverlap(c.x, c.y, w, h, o.atlas.x, o.atlas.y, o.atlas.w, o.atlas.h, ATLAS_PAD))) continue;
      if (!best || c.y < best.y || (c.y === best.y && c.x < best.x)) best = c;
    }
    if (!best && state.atlasAuto) {
      autoPack();
      if (r.atlas) return;
    }
    r.atlas = { x: best ? best.x : ATLAS_PAD, y: best ? best.y : ATLAS_PAD, w, h };
  }

  /* ============================================================
   * Atlas interaction
   * ============================================================ */

  function bindAtlas() {
    const c = el.atlasCanvas;
    el.atlasSizeSel.addEventListener('change', () => {
      const val = el.atlasSizeSel.value;
      const before = snapshot();
      if (val === 'auto') {
        state.atlasAuto = true;
        if (!autoPack()) state.atlasAuto = true;
      } else {
        state.atlasAuto = false;
        state.atlasSize = parseInt(val, 10);
        autoPack(state.atlasSize);
      }
      pushSnapshot(before);
      renderAll();
    });
    el.btnAutoPack.addEventListener('click', () => {
      const before = snapshot();
      if (autoPack()) toast('Atlas re-packed.');
      pushSnapshot(before);
      renderAll();
    });
    el.btnExportAtlas.addEventListener('click', exportAtlas);
    el.btnExportAll.addEventListener('click', exportAll);
    el.btnCollapseAtlas.addEventListener('click', () => {
      el.app.classList.toggle('atlas-collapsed');
      setTimeout(renderAll, 30);
    });

    c.addEventListener('pointerdown', onAtlasDown);
    c.addEventListener('pointermove', onAtlasMove);
    c.addEventListener('pointerup', onAtlasUp);
    c.addEventListener('pointercancel', onAtlasUp);
    c.addEventListener('wheel', onAtlasWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', () => {
      state.atlasView = { zoom: 1, px: 0, py: 0 };
      renderAll();
    });
  }

  function atlasScreenToWorld(sp, w, h) {
    const t = atlasTransform(w, h);
    return { x: (sp.x - t.ox) / t.scale, y: (sp.y - t.oy) / t.scale, t };
  }

  function onAtlasDown(e) {
    const sp = canvasPoint(el.atlasCanvas, e);
    const rect = el.atlasCanvas.getBoundingClientRect();
    const world = atlasScreenToWorld(sp, rect.width, rect.height);

    if (e.button === 1 || (e.button === 0 && state.space)) {
      atlasDrag = { type: 'pan', start: sp, px: state.atlasView.px, py: state.atlasView.py };
      el.atlasCanvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    let hit = null;
    for (let i = state.rippers.length - 1; i >= 0; i--) {
      const r = state.rippers[i];
      if (!r.atlas) continue;
      const a = r.atlas;
      if (world.x >= a.x && world.y >= a.y && world.x <= a.x + a.w && world.y <= a.y + a.h) { hit = r; break; }
    }

    if (hit) {
      state.selectedId = hit.id;
      refreshUI();
      atlasDrag = {
        type: 'entry',
        ripper: hit,
        start: world,
        startPos: { x: hit.atlas.x, y: hit.atlas.y },
        snapshot: snapshot(),
        moved: false,
      };
      el.atlasCanvas.setPointerCapture(e.pointerId);
      el.atlasCanvas.style.cursor = 'grabbing';
      renderAll();
    } else {
      atlasDrag = { type: 'pan', start: sp, px: state.atlasView.px, py: state.atlasView.py };
      el.atlasCanvas.setPointerCapture(e.pointerId);
      el.atlasCanvas.style.cursor = 'grabbing';
    }
  }

  function onAtlasMove(e) {
    const sp = canvasPoint(el.atlasCanvas, e);
    if (!atlasDrag) {
      const rect = el.atlasCanvas.getBoundingClientRect();
      const world = atlasScreenToWorld(sp, rect.width, rect.height);
      const over = state.rippers.some((r) => r.atlas &&
        world.x >= r.atlas.x && world.y >= r.atlas.y &&
        world.x <= r.atlas.x + r.atlas.w && world.y <= r.atlas.y + r.atlas.h);
      el.atlasCanvas.style.cursor = over ? 'grab' : 'default';
      return;
    }
    if (atlasDrag.type === 'pan') {
      state.atlasView.px = atlasDrag.px + (sp.x - atlasDrag.start.x);
      state.atlasView.py = atlasDrag.py + (sp.y - atlasDrag.start.y);
      renderAll();
      return;
    }
    if (atlasDrag.type === 'entry') {
      const rect = el.atlasCanvas.getBoundingClientRect();
      const world = atlasScreenToWorld(sp, rect.width, rect.height);
      const r = atlasDrag.ripper;
      const dx = world.x - atlasDrag.start.x;
      const dy = world.y - atlasDrag.start.y;
      const maxX = Math.max(0, state.atlasSize - r.atlas.w);
      const maxY = Math.max(0, state.atlasSize - r.atlas.h);
      r.atlas.x = Math.round(clamp(atlasDrag.startPos.x + dx, 0, maxX));
      r.atlas.y = Math.round(clamp(atlasDrag.startPos.y + dy, 0, maxY));
      atlasDrag.moved = true;
      renderAll();
    }
  }

  function onAtlasUp(e) {
    if (!atlasDrag) return;
    if (atlasDrag.type === 'entry' && atlasDrag.moved) {
      pushSnapshot(atlasDrag.snapshot);
      toast('Atlas position updated.');
    }
    atlasDrag = null;
    el.atlasCanvas.style.cursor = 'default';
    if (el.atlasCanvas.hasPointerCapture(e.pointerId)) el.atlasCanvas.releasePointerCapture(e.pointerId);
    renderAll();
  }

  function onAtlasWheel(e) {
    e.preventDefault();
    const rect = el.atlasCanvas.getBoundingClientRect();
    const sp = canvasPoint(el.atlasCanvas, e);
    const before = atlasScreenToWorld(sp, rect.width, rect.height);
    const factor = Math.exp(-e.deltaY * 0.0015);
    state.atlasView.zoom = clamp(state.atlasView.zoom * factor, 0.35, 8);
    const t0 = atlasTransform(rect.width, rect.height);
    const wantedX = sp.x - before.x * t0.scale;
    const wantedY = sp.y - before.y * t0.scale;
    state.atlasView.px += wantedX - t0.ox;
    state.atlasView.py += wantedY - t0.oy;
    renderAll();
  }

  /* ============================================================
   * Tiling preview interaction
   * ============================================================ */

  function bindTiling() {
    const c = el.tilingCanvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015);
      state.tiling.zoom = clamp(state.tiling.zoom * f, 0.3, 6);
      renderTiling();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      tilingDrag = { x: e.clientX, y: e.clientY, tx: state.tiling.x, ty: state.tiling.y };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      if (!tilingDrag) return;
      state.tiling.x = tilingDrag.tx + (e.clientX - tilingDrag.x);
      state.tiling.y = tilingDrag.ty + (e.clientY - tilingDrag.y);
      renderTiling();
    });
    const end = (e) => {
      if (!tilingDrag) return;
      tilingDrag = null;
      c.style.cursor = 'grab';
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', () => {
      state.tiling = { zoom: 1, x: 0, y: 0 };
      renderTiling();
    });
    c.style.cursor = 'grab';
  }

  /* ============================================================
   * UI wiring
   * ============================================================ */

  function bindUI() {
    el.btnOpen.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) loadFile(f);
      el.fileInput.value = '';
    });
    el.btnPaste.addEventListener('click', async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) {
            const blob = await item.getType(type);
            loadImageBlob(blob);
            return;
          }
        }
        toast('No image found on the clipboard.', 'warn');
      } catch (err) {
        toast('Clipboard access blocked — press Ctrl+V instead.', 'warn');
      }
    });
    el.btnLoad.addEventListener('click', () => el.projectInput.click());
    el.projectInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) loadProjectFile(f);
      el.projectInput.value = '';
    });
    el.btnSave.addEventListener('click', saveProject);
    el.btnUndo.addEventListener('click', undo);
    el.btnRedo.addEventListener('click', redo);
    el.btnHelp.addEventListener('click', () => { el.helpModal.hidden = false; });
    el.btnCloseHelp.addEventListener('click', () => { el.helpModal.hidden = true; });
    el.helpModal.addEventListener('click', (e) => {
      if (e.target === el.helpModal) el.helpModal.hidden = true;
    });
    el.btnDemo.addEventListener('click', loadDemo);
    el.btnRotate.addEventListener('click', rotateSource);
    el.btnAddRipper.addEventListener('click', addRipper);

    el.btnZoomIn.addEventListener('click', () => zoomBy(1.25));
    el.btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.25));
    el.btnZoomFit.addEventListener('click', fitView);
    el.btnZoom100.addEventListener('click', zoom100);

    el.btnExportSelected.addEventListener('click', () => exportRipper(selected()));

    el.ripperList.addEventListener('click', (e) => {
      const li = e.target.closest('.ripper-item');
      if (!li) return;
      const id = Number(li.dataset.id);
      if (e.target.closest('[data-act="del"]')) { removeRipper(id); return; }
      selectRipper(id);
    });

    el.ripName.addEventListener('input', () => {
      const r = selected();
      if (!r) return;
      r.name = el.ripName.value;
      const row = el.ripperList.querySelector(`[data-id="${r.id}"] .rname`);
      if (row) row.textContent = r.name;
      renderAll();
    });

    const commitSize = (which) => {
      const r = selected();
      if (!r) return;
      const before = snapshot();
      let w = parseInt(el.outW.value, 10);
      let h = parseInt(el.outH.value, 10);
      if (!Number.isFinite(w)) w = r.outW;
      if (!Number.isFinite(h)) h = r.outH;
      w = clamp(w, MIN_SIZE, MAX_SIZE);
      h = clamp(h, MIN_SIZE, MAX_SIZE);
      if (r.link) {
        const aspect = r.outW / Math.max(1, r.outH);
        if (which === 'w') h = clamp(Math.round(w / aspect), MIN_SIZE, MAX_SIZE);
        else w = clamp(Math.round(h * aspect), MIN_SIZE, MAX_SIZE);
      }
      setOutSize(r, w, h);
      pushSnapshot(before);
      refreshUI();
    };
    el.outW.addEventListener('change', () => commitSize('w'));
    el.outH.addEventListener('change', () => commitSize('h'));
    el.lockAspect.addEventListener('change', () => {
      const r = selected();
      if (!r) return;
      const before = snapshot();
      r.link = el.lockAspect.checked;
      pushSnapshot(before);
    });

    el.ripperSettings.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-size]');
      if (!btn) return;
      const r = selected();
      if (!r) return;
      const before = snapshot();
      const target = parseInt(btn.dataset.size, 10);
      const aspect = r.outW / Math.max(1, r.outH);
      let w, h;
      if (aspect >= 1) { w = target; h = Math.round(target / aspect); }
      else { h = target; w = Math.round(target * aspect); }
      setOutSize(r, clamp(w, MIN_SIZE, MAX_SIZE), clamp(h, MIN_SIZE, MAX_SIZE));
      pushSnapshot(before);
      refreshUI();
    });

    el.btnMatchPoly.addEventListener('click', () => {
      const r = selected();
      if (!r) return;
      const before = snapshot();
      const s = suggestSize(r.points);
      setOutSize(r, s.w, s.h);
      pushSnapshot(before);
      refreshUI();
    });

    // range undo stashing
    ['smBand', 'smContrast', 'smBrightness', 'smSharpen'].forEach((id) => {
      el[id].addEventListener('pointerdown', () => { state.stash = snapshot(); });
      el[id].addEventListener('change', () => {
        if (state.stash) { pushSnapshot(state.stash); state.stash = null; }
      });
    });
  }

  function setOutSize(r, w, h) {
    r.outW = clamp(Math.round(w), MIN_SIZE, MAX_SIZE);
    r.outH = clamp(Math.round(h), MIN_SIZE, MAX_SIZE);
    if (r.atlas) { r.atlas.w = r.outW; r.atlas.h = r.outH; }
    queueProcess(r);
  }

  function bindSeamlessControls() {
    const apply = (fn) => {
      const r = selected();
      if (!r) return;
      const before = snapshot();
      fn(r);
      pushSnapshot(before);
      queueProcess(r);
      updateSeamlessLabels();
      renderAll();
    };

    el.smEnabled.addEventListener('change', () => apply((r) => { r.seamless.enabled = el.smEnabled.checked; }));
    el.smMethod.addEventListener('change', () => apply((r) => { r.seamless.method = el.smMethod.value; }));
    el.btnSmReset.addEventListener('click', () => apply((r) => {
      r.seamless = { enabled: true, method: 'mirror', band: 0.12, contrast: 0, brightness: 0, sharpen: 0 };
      syncSeamlessControls();
    }));

    const bindRange = (input, key, fmt) => {
      input.addEventListener('input', () => {
        const r = selected();
        if (!r) return;
        r.seamless[key] = key === 'band' ? Number(input.value) / 100 : Number(input.value);
        document.getElementById(input.id + 'Out').textContent = fmt(r.seamless[key]);
        queueProcess(r);
      });
    };
    bindRange(el.smBand, 'band', (v) => Math.round(v * 100) + '%');
    bindRange(el.smContrast, 'contrast', (v) => String(Math.round(v)));
    bindRange(el.smBrightness, 'brightness', (v) => String(Math.round(v)));
    bindRange(el.smSharpen, 'sharpen', (v) => String(Math.round(v)));
  }

  function updateSeamlessLabels() {
    const r = selected();
    if (!r) { el.smBandOut.textContent = '—'; return; }
    el.smBandOut.textContent = Math.round(r.seamless.band * 100) + '%';
    el.smContrastOut.textContent = String(Math.round(r.seamless.contrast));
    el.smBrightnessOut.textContent = String(Math.round(r.seamless.brightness));
    el.smSharpenOut.textContent = String(Math.round(r.seamless.sharpen));
  }

  function syncSeamlessControls() {
    const r = selected();
    el.smGroup.classList.toggle('disabled', !r);
    if (!r) {
      updateSeamlessLabels();
      return;
    }
    el.smEnabled.checked = !!r.seamless.enabled;
    el.smMethod.value = r.seamless.method;
    el.smBand.value = Math.round(r.seamless.band * 100);
    el.smContrast.value = Math.round(r.seamless.contrast);
    el.smBrightness.value = Math.round(r.seamless.brightness);
    el.smSharpen.value = Math.round(r.seamless.sharpen);
    updateSeamlessLabels();
  }

  function refreshAtlasControls() {
    el.atlasSizeSel.value = state.atlasAuto ? 'auto' : String(state.atlasSize);
  }

  function refreshUI() {
    const img = state.image;
    if (img) {
      el.sourceInfo.textContent = `${img.name} — ${img.width}×${img.height}px`;
    } else {
      el.sourceInfo.textContent = 'No image loaded. Drop a file anywhere or paste from the clipboard.';
    }

    el.ripperCount.textContent = String(state.rippers.length);
    el.ripperList.innerHTML = state.rippers.map((r) => {
      const sel = r.id === state.selectedId ? ' sel' : '';
      const dims = r.canvas ? `${r.canvas.width}×${r.canvas.height}` : '—';
      return `<li class="ripper-item${sel}" data-id="${r.id}" style="--swatch:${r.color}">
        <span class="swatch"></span>
        <span class="rname" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
        <span class="rdim">${dims}</span>
        <button class="mini" data-act="del" title="Delete ripper">&#10005;</button>
      </li>`;
    }).join('');

    const r = selected();
    el.ripperSettings.disabled = !r;
    if (r) {
      if (document.activeElement !== el.ripName) el.ripName.value = r.name;
      el.outW.value = r.outW;
      el.outH.value = r.outH;
      el.lockAspect.checked = !!r.link;
    } else {
      el.ripName.value = '';
      el.outW.value = '';
      el.outH.value = '';
      el.lockAspect.checked = true;
    }

    syncSeamlessControls();
    refreshAtlasControls();
    updateUndoButtons();
    el.btnExportSelected.disabled = !r;
  }

  function updateUndoButtons() {
    el.btnUndo.disabled = state.undo.length === 0;
    el.btnRedo.disabled = state.redo.length === 0;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, kind) {
    el.status.textContent = msg;
    el.status.style.color = kind === 'warn' ? 'var(--yellow)' : kind === 'err' ? 'var(--red)' : '';
    el.status.classList.remove('flash');
    void el.status.offsetWidth;
    el.status.classList.add('flash');
  }

  /* ============================================================
   * Undo / redo
   * ============================================================ */

  function snapshot() {
    return JSON.stringify({
      rippers: state.rippers.map((r) => ({
        id: r.id,
        name: r.name,
        points: r.points,
        outW: r.outW,
        outH: r.outH,
        link: r.link,
        color: r.color,
        seamless: r.seamless,
        atlas: r.atlas,
      })),
      selectedId: state.selectedId,
      atlasSize: state.atlasSize,
      atlasAuto: state.atlasAuto,
    });
  }

  function pushSnapshot(before) {
    if (!before) return;
    const now = snapshot();
    if (before === now) return;
    state.undo.push(before);
    if (state.undo.length > 80) state.undo.shift();
    state.redo.length = 0;
    updateUndoButtons();
  }

  function applySnapshot(str) {
    let data;
    try { data = JSON.parse(str); } catch (e) { return; }
    const byId = new Map(state.rippers.map((r) => [r.id, r]));
    const next = [];
    for (const s of data.rippers) {
      let r = byId.get(s.id);
      if (!r) r = { id: s.id, canvas: null };
      r.name = s.name;
      r.points = s.points.map((p) => ({ ...p }));
      r.outW = s.outW;
      r.outH = s.outH;
      r.link = s.link !== false;
      r.color = s.color || '#ff6fc4';
      r.seamless = { ...s.seamless };
      r.atlas = s.atlas ? { ...s.atlas } : null;
      next.push(r);
    }
    state.rippers = next;
    state.selectedId = data.selectedId;
    state.atlasSize = data.atlasSize || 1024;
    state.atlasAuto = data.atlasAuto !== false;
    state.nextId = Math.max(state.nextId, ...next.map((r) => r.id + 1), 1);
    for (const r of state.rippers) processRipper(r);
    refreshUI();
    renderAll();
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    const s = state.undo.pop();
    applySnapshot(s);
    toast('Undo.');
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    const s = state.redo.pop();
    applySnapshot(s);
    toast('Redo.');
  }

  /* ============================================================
   * Source image loading
   * ============================================================ */

  function loadFile(file) {
    if (!file) return;
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      loadProjectFile(file);
    } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) {
      loadImageBlob(file);
    } else {
      toast('Unsupported file type.', 'warn');
    }
  }

  function loadImageBlob(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      setSource(img, blob instanceof File ? blob.name.replace(/\.[^.]+$/, '') : 'pasted image');
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      toast('Could not decode that image.', 'err');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function setSource(src, name) {
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    if (!sw || !sh) { toast('Image has no pixels.', 'err'); return; }
    const scl = Math.min(1, MAX_SRC / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scl));
    const h = Math.max(1, Math.round(sh * scl));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);

    state.image = { canvas, width: w, height: h, data, name: name || 'image' };
    state.rippers = [];
    state.selectedId = null;
    state.nextId = 1;
    state.undo = [];
    state.redo = [];
    state.atlasSize = 1024;
    state.atlasAuto = true;
    state.atlasView = { zoom: 1, px: 0, py: 0 };
    state.tiling = { zoom: 1, x: 0, y: 0 };
    fitView();
    refreshUI();
    renderAll();
    if (scl < 1) toast(`Image downscaled to ${w}×${h} for performance.`, 'warn');
    else toast(`${name || 'Image'} loaded (${w}×${h}).`);
  }

  function rotateSource() {
    if (!state.image) { toast('Load an image first.', 'warn'); return; }
    const { canvas, width: w, height: h, name } = state.image;
    const nc = document.createElement('canvas');
    nc.width = h;
    nc.height = w;
    const ctx = nc.getContext('2d', { willReadFrequently: true });
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, h, w);
    state.image = { canvas: nc, width: h, height: w, data, name };
    for (const r of state.rippers) {
      r.points = r.points.map((p) => ({ x: h - p.y, y: p.x }));
      r.atlas = null;
    }
    for (const r of state.rippers) processRipper(r);
    fitView();
    refreshUI();
    renderAll();
    toast('Image rotated 90°.');
  }

  /* ============================================================
   * Export / save / load
   * ============================================================ */

  function safeName(s) {
    return String(s || 'texture').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'texture';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, filename);
    }, 'image/png');
  }

  function exportRipper(r) {
    if (!r || !r.canvas) { toast('Select a ripper with a texture first.', 'warn'); return; }
    downloadCanvas(r.canvas, safeName(r.name) + '.png');
    toast(`Exported ${r.name}.png (${r.canvas.width}×${r.canvas.height}).`);
  }

  function exportAll() {
    const list = state.rippers.filter((r) => r.canvas);
    if (!list.length) { toast('No textures to export yet.', 'warn'); return; }
    list.forEach((r, i) => {
      setTimeout(() => downloadCanvas(r.canvas, safeName(r.name) + '.png'), i * 220);
    });
    toast(`Exporting ${list.length} texture${list.length === 1 ? '' : 's'}…`);
  }

  function exportAtlas() {
    const placed = state.rippers.filter((r) => r.canvas && r.atlas);
    if (!placed.length) { toast('Nothing in the atlas yet.', 'warn'); return; }
    const c = document.createElement('canvas');
    c.width = state.atlasSize;
    c.height = state.atlasSize;
    const ctx = c.getContext('2d');
    for (const r of placed) ctx.drawImage(r.canvas, r.atlas.x, r.atlas.y);
    downloadCanvas(c, `atlas_${state.atlasSize}.png`);
    toast(`Exported atlas (${state.atlasSize}×${state.atlasSize}, ${placed.length} textures).`);
  }

  function saveProject() {
    if (!state.image) { toast('Nothing to save yet.', 'warn'); return; }
    const project = {
      app: 'texripper',
      version: 1,
      image: state.image.canvas.toDataURL('image/png'),
      imageName: state.image.name,
      atlasSize: state.atlasSize,
      atlasAuto: state.atlasAuto,
      selectedId: state.selectedId,
      selectedIndex: Math.max(0, state.rippers.findIndex((r) => r.id === state.selectedId)),
      rippers: state.rippers.map((r) => ({
        name: r.name,
        points: r.points,
        outW: r.outW,
        outH: r.outH,
        link: r.link,
        color: r.color,
        seamless: r.seamless,
        atlas: r.atlas,
      })),
    };
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    downloadBlob(blob, safeName(state.image.name) + '.texripper.json');
    toast('Project saved.');
  }

  function loadProjectFile(file) {
    file.text().then((text) => {
      let p;
      try { p = JSON.parse(text); } catch (e) { toast('That is not a valid project file.', 'err'); return; }
      if (!p || !Array.isArray(p.rippers)) { toast('Project file is missing rippers.', 'err'); return; }
      const apply = (imgEl) => {
        setSource(imgEl, p.imageName || 'project');
        state.atlasAuto = p.atlasAuto !== false;
        state.atlasSize = p.atlasSize || 1024;
        state.rippers = p.rippers.map((s, i) => ({
          id: i + 1,
          name: s.name || 'RIP_' + String(i + 1).padStart(2, '0'),
          points: (s.points || []).map((q) => ({ x: q.x, y: q.y })),
          outW: clamp(s.outW || 256, MIN_SIZE, MAX_SIZE),
          outH: clamp(s.outH || 256, MIN_SIZE, MAX_SIZE),
          link: s.link !== false,
          color: s.color || PALETTE[i % PALETTE.length],
          seamless: Object.assign({ enabled: true, method: 'mirror', band: 0.12, contrast: 0, brightness: 0, sharpen: 0 }, s.seamless || {}),
          canvas: null,
          atlas: s.atlas ? { ...s.atlas } : null,
        }));
        state.nextId = state.rippers.length + 1;
        const idx = clamp(Number.isFinite(p.selectedIndex) ? p.selectedIndex : 0, 0, Math.max(0, state.rippers.length - 1));
        state.selectedId = state.rippers.length ? state.rippers[idx].id : null;
        for (const r of state.rippers) processRipper(r);
        for (const r of state.rippers) if (!r.atlas) placeEntry(r);
        autoPackIfNeeded();
        refreshUI();
        renderAll();
        toast('Project loaded.');
      };

      if (p.image) {
        const img = new Image();
        img.onload = () => apply(img);
        img.onerror = () => toast('Could not decode the project image.', 'err');
        img.src = p.image;
      } else {
        toast('Project has no embedded image.', 'err');
      }
    }).catch(() => toast('Could not read that file.', 'err'));
  }

  function autoPackIfNeeded() {
    for (const r of state.rippers) {
      if (!r.atlas) continue;
      const overlaps = state.rippers.some((o) => o !== r && o.atlas &&
        rectsOverlap(r.atlas.x, r.atlas.y, r.atlas.w, r.atlas.h, o.atlas.x, o.atlas.y, o.atlas.w, o.atlas.h, 0));
      if (overlaps) { autoPack(); return; }
    }
  }

  /* ============================================================
   * Drag & drop / paste
   * ============================================================ */

  function bindDropAndPaste() {
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      el.dropzone.classList.add('on');
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer) e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) el.dropzone.classList.remove('on');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.dropzone.classList.remove('on');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) loadFile(files[0]);
    });
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            loadImageBlob(blob);
            return;
          }
        }
      }
    });
  }

  /* ============================================================
   * Keyboard
   * ============================================================ */

  function isEditing() {
    const t = document.activeElement;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        if (!el.helpModal.hidden) { el.helpModal.hidden = true; e.preventDefault(); return; }
        if (state.drag) { state.drag = null; renderAll(); }
        return;
      }

      if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); el.fileInput.click(); return; }
      if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
      if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); exportRipper(selected()); return; }
      if (isEditing()) return;
      if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateRipper(); return; }

      if (e.code === 'Space') {
        if (e.target && e.target.tagName === 'BUTTON') return;
        if (!state.space) { state.space = true; setCursor('grab'); }
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedId != null) { e.preventDefault(); removeRipper(state.selectedId); }
        return;
      }
      if (e.key.toLowerCase() === 'f') { fitView(); }
      if (e.key.toLowerCase() === 'n') { addRipper(); }
      if (e.key === '?') { el.helpModal.hidden = !el.helpModal.hidden; }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        state.space = false;
        if (!state.drag) setCursor('default');
      }
    });

    window.addEventListener('blur', () => {
      state.space = false;
      if (!state.drag) setCursor('default');
    });
  }

  /* ============================================================
   * Demo image
   * ============================================================ */

  function buildBrickPattern(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#8f7c66';
    ctx.fillRect(0, 0, size, size);

    const rows = 8;
    const cols = 4;
    const bh = size / rows;
    const bw = size / cols;
    let seed = 20260517;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    for (let row = 0; row < rows; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let col = -1; col <= cols; col++) {
        const x = col * bw + off;
        const y = row * bh;
        const hue = 8 + rnd() * 12;
        const sat = 34 + rnd() * 14;
        const light = 34 + rnd() * 16;
        ctx.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
        ctx.fillRect(x + 3, y + 3, bw - 6, bh - 6);
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(x + 3, y + 3, bw - 6, 2);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(x + 3, y + bh - 5, bw - 6, 2);
        // subtle grime inside brick
        ctx.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.05})`;
        ctx.fillRect(x + 8 + rnd() * (bw - 30), y + 8 + rnd() * (bh - 20), 6 + rnd() * 20, 2 + rnd() * 8);
      }
    }
    return c;
  }

  function loadDemo() {
    const W = 1000, H = 680;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#232635');
    bg.addColorStop(1, '#0f1119');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // backdrop grid
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    for (let y = 40; y < H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
    }
    for (let x = 40; x < W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke();
    }

    const pat = buildBrickPattern(512);
    const pctx = pat.getContext('2d', { willReadFrequently: true });
    const pdata = pctx.getImageData(0, 0, 512, 512).data;

    const quad = [
      { x: 96, y: 74 },
      { x: 906, y: 126 },
      { x: 948, y: 594 },
      { x: 52, y: 552 },
    ];
    const h = G.quadToQuad(quad, [
      { x: 0, y: 0 }, { x: 512, y: 0 }, { x: 512, y: 512 }, { x: 0, y: 512 },
    ]);

    const out = ctx.getImageData(0, 0, W, H);
    const d = out.data;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!G.pointInPoly(x + 0.5, y + 0.5, quad)) continue;
        const den = h[6] * (x + 0.5) + h[7] * (y + 0.5) + 1;
        let u = (h[0] * (x + 0.5) + h[1] * (y + 0.5) + h[2]) / den;
        let v = (h[3] * (x + 0.5) + h[4] * (y + 0.5) + h[5]) / den;
        u = clamp(u, 0, 511.999);
        v = clamp(v, 0, 511.999);
        const px = (Math.floor(v) * 512 + Math.floor(u)) * 4;
        const shade = 1.04 - 0.3 * (v / 512) + 0.04 * Math.sin(u * 0.031);
        const i = (y * W + x) * 4;
        d[i] = pdata[px] * shade;
        d[i + 1] = pdata[px + 1] * shade;
        d[i + 2] = pdata[px + 2] * shade;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    // wall edge shading + frame
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(233,230,247,0.35)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('DEMO — perspective wall. Drag the ripper corners to the wall edges.', 24, H - 22);

    setSource(c, 'demo_brick_wall');

    const r = createRipper(quad, 'BRICK_WALL');
    if (r) {
      state.tiling.zoom = 1;
      state.tiling.x = 0;
      state.tiling.y = 0;
      toast('Demo ready — the wall is already ripped. Try the seamless + tiling controls.');
    }
    renderAll();
  }

  /* Expose a small debug surface (useful in the console). */
  window.__tex = {
    state,
    addRipper,
    loadDemo,
    processRipper,
    autoPack,
    exportAtlas,
    snapshot,
    applySnapshot,
  };
})();
