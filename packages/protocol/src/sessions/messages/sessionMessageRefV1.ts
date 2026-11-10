import { z } from '../../zodRuntimePolicy.js';
import { SessionIdSchema } from '../idsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

/** Committed message identity. Pending/local input ids must be resolved by the Session message owner. */
export const SessionMessageRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session'),
  session: z.strictObject({ serverId: z.string().check(z.minLength(1)), sessionId: asProtocolZod(SessionIdSchema) }),
  messageId: z.string().check(z.minLength(1)),
}));
export type SessionMessageRefV1 = z.infer<typeof SessionMessageRefV1Schema>;
export function parseSessionMessageRefV1(value: unknown): SessionMessageRefV1 | null {
  const result = SessionMessageRefV1Schema.safeParse(value);
  return result.success ? result.data : null;
}
