/* TexRipper — seamless generation & texture post-processing
 * Operates on ImageData, returns fresh ImageData.
 */
(function (global) {
  'use strict';

  const S = {};
  const smoothstep = window.Geo.smoothstep;

  function copyOf(imageData) {
    return new Uint8ClampedArray(imageData.data);
  }

  /** Blend each edge band with the horizontally mirrored copy. Guarantees wrap continuity. */
  function mirrorH(src, w, h, band) {
    const out = new Uint8ClampedArray(src);
    const half = (w - 1) / 2;
    if (half <= 0) return out;
    const inner = 1 - Math.min(0.5, Math.max(0.001, band));
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const u = Math.abs(x - half) / half;
        if (u <= inner) continue;
        const t = 0.5 * smoothstep(inner, 1, u);
        const i = row + x * 4;
        const j = row + (w - 1 - x) * 4;
        const s = 1 - t;
        out[i]     = src[i]     * s + src[j]     * t;
        out[i + 1] = src[i + 1] * s + src[j + 1] * t;
        out[i + 2] = src[i + 2] * s + src[j + 2] * t;
        out[i + 3] = src[i + 3] * s + src[j + 3] * t;
      }
    }
    return out;
  }

  /** Same as mirrorH but blended across the vertical bands (rows). */
  function mirrorV(src, w, h, band) {
    const out = new Uint8ClampedArray(src);
    const half = (h - 1) / 2;
    if (half <= 0) return out;
    const inner = 1 - Math.min(0.5, Math.max(0.001, band));
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const u = Math.abs(y - half) / half;
      if (u <= inner) continue;
      const t = 0.5 * smoothstep(inner, 1, u);
      const s = 1 - t;
      const row = y * rowBytes;
      const mrow = (h - 1 - y) * rowBytes;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        const j = mrow + x * 4;
        out[i]     = src[i]     * s + src[j]     * t;
        out[i + 1] = src[i + 1] * s + src[j + 1] * t;
        out[i + 2] = src[i + 2] * s + src[j + 2] * t;
        out[i + 3] = src[i + 3] * s + src[j + 3] * t;
      }
    }
    return out;
  }

  /**
   * Wrap the image by half a tile and feather that shifted copy over the borders.
   * The outer border becomes a continuous slice from the middle of the source,
   * which tiles without a visible seam.
   */
  function offsetFeather(src, w, h, bandFrac) {
    const out = new Uint8ClampedArray(src.length);
    const dx = Math.floor(w / 2);
    const dy = Math.floor(h / 2);
    const band = Math.max(1, Math.round(bandFrac * Math.min(w, h)));
    for (let y = 0; y < h; y++) {
      const sy = (y + dy) % h;
      const row = y * w * 4;
      const srow = sy * w * 4;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        const d = Math.min(x, y, w - 1 - x, h - 1 - y);
        if (d >= band) {
          out[i] = src[i]; out[i + 1] = src[i + 1];
          out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3];
          continue;
        }
        const t = 1 - smoothstep(0, band, d);
        const j = srow + ((x + dx) % w) * 4;
        const s = 1 - t;
        out[i]     = src[i]     * s + src[j]     * t;
        out[i + 1] = src[i + 1] * s + src[j + 1] * t;
        out[i + 2] = src[i + 2] * s + src[j + 2] * t;
        out[i + 3] = src[i + 3] * s + src[j + 3] * t;
      }
    }
    return out;
  }

  /** 3x3 unsharp mask. */
  function unsharp(src, w, h, amount) {
    if (amount <= 0) return src;
    const out = new Uint8ClampedArray(src);
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0;
        const x1 = x < w - 1 ? x + 1 : w - 1;
        const row0 = y0 * w, row1 = y * w, row2 = y1 * w;
        const i = (row1 + x) * 4;
        for (let c = 0; c < 3; c++) {
          const sum =
            src[(row0 + x0) * 4 + c] + src[(row0 + x) * 4 + c] + src[(row0 + x1) * 4 + c] +
            src[(row1 + x0) * 4 + c] + src[(row1 + x) * 4 + c] + src[(row1 + x1) * 4 + c] +
            src[(row2 + x0) * 4 + c] + src[(row2 + x) * 4 + c] + src[(row2 + x1) * 4 + c];
          const avg = sum / 9;
          out[i + c] = src[i + c] + amount * (src[i + c] - avg);
        }
      }
    }
    return out;
  }

  /** Contrast / brightness / sharpen. */
  S.adjust = function (imageData, opts) {
    opts = opts || {};
    const w = imageData.width, h = imageData.height;
    let data = copyOf(imageData);

    const contrast = window.Geo.clamp(opts.contrast || 0, -100, 100);
    const brightness = window.Geo.clamp(opts.brightness || 0, -100, 100);
    if (contrast !== 0 || brightness !== 0) {
      const c = contrast * 2.55;
      const f = (259 * (c + 255)) / (255 * (259 - c));
      const b = brightness * 2.55;
      for (let i = 0; i < data.length; i += 4) {
        data[i]     = f * (data[i] - 128) + 128 + b;
        data[i + 1] = f * (data[i + 1] - 128) + 128 + b;
        data[i + 2] = f * (data[i + 2] - 128) + 128 + b;
      }
    }

    const sharpen = window.Geo.clamp(opts.sharpen || 0, 0, 100);
    if (sharpen > 0) data = unsharp(data, w, h, (sharpen / 100) * 1.6);

    return new ImageData(data, w, h);
  };

  /**
   * Full seamless pipeline.
   * opts: { method: 'mirror'|'offset'|'none', band: 0..0.5, contrast, brightness, sharpen }
   */
  S.process = function (imageData, opts) {
    opts = opts || {};
    const w = imageData.width, h = imageData.height;
    const band = window.Geo.clamp(opts.band == null ? 0.12 : opts.band, 0.001, 0.5);
    let data = copyOf(imageData);

    if (opts.method === 'mirror') {
      data = mirrorH(data, w, h, band);
      data = mirrorV(data, w, h, band);
    } else if (opts.method === 'offset') {
      data = offsetFeather(data, w, h, band);
    }

    let result = new ImageData(data, w, h);
    if ((opts.contrast || 0) !== 0 || (opts.brightness || 0) !== 0 || (opts.sharpen || 0) > 0) {
      result = S.adjust(result, opts);
    }
    return result;
  };

  global.Seamless = S;
})(window);
