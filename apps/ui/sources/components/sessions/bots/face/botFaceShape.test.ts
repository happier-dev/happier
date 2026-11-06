import { describe, expect, it } from 'vitest';
import { resolveBotFaceIdentity } from './botFaceIdentity';
import { botFaceGeometry, botFaceHeroPose } from './botFaceGeometry';
import { BOT_FACE_BODIES, BOT_FACE_BODY_IDS } from './botFaceArt';
import { drawBotFaceRaster } from './botFaceRaster';
import { createBotFaceScene } from './botFaceScene';
import { BotFaceSetInputSchema } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import { deriveBotFaceSprite } from './botFaceSprite';
import { generateBotFaceShape } from './botFaceShapeGenerator';

const shape = { v: 1 as const, fill: ['M5 5 L85 5 L85 85 L5 85 Z'], mouth: [45, 48, 0.8] as [number, number, number], origin: 'custom' as const };

describe('custom face art', () => {
  it('takes saved art over the fallback roster body in silhouette styles at rail and hero size', () => {
    const fallback = resolveBotFaceIdentity('shape', { body: 'crab', palette: 'orchid' });
    const custom = resolveBotFaceIdentity('shape', { body: 'crab', palette: 'orchid', shape });
    expect(custom).toHaveProperty('shape', shape);
    for (const size of [24, 80]) {
      const hero = size === 80 ? { pose: botFaceHeroPose('quiet', 0, custom.seed, true), t: 0, rest: true } : undefined;
      for (const style of ['dither', 'solid', 'pixel'] as const) {
        const draw = (identity: typeof fallback) => drawBotFaceRaster({ style, identity, size, dpr: 2, theme: 'light', mood: 'quiet', hero }).data;
        expect(draw(custom), `${style} ${size}`).not.toEqual(draw(fallback));
        expect(draw(custom).some((value, i) => i % 4 === 3 && value > 0)).toBe(true);
      }
      const drawDots = (identity: typeof fallback) => createBotFaceScene({ style: 'dots', identity, size, dpr: 2, theme: 'light', mood: 'quiet', hero }).body;
      expect(drawDots(custom), `dots ${size}`).not.toEqual(drawDots(fallback));
      expect(drawDots(custom).length).toBeGreaterThan(0);
    }
  });

  it('renders the standard Planet scene for custom and generated outlines, preserving palette and mouth', () => {
    const fallback = resolveBotFaceIdentity('shape-planet', { body: 'cat', palette: 'orchid' });
    const outlines = [shape, generateBotFaceShape(42)];
    for (const [size, mood, theme] of [[24, 'quiet', 'dark'], [18, 'needsYou', 'light'], [80, 'quiet', 'light'], [80, 'needsYou', 'dark']] as const) {
      const hero = size === 80 ? { pose: botFaceHeroPose(mood, 400, fallback.seed, true) } : undefined;
      const draw = (identity: typeof fallback) => createBotFaceScene({ style: 'planet', identity, size, mood, theme, hero, dpr: 2 });
      const expected = draw(fallback);
      expect(expected.body.length).toBeGreaterThan(0);
      for (const outline of outlines) {
        expect(draw({ ...fallback, shape: outline }), `${outline.origin}/${size}/${mood}`).toEqual(expected);
      }
      expect(draw({ ...fallback, colour: 'daybreak' })).not.toEqual(expected);
      if (!hero) {
        expect(createBotFaceScene({ style: 'planet', identity: fallback, size, mood: mood === 'quiet' ? 'needsYou' : 'quiet', theme, dpr: 2 })).not.toEqual(expected);
      }
    }
  });

  it('keys geometry by art rather than a caller label, and shares equal art between callers', () => {
    const first = botFaceGeometry('same-label', BOT_FACE_BODIES.crab, false);
    expect(botFaceGeometry('same-label', BOT_FACE_BODIES.bag, false)).not.toBe(first);
    expect(botFaceGeometry('other-label', { ...BOT_FACE_BODIES.crab }, false)).toBe(first);
  });

  it('reuses live artwork fields without carrying them into a replacement artwork lifetime', () => {
    const art = { ...shape, fill: [...shape.fill] };
    const plain = botFaceGeometry('live', art, false);
    const hinted = botFaceGeometry('live', art, true);
    expect(botFaceGeometry('another-consumer', { ...art }, false)).toBe(plain);
    expect(botFaceGeometry('another-consumer', art, true)).toBe(hinted);
    // A newly loaded/replaced outline owns its own memo; the previous consumer's field is not process-owned.
    const replacement = { ...art, fill: [...art.fill] };
    const next = botFaceGeometry('replacement', replacement, false);
    expect(next).not.toBe(plain);
    expect(next.sdf).toEqual(plain.sdf);
    const mouthChanged = botFaceGeometry('mouth', { ...art, mouth: [45, 56, 0.8] }, false);
    expect(mouthChanged).not.toBe(plain);
    expect(mouthChanged.mouth).not.toEqual(plain.mouth);
    const centred = botFaceGeometry('centred', art, true, { ...plain, cy: plain.cy + 1 });
    expect(centred).not.toBe(hinted);
    expect(centred.cy).toBe(plain.cy + 1);
  });

  it('keeps a custom outline during hero reactions instead of borrowing its fallback body’s limb morph', () => {
    const crab = resolveBotFaceIdentity('custom-morph', { body: 'crab', shape });
    const bag = { ...crab, body: 'bag' as const };
    for (const mood of ['working', 'needsYou'] as const) {
      const hero = { pose: botFaceHeroPose(mood, 400, crab.seed), t: 400, rest: false };
      for (const style of ['dither', 'solid'] as const) {
        const draw = (identity: typeof crab) => drawBotFaceRaster({ identity, style, mood, hero, size: 80, dpr: 2, theme: 'light' }).data;
        expect(draw(crab), `${style}/${mood}`).toEqual(draw(bag));
      }
    }
  });

  it('admits the existing roster through the same outline grammar, field, area and mouth rules', () => {
    for (const body of BOT_FACE_BODY_IDS) {
      expect(BotFaceSetInputSchema.safeParse({ sessionId: 'shape-roster', face: { body, shape: { ...BOT_FACE_BODIES[body], v: 1 } } }).success, body).toBe(true);
    }
  });

  it('derives the Pixel silhouette and state mouths from the outline on both grids', () => {
    for (const width of [8, 12] as const) {
      const quiet = deriveBotFaceSprite(shape, 'quiet', width);
      const needsYou = deriveBotFaceSprite(shape, 'needsYou', width);
      expect(quiet.grid.every(row => row.length === width)).toBe(true);
      expect(quiet.grid.join('')).toContain('X');
      expect(quiet.mouthRows).toBeGreaterThan(0);
      expect(quiet.grid).not.toEqual(needsYou.grid);
    }
  });
});
