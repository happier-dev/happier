import { describe, expect, it } from 'vitest';
import { BOT_FACE_BODIES, BOT_FACE_BODY_IDS } from './botFaceArt';
import {
  botFaceGeometry,
  botFaceHeroPose,
  botFaceListPose,
  botFaceMouthPoints,
  botFaceSd,
  BOT_FACE_MOUTHS,
} from './botFaceGeometry';
import {
  BOT_FACE_STYLES,
  resolveBotFaceIdentity,
  type BotFaceIdentity,
  type BotFaceStyle,
} from './botFaceIdentity';
import { drawBotFaceRaster } from './botFaceRaster';
import { createBotFaceScene } from './botFaceScene';
import type { BotFaceMood } from './botFaceGeometry';

const draw = (
  style: BotFaceStyle,
  identity: BotFaceIdentity,
  mood: BotFaceMood,
  size = 24,
) =>
  style === 'dots' || style === 'planet'
    ? createBotFaceScene({
        style,
        identity,
        size,
        dpr: 2,
        theme: 'light',
        mood,
      })
        .body.map((d) =>
          [
            d.x.toFixed(2),
            d.y.toFixed(2),
            d.r.toFixed(2),
            d.rgb.map(Math.round).join(),
          ].join(),
        )
        .join('|')
    : Array.from(
        drawBotFaceRaster({
          style,
          identity,
          size,
          dpr: 2,
          theme: 'light',
          mood,
        }).data,
      ).join();
const painted = (style: BotFaceStyle, identity: BotFaceIdentity) =>
  style === 'dots' || style === 'planet'
    ? createBotFaceScene({
        style,
        identity,
        size: 24,
        dpr: 2,
        theme: 'light',
        mood: 'quiet',
      }).body.length
    : drawBotFaceRaster({
        style,
        identity,
        size: 24,
        dpr: 2,
        theme: 'light',
        mood: 'quiet',
      }).data.filter((v, i) => i % 4 === 3 && v > 0).length;

describe('Living Bot identity', () => {
  it('derives one stable identity per seed, so two Bots in one folder differ and a Bot is the same everywhere', () => {
    const a = resolveBotFaceIdentity('session-cmh7a1'),
      b = resolveBotFaceIdentity('session-cmh7b2');
    expect(resolveBotFaceIdentity('session-cmh7a1')).toEqual(a);
    expect([a.body, a.colour]).not.toEqual([b.body, b.colour]);
  });

  it('keeps every seeded face where it was when a body joins the roster: seeds draw from the original 34 bodies', () => {
    const original = BOT_FACE_BODY_IDS.slice(0, 34);
    for (let i = 0; i < 400; i++) {
      const identity = resolveBotFaceIdentity(`session-${i}`);
      expect(original[identity.seed % 34], `session-${i}`).toBe(identity.body);
    }
  });

  it('takes a saved body and colour over the seeded ones and keeps the seed, so the other styles agree', () => {
    const seeded = resolveBotFaceIdentity('session-cmh7a1');
    expect(resolveBotFaceIdentity('session-cmh7a1', { body: 'crab', palette: 'moss' })).toEqual({ body: 'crab', colour: 'moss', seed: seeded.seed });
    expect(resolveBotFaceIdentity('session-cmh7a1', { palette: 'moss' })).toEqual({ ...seeded, colour: 'moss' });
  });
});

describe('Living Bot art', () => {
  it('keeps the logo top on every body: the centre notch is open and the shoulders beside it are solid', () => {
    for (const id of BOT_FACE_BODY_IDS) {
      const G = botFaceGeometry(id, BOT_FACE_BODIES[id], false);
      const topY = (0 - G.cy) / 56.25; // source y 0 is the logo's top edge
      expect
        .soft(botFaceSd(G, 0, topY + 0.2), `${id} notch`)
        .toBeGreaterThan(0);
      expect
        .soft(botFaceSd(G, -0.52, topY + 0.2), `${id} shoulder`)
        .toBeLessThan(0);
    }
  });

  it('draws the cat with its own hand-made Pixel sprites, not a borrowed relative', () => {
    for (const size of [24, 32]) {
      const pixel = (body: 'cat' | 'bag') => drawBotFaceRaster({ style: 'pixel', identity: { body, colour: 'sand', seed: 3 }, size, dpr: 2, theme: 'light', mood: 'quiet' }).data.join();
      expect(pixel('cat'), `${size}`).not.toBe(pixel('bag'));
    }
  });

  it('renders one identity in every shipped style, for every body', () => {
    for (const style of BOT_FACE_STYLES)
      for (const body of BOT_FACE_BODY_IDS) {
        expect
          .soft(
            painted(style, { body, colour: 'indigo', seed: 7 }),
            `${style}/${body}`,
          )
          .toBeGreaterThan(0);
      }
  });

  it('shows the mood in the mouth only: each mood draws a different face of the same Bot', () => {
    const identity: BotFaceIdentity = {
      body: 'robot',
      colour: 'orchid',
      seed: 11,
    };
    for (const style of BOT_FACE_STYLES) {
      const faces = (['quiet', 'working', 'needsYou'] as const).map((mood) =>
        draw(style, identity, mood, 32),
      );
      expect.soft(new Set(faces).size, style).toBe(3);
    }
    const G = botFaceGeometry('robot', BOT_FACE_BODIES.robot, true);
    expect(botFaceMouthPoints(G, BOT_FACE_MOUTHS.needsYou)).not.toEqual(
      botFaceMouthPoints(G, BOT_FACE_MOUTHS.quiet),
    );
  });

  it('draws Dither cells on whole device pixels so no seam shows between them, at fractional zoom too', () => {
    for (const dpr of [1, 1.5, 2, 3])
      for (const size of [64, 96, 168]) {
        const img = drawBotFaceRaster({
          style: 'dither',
          identity: { body: 'octopus', colour: 'orchid', seed: 3 },
          size,
          dpr,
          theme: 'light',
          mood: 'quiet',
          hero: {
            pose: {
              yaw: 0.1,
              pitch: 0.05,
              roll: 0,
              ty: 0,
              sx: 1,
              sy: 1,
              breath: 0,
              gain: 1,
              spin: 0,
              mouth: BOT_FACE_MOUTHS.quiet,
            },
            t: 0,
            rest: true,
          },
        });
        let seams = 0;
        const a = (x: number, y: number) =>
          img.data[(y * img.width + x) * 4 + 3];
        for (let y = 1; y < img.height - 1; y++)
          for (let x = 1; x < img.width - 1; x++) {
            if (
              a(x, y) === 0 &&
              ((a(x - 1, y) > 0 && a(x + 1, y) > 0) ||
                (a(x, y - 1) > 0 && a(x, y + 1) > 0))
            ) {
              // A transparent pixel flanked by cells is a seam only if it is not part of the art's own gaps.
              if (
                a(x - 1, y) > 0 &&
                a(x + 1, y) > 0 &&
                a(x, y - 1) > 0 &&
                a(x, y + 1) > 0
              )
                seams++;
            }
          }
        expect.soft(seams, `${size}@${dpr}x`).toBe(0);
      }
  });

  it('lifts a hero into its limb pose when it needs you and holds it at rest, while a body without limbs stays put', () => {
    const coverage = (body: BotFaceIdentity['body'], style: 'dither' | 'solid', mood: BotFaceMood) =>
      drawBotFaceRaster({ style, identity: { body, colour: 'orchid', seed: 3 }, size: 64, dpr: 1, theme: 'light', mood,
        hero: { pose: { ...botFaceListPose('quiet'), mouth: BOT_FACE_MOUTHS.quiet }, t: 0, rest: true } })
        .data.filter((v, i) => i % 4 === 3 && v > 0).length;
    for (const style of ['dither', 'solid'] as const) {
      // Same pose and mouth, so only the limbs can change the silhouette: the crab's claws go up.
      expect.soft(coverage('crab', style, 'needsYou'), style).not.toBe(coverage('crab', style, 'quiet'));
      expect.soft(coverage('ghost', style, 'needsYou'), `${style} rigid`).toBe(coverage('ghost', style, 'quiet'));
    }
  });
  it('turns a done hero all the way round: its back shows halfway without the smile, the slab keeps its thickness edge-on, and it rests facing front', () => {
    const seed = 7;
    const frame = (style: 'dither' | 'solid', t: number, rest = false) =>
      drawBotFaceRaster({ style, identity: { body: 'ghost', colour: 'indigo', seed }, size: 96, dpr: 1, theme: 'light', mood: 'done',
        hero: { pose: botFaceHeroPose('done', t, seed, rest), t, rest } });
    // The smile is printed white on the front (Solid) or carved dark (Dither): either way only the front carries it.
    const smile = (img: ReturnType<typeof frame>) => {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 255 && img.data[i] > 250 && img.data[i + 1] > 250 && img.data[i + 2] > 250) n++;
      return n;
    };
    const width = (img: ReturnType<typeof frame>) => {
      let x0 = img.width, x1 = -1;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
      return x1 - x0 + 1;
    };
    expect(botFaceHeroPose('done', 520, seed).spin).toBeCloseTo(Math.PI, 5);
    expect(botFaceHeroPose('done', 99999, seed, true).spin).toBe(0);
    expect(smile(frame('solid', 0))).toBeGreaterThan(20);
    expect(smile(frame('solid', 520))).toBe(0);
    for (const style of ['dither', 'solid'] as const) {
      const front = width(frame(style, 0));
      let narrowest = Infinity;
      for (let t = 140; t <= 900; t += 10) narrowest = Math.min(narrowest, width(frame(style, t)));
      // Edge-on, the slab is as thick as its two faces apart (about 0.37 of a ghost's width), never a sliver.
      expect.soft(narrowest / front, style).toBeGreaterThan(0.28);
      expect.soft(Math.abs(width(frame(style, 99999, true)) - front), `${style} rests facing front`).toBeLessThanOrEqual(2);
    }
  });
});
