import { expect, it } from 'vitest';
import { BOT_FACE_BODIES } from './botFaceArt';
import type { BotFaceBodyId } from './botFaceArt';
import {
  BOT_FACE_REST,
  botFaceMotionChannels,
  botFaceMouthLayers,
  botFaceMotionTokens,
} from './botFaceMotionTokens';
import {
  botFaceRasterStep,
  drawBotFaceRaster,
  type BotFaceRasterInput,
} from './botFaceRaster';

const face = {
  identity: { body: 'bag', colour: 'orchid', seed: 1 },
  size: 24,
  dpr: 2,
  theme: 'light',
  mood: 'quiet',
} as const;
const opaque = (img: { data: Uint8ClampedArray }, i: number) =>
  img.data[i * 4 + 3] > 0;

it('keeps the outgoing face opaque under a mouth swap and fades only the incoming mouth (R8 bug 3)', () => {
  const mid =
    botFaceMotionTokens.reactions.startsWorking.mouthAtMs +
    botFaceMotionTokens.mouthMorphMs / 2;
  expect(botFaceMouthLayers('working', mid, 1)).toEqual({
    outgoing: 1,
    incoming: 0.5,
  });
  expect(botFaceMouthLayers(null, 0, 0.5)).toEqual({
    outgoing: 1,
    incoming: 0.5,
  });
});

it("draws a Dither moment as the posed body moving through the still face's fixed cell grid (R8 bug 1)", () => {
  const still = drawBotFaceRaster({ ...face, style: 'dither' });
  const step = botFaceRasterStep({ ...face, style: 'dither' }) * face.dpr;
  const pad = 6,
    padPx = pad * face.dpr;
  const at = (channels = BOT_FACE_REST) =>
    drawBotFaceRaster({
      ...face,
      style: 'dither',
      moment: { channels, from: 'quiet', to: 'working', u: 0, pad },
    });
  // At rest the stage holds exactly the still face, so a moment starts and ends without a pop.
  const rest = at();
  expect(rest.width).toBe(still.width + 2 * padPx);
  for (let y = 0; y < still.height; y++)
    for (let x = 0; x < still.width; x++) {
      const a = (y * still.width + x) * 4,
        b = ((y + padPx) * rest.width + x + padPx) * 4;
      expect([...rest.data.subarray(b, b + 4)]).toEqual([
        ...still.data.subarray(a, a + 4),
      ]);
    }
  // The hop's top lifts the body (a redrawn pose, not a moved picture), and every cell stays whole on the grid.
  const hop = at(botFaceMotionChannels('working', 230));
  const top = (img: typeof hop) => {
    for (let i = 0; i < img.width * img.height; i++)
      if (opaque(img, i)) return Math.floor(i / img.width);
    return -1;
  };
  expect(top(rest) - top(hop)).toBeGreaterThanOrEqual(step);
  for (let y = 0; y < hop.height; y++)
    for (let x = 0; x < hop.width; x++) {
      const cx = padPx + Math.floor((x - padPx) / step) * step,
        cy = padPx + Math.floor((y - padPx) / step) * step;
      const i = (y * hop.width + x) * 4,
        j = (Math.max(0, cy) * hop.width + Math.max(0, cx)) * 4;
      if (cx >= 0 && cy >= 0)
        expect(hop.data.subarray(i, i + 4).join()).toBe(
          hop.data.subarray(j, j + 4).join(),
        );
    }
});

it("morphs a Dither or Solid moment's mouth inside the pose, with one face, never two", () => {
  for (const style of ['dither', 'solid'] as const) {
    const draw = (u: number) =>
      drawBotFaceRaster({
        ...face,
        style,
        moment: {
          channels: BOT_FACE_REST,
          from: 'quiet',
          to: 'done',
          u,
          pad: 6,
        },
      });
    expect(draw(0.5).data.join()).not.toBe(draw(0).data.join());
    expect(draw(0.5).data.join()).not.toBe(draw(1).data.join());
  }
});

it('steps a Pixel face in its own drawn sprite pixel at every rail size (R8 bug 4)', () => {
  for (const size of [18, 24, 32])
    for (const body of Object.keys(BOT_FACE_BODIES) as BotFaceBodyId[]) {
      const input: BotFaceRasterInput = {
        ...face,
        size,
        identity: { ...face.identity, body },
        style: 'pixel',
      };
      const img = drawBotFaceRaster(input);
      // Every edge of the sprite falls on its pixel grid: the step is the common divisor of all run edges.
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const edges: number[] = [];
    for (let y = 0; y < img.height; y++) for (let x = 1; x < img.width; x++) {
      if (opaque(img, y * img.width + x) !== opaque(img, y * img.width + x - 1)) edges.push(x);
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] && img.data.subarray(i - 4, i).join() !== img.data.subarray(i, i + 4).join()) edges.push(x);
    }
    const grid = edges.reduce((g, e) => gcd(g, Math.abs(e - edges[0])), 0);
    expect(botFaceRasterStep(input) * input.dpr, `${body} at ${size}`).toBe(
        grid,
      );
    }
});
