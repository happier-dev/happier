import { describe, expect, it } from 'vitest';
import { botFaceArtBounds, normaliseAndValidateBotFaceShape } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import { BOT_FACE_SHAPE_PARTS, generateBotFaceShape, type BotFaceShapeParts } from './botFaceShapeGenerator';

const plain: BotFaceShapeParts = { head: 'round', ears: 'none', limbs: 'none', tail: 'none', accessory: 'none' };

describe('seeded Bot shape authoring', () => {
  it('saves a deterministic outline rather than its generation seed', () => {
    const first = generateBotFaceShape(17);
    expect(generateBotFaceShape(17)).toEqual(first);
    expect(generateBotFaceShape(18)).not.toEqual(first);
    expect(first.origin).toBe('surprise');
    expect(first).not.toHaveProperty('seed');
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('produces valid, centered and varied outlines for the lab’s 200-seed batch', () => {
    const outlines = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const shape = generateBotFaceShape(seed);
      const result = normaliseAndValidateBotFaceShape(shape);
      expect(result.ok, `seed ${seed}: ${result.ok ? '' : result.errors.join(', ')}`).toBe(true);
      if (result.ok) expect(result.shape, `seed ${seed}: admission must preserve the generated outline`).toEqual(shape);
      const bounds = botFaceArtBounds(shape);
      expect((bounds.x0 + bounds.x1) / 2, `seed ${seed}`).toBeCloseTo(45, 5);
      outlines.add(JSON.stringify(shape));
    }
    expect(outlines.size).toBe(200);
  }, 120_000);

  it('supports every lab part through typed overrides, with a visible silhouette change', () => {
    const base = generateBotFaceShape(41, { parts: plain, targetSize: 80 });
    for (const key of ['head', 'ears', 'limbs', 'tail', 'accessory'] as const) {
      for (const value of new Set(BOT_FACE_SHAPE_PARTS.selection[key])) {
        const parts = { ...plain, [key]: value };
        const shape = generateBotFaceShape(41, { parts, targetSize: 80 });
        const result = normaliseAndValidateBotFaceShape(shape);
        expect(result.ok, `${key}/${value}: ${result.ok ? '' : result.errors.join(', ')}`).toBe(true);
        if (value !== plain[key]) expect(shape.fill.join() + shape.stroke?.join(), `${key}/${value}`).not.toEqual(base.fill.join() + base.stroke?.join());
      }
    }
  }, 30_000);

  it('thickens fine rail parts, compacts long limbs and drops the bow below its useful size', () => {
    const parts: BotFaceShapeParts = { ...plain, ears: 'antennae', limbs: 'tentacles', accessory: 'bow' };
    const rail = generateBotFaceShape(41, { parts, targetSize: 18 });
    const hero = generateBotFaceShape(41, { parts, targetSize: 80 });
    expect(Math.min(...rail.stroke!.map(([, width]) => width))).toBeGreaterThan(Math.min(...hero.stroke!.map(([, width]) => width)));
    expect(rail.fill.length).toBeLessThan(hero.fill.length);
    expect(botFaceArtBounds(rail).y1).toBeLessThan(botFaceArtBounds(hero).y1);
    expect(generateBotFaceShape(41, { parts })).toEqual(generateBotFaceShape(41, { parts, targetSize: BOT_FACE_SHAPE_PARTS.sizing.defaultTargetSize }));
  });

  it('keeps exaggerated pointed ears and horns valid across rail, row and hero sizes', () => {
    for (const ears of ['pointed', 'horns'] as const) {
      const parts = { ...plain, ears };
      const hero = botFaceArtBounds(generateBotFaceShape(41, { parts, targetSize: 80 }));
      for (const targetSize of [18, 24, 32]) {
        const shape = generateBotFaceShape(41, { parts, targetSize });
        expect(normaliseAndValidateBotFaceShape(shape).ok, `${ears}/${targetSize}`).toBe(true);
        expect(botFaceArtBounds(shape).y0, `${ears}/${targetSize}`).toBeLessThan(hero.y0);
      }
    }
  });
});
