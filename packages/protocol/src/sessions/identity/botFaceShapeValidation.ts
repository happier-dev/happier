import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  BOT_FACE_FIELD_EXTENT, BOT_FACE_UNIT, BOT_FACE_MOUTHS, botFaceArtBounds,
  createBotFaceGeometry, botFaceMouthLine, botFaceMouthPoints, botFaceSd,
  isClosedBotFacePath, translateBotFacePath,
} from './botFaceGeometry.js';
import type { BotFaceShapeV1 } from './sessionBotFaceV1.js';

const MINIMUM_BODY_COVERAGE = 0.08;
const MAXIMUM_MOUTH_SIGNED_DISTANCE = 0;
const CONTAINED_MOUTHS = ['quiet', 'needsYou'] as const;

/** Fixed authoring facts only: never include coordinates, paths or measured input values. */
export const BotFaceShapeConstraintSchema = lazyZodSchema(() => z.union([
  z.strictObject({ rule: z.literal('body_coverage'), minimumRatio: z.literal(MINIMUM_BODY_COVERAGE) }),
  z.strictObject({ rule: z.literal('mouth_containment'), mood: z.enum(CONTAINED_MOUTHS), maximumSignedDistance: z.literal(MAXIMUM_MOUTH_SIGNED_DISTANCE) }),
  z.strictObject({ rule: z.enum(['fill_closed', 'stroke_width', 'cut_closed', 'cut_stroke_width', 'mouth_scale', 'outline_extent', 'path_syntax']) }),
]));
export type BotFaceShapeConstraint = z.infer<typeof BotFaceShapeConstraintSchema>;

export type BotFaceShapeValidation = Readonly<{ ok: true; shape: BotFaceShapeV1 } | {
  ok: false; errors: readonly string[]; constraints: readonly BotFaceShapeConstraint[];
}>;

/** R8 §2c. Authoring only: stored readers and renderers consume the admitted outline without revalidation. */
export function normaliseAndValidateBotFaceShape(input: BotFaceShapeV1): BotFaceShapeValidation {
  const errors: string[] = [];
  const constraints: BotFaceShapeConstraint[] = [];
  const reject = (message: string, constraint: BotFaceShapeConstraint) => { errors.push(message); constraints.push(constraint); };
  try {
    if (!input.fill.length || input.fill.some(path => !isClosedBotFacePath(path))) reject('Fill requires closed paths', { rule: 'fill_closed' });
    for (const [path, width] of input.stroke ?? []) {
      translateBotFacePath(path, 0);
      if (!(width > 0 && width <= 24)) reject('Stroke width must be in (0, 24]', { rule: 'stroke_width' });
    }
    for (const cut of input.cut ?? []) {
      if (typeof cut === 'string') {
        if (!isClosedBotFacePath(cut)) reject('Filled cuts require closed paths', { rule: 'cut_closed' });
      } else {
        translateBotFacePath(cut[0], 0);
        if (!(cut[1] > 0 && cut[1] <= 24)) reject('Cut stroke width must be in (0, 24]', { rule: 'cut_stroke_width' });
      }
    }
    if (input.mouth.some(value => !Number.isFinite(value)) || input.mouth[2] < 0.5 || input.mouth[2] > 1.2) reject('Mouth scale must be in [0.5, 1.2]', { rule: 'mouth_scale' });
    if (errors.length) return { ok: false, errors, constraints };
    const box = botFaceArtBounds(input);
    const field = 2 * BOT_FACE_FIELD_EXTENT * BOT_FACE_UNIT;
    if (box.x1 - box.x0 > field || box.y1 - box.y0 > field) {
      reject('Outline exceeds the geometry field', { rule: 'outline_extent' });
      return { ok: false, errors, constraints };
    }
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
    if (inside / geometry.sdf.length < MINIMUM_BODY_COVERAGE) reject('Body must cover at least 8% of the geometry field', { rule: 'body_coverage', minimumRatio: MINIMUM_BODY_COVERAGE });
    for (const mood of CONTAINED_MOUTHS) {
      const mouth = BOT_FACE_MOUTHS[mood];
      if (botFaceMouthLine(botFaceMouthPoints(geometry, mouth), mouth.o).some(([x, y]) => botFaceSd(geometry, x, y) > MAXIMUM_MOUTH_SIGNED_DISTANCE)) {
        reject(`The ${mood} mouth must lie on the body`, { rule: 'mouth_containment', mood, maximumSignedDistance: MAXIMUM_MOUTH_SIGNED_DISTANCE });
      }
    }
    return errors.length ? { ok: false, errors, constraints } : { ok: true, shape };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Invalid path'], constraints: [{ rule: 'path_syntax' }] };
  }
}
