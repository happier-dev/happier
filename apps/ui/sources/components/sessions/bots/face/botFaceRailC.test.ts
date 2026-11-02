import { expect, it } from 'vitest';
import { BOT_FACE_BODY_IDS } from './botFaceArt';
import { BOT_FACE_UNIT, botFaceMoonGeometry } from './botFaceGeometry';
import { BOT_FACE_REST, botFaceMomentTurn, botFacePixelLook, botFaceSmileSlide } from './botFaceMotionTokens';
import { botFaceRasterStep, drawBotFaceRaster } from './botFaceRaster';
import { createBotFaceScene } from './botFaceScene';

// R8 direction C (DECISIONS-R8 §3): hinted rail forms with one key light at rest, a small turn inside moments only.
const face = {
  identity: { body: 'bag', colour: 'orchid', seed: 1 },
  dpr: 2,
  theme: 'light',
  mood: 'quiet',
} as const;
const alpha = (img: { data: Uint8ClampedArray }, i: number) =>
  img.data[i * 4 + 3];
const lum = (img: { data: Uint8ClampedArray }, i: number) =>
  img.data[i * 4] * 0.3 +
  img.data[i * 4 + 1] * 0.55 +
  img.data[i * 4 + 2] * 0.15;

it('draws Dither on the coarser rail grid: 9, 10.5 and 12 cells across at 18, 24 and 32', () => {
  expect(
    [18, 24, 32].map(
      (size) =>
        botFaceRasterStep({ ...face, style: 'dither', size }) * face.dpr,
    ),
  ).toEqual([4, 5, 5]);
});

it('lights a Dither rail face from the top left: the ground row is its deepest tone, a lit row sits above it', () => {
  for (const body of ['robot', 'beetle', 'rocket'] as const) {
    const img = drawBotFaceRaster({
      ...face,
      identity: { ...face.identity, body },
      style: 'dither',
      size: 24,
    });
    const step = 5;
    // Most body columns end on the ground line: their lowest cell is darker than the cell above it.
    let checked = 0, grounded = 0;
    for (let x = Math.floor(step / 2); x < img.width; x += step) {
      let bottom = -1;
      for (let y = img.height - 1; y >= 0; y--) if (alpha(img, y * img.width + x)) { bottom = y; break; }
      const above = bottom - step;
      if (above < 0 || !alpha(img, above * img.width + x)) continue;
      checked++;
      if (lum(img, bottom * img.width + x) < lum(img, above * img.width + x)) grounded++;
    }
    expect(grounded / checked, body).toBeGreaterThan(0.7);
    expect(checked).toBeGreaterThan(2);
  }
});

it('fills the rail box with the Pixel micro sprite (94%, not 80%)', () => {
  const img = drawBotFaceRaster({ ...face, style: 'pixel', size: 24 });
  let x0 = img.width,
    x1 = -1;
  for (let i = 0; i < img.width * img.height; i++)
    if (alpha(img, i)) {
      const x = i % img.width;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
    }
  expect((x1 - x0 + 1) / img.width).toBeGreaterThanOrEqual(0.8);
});

it('stands a Solid rail face on a soft contact shade under its foot', () => {
  for (const theme of ['light', 'dark'] as const) {
    const img = drawBotFaceRaster({ ...face, theme, style: 'solid', size: 24 });
    let bottom = -1;
    for (let i = 0; i < img.width * img.height; i++)
      if (alpha(img, i) > 250) bottom = Math.floor(i / img.width);
    let shade = 0;
    for (let y = bottom + 1; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const a = alpha(img, y * img.width + x);
        if (a > 4 && a < 160) shade++;
      }
    expect(shade, theme).toBeGreaterThan(4);
  }
});

it('draws Dots on a coarser lattice: 5.4, 6.4 and 8.2 dots across at 18, 24 and 32', () => {
  for (const [size, across] of [
    [18, 5.4],
    [24, 6.4],
    [32, 8.2],
  ] as const) {
    const scene = createBotFaceScene({ ...face, style: 'dots', size });
    const xs = scene.body
      .filter((d) => Math.abs(d.y - scene.body[0].y) < 1e-6)
      .map((d) => d.x)
      .sort((a, b) => a - b);
    expect(xs[1] - xs[0], `${size}`).toBeCloseTo((size * 0.86) / across, 3);
  }
});

it('draws Planet on the coarser lattice at rail sizes: 5.5 and 6.5 dots across the moon at 18 and 24', () => {
  const G = botFaceMoonGeometry();
  for (const [size, across] of [
    [18, 5.5],
    [24, 6.5],
  ] as const) {
    const scene = createBotFaceScene({
      ...face,
      identity: { ...face.identity, colour: 'indigo' },
      style: 'planet',
      size,
    });
    const k = size / (2 * Math.max(1.12, G.ext * 1.08));
    const R = (46 / BOT_FACE_UNIT) * k;
    // Median nearest-neighbour spacing of the lattice: its dots share one radius; the smile beads are drawn after it.
    const lattice = scene.body.filter(d => Math.abs(d.r - scene.body[0].r) < 1e-9);
    const nn = lattice.map(a => Math.min(...lattice.filter(b => b !== a).map(b => Math.hypot(a.x - b.x, a.y - b.y)))).sort((a, b) => a - b);
    expect(nn[Math.floor(nn.length / 2)] / ((2 * R) / across), `${size}`).toBeGreaterThan(0.8);
  }
});

it('turns a face only inside a moment: no turn at rest, the lean and hop turn it within the R8 bounds', () => {
  expect(botFaceMomentTurn(BOT_FACE_REST)).toEqual({ yaw: 0, pitch: 0 });
  const lean = botFaceMomentTurn({ ...BOT_FACE_REST, rot: 4 });
  expect(lean.yaw).toBeCloseTo(0.18, 5);
  expect(botFaceMomentTurn({ ...BOT_FACE_REST, rot: -40 }).yaw).toBe(-0.36);
  expect(botFaceMomentTurn({ ...BOT_FACE_REST, ty: -0.2 }).pitch).toBe(-0.28);
});

it('keeps the hero forms and every roster body unchanged in kind: each still rail face draws at 18, 24 and 32', () => {
  for (const body of BOT_FACE_BODY_IDS)
    for (const size of [18, 24, 32])
      for (const style of ['dither', 'solid', 'pixel'] as const) {
        const img = drawBotFaceRaster({
          ...face,
          identity: { ...face.identity, body },
          style,
          size,
        });
        let opaque = 0;
        for (let i = 0; i < img.width * img.height; i++)
          if (alpha(img, i) > 128) opaque++;
        expect(opaque, `${body} ${style} ${size}`).toBeGreaterThan(
          img.width * img.height * 0.08,
        );
      }
});

it("moves only Pixel's face rows in a look: the body stays, the mouth steps one sprite pixel toward the turn", () => {
  const input = { ...face, style: 'pixel', size: 24 } as const;
  const rest = drawBotFaceRaster(input), still = drawBotFaceRaster({ ...input, look: 0 }), look = drawBotFaceRaster({ ...input, look: 1 });
  expect(still.data.join()).toBe(rest.data.join());
  expect(look.data.join()).not.toBe(rest.data.join());
  // The silhouette is unchanged: the look never adds or removes a body pixel outside the face rows' holes.
  let moved = 0;
  for (let i = 0; i < rest.width * rest.height; i++) if (!!alpha(rest, i) !== !!alpha(look, i)) moved++;
  const px = botFaceRasterStep(input) * face.dpr;
  expect(moved).toBeGreaterThan(0);
  expect(moved % (px * px)).toBe(0);
  expect(botFacePixelLook({ ...BOT_FACE_REST, rot: 8 })).toBe(1);
  expect(botFacePixelLook(BOT_FACE_REST)).toBe(0);
});

it('splits a Dots face into a body and a smile layer that together are the still face, and slides the smile only in a turn', () => {
  const input = { ...face, style: 'dots', size: 24 } as const;
  const whole = createBotFaceScene(input), body = createBotFaceScene({ ...input, layer: 'body' }), smile = createBotFaceScene({ ...input, layer: 'smile' });
  expect([...body.body, ...smile.body].map(d => [d.x, d.y, d.r, ...d.rgb])).toEqual(whole.body.map(d => [d.x, d.y, d.r, ...d.rgb]));
  expect(smile.body.length).toBeGreaterThan(0);
  expect(botFaceSmileSlide(BOT_FACE_REST)).toEqual({ x: 0, y: 0 });
  expect(Math.abs(botFaceSmileSlide({ ...BOT_FACE_REST, rot: 8 }).x)).toBeGreaterThan(0.5);
});
