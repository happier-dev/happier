import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES } from '../../actions/externalActionLimits.js';
import { normaliseAndValidateBotFaceShape } from './botFaceShapeValidation.js';
export * from './botFaceGeometry.js';
export { normaliseAndValidateBotFaceShape } from './botFaceShapeValidation.js';

/** Cosmetic choices shared with every authorized viewer; never work or authority. */
export const BotFaceStyleSchema = lazyZodSchema(() => z.enum(['dither', 'pixel', 'solid', 'dots', 'planet']));
export const BotFaceBodySchema = lazyZodSchema(() => z.enum([
  'crab', 'squid', 'octopus', 'ufo', 'specter', 'ghost',
  'beetle', 'spider', 'jelly', 'hopper', 'pup', 'drone',
  'robot', 'walker', 'rocket', 'feet', 'tail', 'drip',
  'bracelegs', 'tagclaws', 'cursortail', 'termbody', 'antlers', 'semi', 'brackets', 'cursor',
  'bean', 'squat', 'bag', 'loaf', 'puddle', 'tower', 'stilts', 'tall',
  // Appended only: seeded faces draw from the first 34, so a new body never moves an existing Bot's face.
  'cat',
]));
export const BotFacePaletteSchema = lazyZodSchema(() => z.enum(['daybreak', 'lagoon', 'orchid', 'aurora', 'indigo', 'glacier', 'moss', 'sand', 'ink']));
export type BotFaceStyle = z.infer<typeof BotFaceStyleSchema>;
export type BotFaceBody = z.infer<typeof BotFaceBodySchema>;
export type BotFacePalette = z.infer<typeof BotFacePaletteSchema>;

/** Saved outline, never a generator seed. The fallback body remains readable by earlier clients. */
export const BotFaceShapeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  fill: z.array(z.string()),
  stroke: z.optional(z.array(z.tuple([z.string(), z.number()]))),
  cut: z.optional(z.array(z.union([z.string(), z.tuple([z.string(), z.number()])]))),
  mouth: z.tuple([z.number(), z.number(), z.number()]),
  origin: z.optional(z.enum(['surprise', 'custom'])),
}));
export type BotFaceShapeV1 = z.infer<typeof BotFaceShapeV1Schema>;

export const SessionBotFaceV1Schema = lazyZodSchema(() => z.strictObject({
  style: z.optional(BotFaceStyleSchema),
  body: z.optional(BotFaceBodySchema),
  palette: z.optional(BotFacePaletteSchema),
  seed: z.optional(z.string().check(z.minLength(1))),
  shape: z.optional(BotFaceShapeV1Schema),
}));
export type SessionBotFaceV1 = z.infer<typeof SessionBotFaceV1Schema>;
export function areSessionBotFacesEqual(left: SessionBotFaceV1 | null | undefined, right: SessionBotFaceV1 | null | undefined): boolean {
  return left === right || (left == null && right == null) || Boolean(left && right
    && left.style === right.style && left.body === right.body
    && left.palette === right.palette && left.seed === right.seed
    && areBotFaceShapesEqual(left.shape, right.shape));
}
function areBotFaceShapesEqual(left: BotFaceShapeV1 | undefined, right: BotFaceShapeV1 | undefined): boolean {
  return left === right || Boolean(left && right && left.v === right.v && left.origin === right.origin
    && JSON.stringify([left.fill, left.stroke ?? [], left.cut ?? [], left.mouth])
      === JSON.stringify([right.fill, right.stroke ?? [], right.cut ?? [], right.mouth]));
}
export const SessionBotFaceV1StoredSchema = createStoredReadSchema(SessionBotFaceV1Schema);

/** New cosmetic writes share geometric admission; retained data stays structural. */
export const SessionBotFaceV1AuthoringSchema = defineStoredReadProjection(lazyZodSchema(() => z.pipe(
  SessionBotFaceV1Schema,
  z.transform((face, ctx) => {
    if (!face.shape) return face;
    const result = normaliseAndValidateBotFaceShape(face.shape);
    if (!result.ok) {
      for (const constraint of result.constraints) ctx.issues.push({ code: 'custom', input: face, path: ['shape'],
        message: 'Invalid Bot shape', params: { constraint } });
      return z.NEVER;
    }
    return { ...face, shape: result.shape };
  }),
)), () => SessionBotFaceV1StoredSchema);

export function readSessionBotFaceV1(value: unknown): SessionBotFaceV1 | null {
  if (value == null) return null;
  const parsed = SessionBotFaceV1StoredSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const BotFaceSetInputSchema = lazyZodSchema(() => z.pipe(z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  face: z.nullable(SessionBotFaceV1Schema),
}).check(z.superRefine((input, ctx) => {
  // Reuse the public Action request owner, including for local CLI/UI ingress. No new shape/path cap.
  if (input.face?.shape && new TextEncoder().encode(JSON.stringify(input)).byteLength > EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['face', 'shape'], message: 'Face exceeds the existing Action request payload limit' });
  }
})), z.transform((input, ctx) => {
  if (!input.face?.shape) return input;
  const result = normaliseAndValidateBotFaceShape(input.face.shape);
  if (!result.ok) {
    for (const message of result.errors) ctx.issues.push({ code: 'custom', input, path: ['face', 'shape'], message });
    return z.NEVER;
  }
  return { ...input, face: { ...input.face, shape: result.shape } };
})));
export type BotFaceSetInput = z.infer<typeof BotFaceSetInputSchema>;
