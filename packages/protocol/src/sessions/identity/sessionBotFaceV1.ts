import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';

/** Cosmetic choices shared with every authorized viewer; never work or authority. */
export const BotFaceStyleSchema = lazyZodSchema(() => z.enum(['dither', 'pixel', 'solid', 'dots', 'planet']));
export const BotFaceBodySchema = lazyZodSchema(() => z.enum([
  'crab', 'squid', 'octopus', 'ufo', 'specter', 'ghost',
  'beetle', 'spider', 'jelly', 'hopper', 'pup', 'drone',
  'robot', 'walker', 'rocket', 'feet', 'tail', 'drip',
  'bracelegs', 'tagclaws', 'cursortail', 'termbody', 'antlers', 'semi', 'brackets', 'cursor',
  'bean', 'squat', 'bag', 'loaf', 'puddle', 'tower', 'stilts', 'tall',
]));
export const BotFacePaletteSchema = lazyZodSchema(() => z.enum(['daybreak', 'lagoon', 'orchid', 'aurora', 'indigo', 'glacier', 'moss', 'sand', 'ink']));
export type BotFaceStyle = z.infer<typeof BotFaceStyleSchema>;
export type BotFaceBody = z.infer<typeof BotFaceBodySchema>;
export type BotFacePalette = z.infer<typeof BotFacePaletteSchema>;

export const SessionBotFaceV1Schema = lazyZodSchema(() => z.strictObject({
  style: z.optional(BotFaceStyleSchema),
  body: z.optional(BotFaceBodySchema),
  palette: z.optional(BotFacePaletteSchema),
  seed: z.optional(z.string().check(z.minLength(1))),
}));
export type SessionBotFaceV1 = z.infer<typeof SessionBotFaceV1Schema>;
export function areSessionBotFacesEqual(left: SessionBotFaceV1 | null | undefined, right: SessionBotFaceV1 | null | undefined): boolean {
  return left === right || (left == null && right == null) || Boolean(left && right
    && left.style === right.style && left.body === right.body
    && left.palette === right.palette && left.seed === right.seed);
}
export const SessionBotFaceV1StoredSchema = createStoredReadSchema(SessionBotFaceV1Schema);

export function readSessionBotFaceV1(value: unknown): SessionBotFaceV1 | null {
  if (value == null) return null;
  const parsed = SessionBotFaceV1StoredSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const BotFaceSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  face: z.nullable(SessionBotFaceV1Schema),
}));
export type BotFaceSetInput = z.infer<typeof BotFaceSetInputSchema>;
