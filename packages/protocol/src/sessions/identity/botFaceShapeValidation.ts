import {
  BOT_FACE_FIELD_EXTENT, BOT_FACE_UNIT, BOT_FACE_MOUTHS, botFaceArtBounds,
  createBotFaceGeometry, botFaceMouthLine, botFaceMouthPoints, botFaceSd,
  isClosedBotFacePath, translateBotFacePath,
} from './botFaceGeometry.js';
import type { BotFaceShapeV1 } from './sessionBotFaceV1.js';

export type BotFaceShapeValidation = Readonly<{ ok: true; shape: BotFaceShapeV1 } | { ok: false; errors: readonly string[] }>;

/** R8 §2c. Authoring only: stored readers and renderers consume the admitted outline without revalidation. */
export function normaliseAndValidateBotFaceShape(input: BotFaceShapeV1): BotFaceShapeValidation {
  const errors: string[] = [];
  try {
    if (!input.fill.length || input.fill.some(path => !isClosedBotFacePath(path))) errors.push('Fill requires closed paths');
    for (const [path, width] of input.stroke ?? []) {
      translateBotFacePath(path, 0);
      if (!(width > 0 && width <= 24)) errors.push('Stroke width must be in (0, 24]');
    }
    for (const cut of input.cut ?? []) {
      if (typeof cut === 'string') {
        if (!isClosedBotFacePath(cut)) errors.push('Filled cuts require closed paths');
      } else {
        translateBotFacePath(cut[0], 0);
        if (!(cut[1] > 0 && cut[1] <= 24)) errors.push('Cut stroke width must be in (0, 24]');
      }
    }
    if (input.mouth.some(value => !Number.isFinite(value)) || input.mouth[2] < 0.5 || input.mouth[2] > 1.2) errors.push('Mouth scale must be in [0.5, 1.2]');
    if (errors.length) return { ok: false, errors };
    const box = botFaceArtBounds(input);
    const field = 2 * BOT_FACE_FIELD_EXTENT * BOT_FACE_UNIT;
    if (box.x1 - box.x0 > field || box.y1 - box.y0 > field) return { ok: false, errors: ['Outline exceeds the geometry field'] };
    const dx = 45 - (box.x0 + box.x1) / 2;
    const shape: BotFaceShapeV1 = dx === 0 ? input : {
      ...input,
      fill: input.fill.map(path => translateBotFacePath(path, dx)),
      ...(input.stroke ? { stroke: input.stroke.map(([path, width]) => [translateBotFacePath(path, dx), width]) } : {}),
      ...(input.cut ? { cut: input.cut.map(cut => typeof cut === 'string' ? translateBotFacePath(cut, dx) : [translateBotFacePath(cut[0], dx), cut[1]]) } : {}),
      mouth: [input.mouth[0] + dx, input.mouth[1], input.mouth[2]],
    };
    const geometry = createBotFaceGeometry(shape);
    let inside = 0;
    for (const distance of geometry.sdf) if (distance < 0) inside++;
    if (inside / geometry.sdf.length < 0.08) errors.push('Body must cover at least 8% of the geometry field');
    for (const mood of ['quiet', 'needsYou'] as const) {
      const mouth = BOT_FACE_MOUTHS[mood];
      if (botFaceMouthLine(botFaceMouthPoints(geometry, mouth), mouth.o).some(([x, y]) => botFaceSd(geometry, x, y) > 0)) {
        errors.push(`The ${mood} mouth must lie on the body`);
      }
    }
    return errors.length ? { ok: false, errors } : { ok: true, shape };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Invalid path'] };
  }
}
