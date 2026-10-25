/* TexRipper — geometry & warping
 * Pure functions, no DOM dependencies except ImageData.
 */
(function (global) {
  'use strict';

  const G = {};

  /* ---------------- small math helpers ---------------- */

  G.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };

  G.lerp = function (a, b, t) { return a + (b - a) * t; };

  G.smoothstep = function (a, b, x) {
    if (a === b) return x < a ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  G.dist = function (a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  /** Signed area. Positive for clockwise winding in screen space (y down). */
  G.signedArea = function (pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  };

  G.centroid = function (pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  };

  G.bbox = function (pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  };

  G.pointInPoly = function (px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) &&
          (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };

  /* ---------------- linear algebra ---------------- */

  /** Solve A x = b for a small dense system. Returns null when singular. */
  G.solveLinear = function (A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      const d = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (!f) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row) => row[n]);
  };

  /**
   * Homography mapping destination quad -> source quad.
   * dst: [{x,y} x4], src: [{x,y} x4]
   * returns [h0..h7] such that sx=(h0*X+h1*Y+h2)/d, sy=(h3*X+h4*Y+h5)/d, d=h6*X+h7*Y+1
   */
  G.quadToQuad = function (dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const X = dst[i].x, Y = dst[i].y;
      const x = src[i].x, y = src[i].y;
      A.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x]); b.push(x);
      A.push([0, 0, 0, X, Y, 1, -X * y, -Y * y]); b.push(y);
    }
    return G.solveLinear(A, b);
  };

  G.applyH = function (h, X, Y) {
    const d = h[6] * X + h[7] * Y + 1;
    return { x: (h[0] * X + h[1] * Y + h[2]) / d, y: (h[3] * X + h[4] * Y + h[5]) / d };
  };

  /* ---------------- sampling ---------------- */

  function clampCoord(v, max) {
    if (v !== v) return 0;      // NaN
    if (v < 0) return 0;
    if (v > max) return max;
    return v;
  }

  /** Bilinear sample of RGBA data at floating point coords, written to out[oi..oi+3]. */
  function sampleBilinear(src, sw, sh, fx, fy, out, oi) {
    fx = clampCoord(fx, sw - 1);
    fy = clampCoord(fy, sh - 1);
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < sw ? x0 + 1 : x0;
    const y1 = y0 + 1 < sh ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * sw + x0) * 4;
    const i10 = (y0 * sw + x1) * 4;
    const i01 = (y1 * sw + x0) * 4;
    const i11 = (y1 * sw + x1) * 4;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    out[oi]     = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
    out[oi + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
    out[oi + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
    out[oi + 3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
  }

  G.sampleBilinear = sampleBilinear;

  /* ---------------- warping ---------------- */

  function warpPerspective(src, sw, sh, out, W, H, h) {
    const od = out.data;
    for (let y = 0; y < H; y++) {
      const Y = y + 0.5;
      const yBase = y * W * 4;
      for (let x = 0; x < W; x++) {
        const X = x + 0.5;
        const den = h[6] * X + h[7] * Y + 1;
        if (den === 0) continue;
        const sx = (h[0] * X + h[1] * Y + h[2]) / den;
        const sy = (h[3] * X + h[4] * Y + h[5]) / den;
        sampleBilinear(src, sw, sh, sx, sy, od, yBase + x * 4);
      }
    }
  }

  /** Evenly spaced points along the rectangle perimeter, clockwise from top-left. */
  G.rectPerimeterPoints = function (w, h, n) {
    const per = 2 * (w + h);
    const pts = [];
    for (let i = 0; i < n; i++) {
      let d = (i * per) / n;
      if (d < w) { pts.push({ x: d, y: 0 }); continue; }
      d -= w;
      if (d < h) { pts.push({ x: w, y: d }); continue; }
      d -= h;
      if (d < w) { pts.push({ x: w - d, y: h }); continue; }
      d -= w;
      pts.push({ x: 0, y: h - d });
    }
    return pts;
  };

  function edgeFn(a, b, px, py) {
    return (px - a.x) * (b.y - a.y) - (py - a.y) * (b.x - a.x);
  }

  function rasterTriangle(src, sw, sh, out, W, H, a, b, c, da, db, dc) {
    const ux = db.x - da.x, uy = db.y - da.y;
    const vx = dc.x - da.x, vy = dc.y - da.y;
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-9) return;

    const Ux = b.x - a.x, Uy = b.y - a.y;
    const Vx = c.x - a.x, Vy = c.y - a.y;

    const m00 = (Ux * vy - Vx * uy) / det;
    const m01 = (-Ux * vx + Vx * ux) / det;
    const m10 = (Uy * vy - Vy * uy) / det;
    const m11 = (-Uy * vx + Vy * ux) / det;

    const minX = Math.max(0, Math.floor(Math.min(da.x, db.x, dc.x)) - 1);
    const maxX = Math.min(W, Math.ceil(Math.max(da.x, db.x, dc.x)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(da.y, db.y, dc.y)) - 1);
    const maxY = Math.min(H, Math.ceil(Math.max(da.y, db.y, dc.y)) + 1);

    const area2 = (db.x - da.x) * (dc.y - da.y) - (db.y - da.y) * (dc.x - da.x);
    const sgn = area2 >= 0 ? 1 : -1;
    const eps = 0.75;
    const od = out.data;

    for (let y = minY; y < maxY; y++) {
      const py = y + 0.5;
      const row = y * W * 4;
      for (let x = minX; x < maxX; x++) {
        const px = x + 0.5;
        const e0 = edgeFn(da, db, px, py);
        const e1 = edgeFn(db, dc, px, py);
        const e2 = edgeFn(dc, da, px, py);
        const inside = sgn > 0
          ? (e0 <= eps && e1 <= eps && e2 <= eps)
          : (e0 >= -eps && e1 >= -eps && e2 >= -eps);
        if (!inside) continue;
        const sx = a.x + m00 * (px - da.x) + m01 * (py - da.y);
        const sy = a.y + m10 * (px - da.x) + m11 * (py - da.y);
        sampleBilinear(src, sw, sh, sx, sy, od, row + x * 4);
      }
    }
  }

  function pointOnRect(w, h, t) {
    const per = 2 * (w + h);
    let d = t * per;
    if (d < w) return { x: d, y: 0 };
    d -= w;
    if (d < h) return { x: w, y: d };
    d -= h;
    if (d < w) return { x: w - d, y: h };
    d -= w;
    return { x: 0, y: h - d };
  }

  function pointOnPoly(pts, lens, total, t) {
    let d = t * total;
    for (let i = 0; i < pts.length; i++) {
      const seg = lens[i];
      if (d <= seg || i === pts.length - 1) {
        const f = seg > 1e-9 ? clamp01(d / seg) : 0;
        const a = pts[i], b = pts[(i + 1) % pts.length];
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      d -= seg;
    }
    return { ...pts[0] };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /**
   * Warp a general polygon to the rectangle.
   * Both boundaries are parameterised by arc length and the rectangle corners are
   * inserted as vertices, so the output covers the full rectangle with no corner cuts.
   * Each pair of matching boundary segments forms an affine-mapped triangle fan.
   */
  function warpFan(src, sw, sh, out, W, H, pts) {
    // Normalise winding so the rip is not mirrored: clockwise from pts[0].
    let poly = pts;
    if (G.signedArea(pts) < 0) poly = [pts[0], ...pts.slice(1).reverse()];

    const n = poly.length;
    const lens = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = G.dist(poly[i], poly[(i + 1) % n]);
      lens.push(d);
      total += d;
    }
    if (total < 1e-9) return;

    const per = 2 * (W + H);
    const ts = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      ts.push(acc / total);
      acc += lens[i];
    }
    ts.push(0, W / per, (W + H) / per, (2 * W + H) / per);
    ts.sort((a, b) => a - b);

    const uniq = [];
    for (const t of ts) {
      if (!uniq.length || Math.abs(t - uniq[uniq.length - 1]) > 1e-7) uniq.push(t);
    }

    const srcPts = uniq.map((t) => pointOnPoly(poly, lens, total, t));
    const dstPts = uniq.map((t) => pointOnRect(W, H, t));
    const sc = G.centroid(poly);
    const dc = { x: W / 2, y: H / 2 };

    for (let i = 0; i < uniq.length; i++) {
      const a = srcPts[i], b = srcPts[(i + 1) % uniq.length];
      const da = dstPts[i], db = dstPts[(i + 1) % uniq.length];
      rasterTriangle(src, sw, sh, out, W, H, sc, a, b, dc, da, db);
    }
  }

  /**
   * Extract a rectified texture from source RGBA data.
   * 4 points => true perspective homography, more => piecewise affine fan warp.
   */
  G.extract = function (src, sw, sh, pts, W, H) {
    // Accept either an ImageData or a raw RGBA buffer.
    if (src && src.data && typeof src.data.length === 'number' && !src.length) src = src.data;
    W = Math.max(1, Math.round(W));
    H = Math.max(1, Math.round(H));
    const out = new ImageData(W, H);
    if (!pts || pts.length < 3) return out;
    if (pts.length === 4) {
      const rect = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
      const h = G.quadToQuad(rect, pts);
      if (h) {
        warpPerspective(src, sw, sh, out, W, H, h);
        return out;
      }
    }
    warpFan(src, sw, sh, out, W, H, pts);
    return out;
  };

  global.Geo = G;
})(window);
