import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';

/** Reversible display identity on the ordinary Session; never execution intent. */
export const SessionBotV1Schema = lazyZodSchema(() => z.object({ kind: z.literal('bot') }).strict());
export type SessionBotV1 = z.infer<typeof SessionBotV1Schema>;
export const SessionBotV1StoredSchema = createStoredReadSchema(SessionBotV1Schema);

export function readSessionBotV1(value: unknown): SessionBotV1 | null {
  const parsed = SessionBotV1StoredSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Birth facts belong to spawn and are never changed by promotion or demotion. */
export const SessionIdentityAdditionsV1Schema = lazyZodSchema(() => z.object({
  bot: SessionBotV1Schema.optional(),
  createdAsBot: z.literal(true).optional(),
}).strict());
export type SessionIdentityAdditions = z.infer<typeof SessionIdentityAdditionsV1Schema>;
export const SessionIdentityAdditionsV1StoredSchema = createStoredReadSchema(SessionIdentityAdditionsV1Schema);

export const BotSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  bot: SessionBotV1Schema.nullable(),
}).strict());
export type BotSetInput = z.infer<typeof BotSetInputSchema>;
