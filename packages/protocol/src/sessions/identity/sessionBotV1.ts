import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { SessionBotFaceV1AuthoringSchema } from './sessionBotFaceV1.js';
export * from './sessionBotFaceV1.js';

/** Reversible display identity on the ordinary Session; never execution intent. */
export const SessionBotV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('bot') }));
export type SessionBotV1 = z.infer<typeof SessionBotV1Schema>;
export const SessionBotV1StoredSchema = createStoredReadSchema(SessionBotV1Schema);

export function readSessionBotV1(value: unknown): SessionBotV1 | null {
  if (value == null) return null;
  const parsed = SessionBotV1StoredSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Birth facts belong to spawn and are never changed by promotion or demotion. */
export const SessionIdentityAdditionsV1Schema = lazyZodSchema(() => z.strictObject({
  bot: z.optional(SessionBotV1Schema),
  botFace: z.optional(SessionBotFaceV1AuthoringSchema),
  createdAsBot: z.optional(z.literal(true)),
}));
export type SessionIdentityAdditions = z.infer<typeof SessionIdentityAdditionsV1Schema>;
export const SessionIdentityAdditionsV1StoredSchema = createStoredReadSchema(SessionIdentityAdditionsV1Schema);

export const BotSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  bot: z.nullable(SessionBotV1Schema),
}));
export type BotSetInput = z.infer<typeof BotSetInputSchema>;
