import { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from './idsV1.js';

export const SESSION_CONSUMPTION_REPLACE_EVENT = 'session-consumption-replace';
const sessionIds = z.array(asProtocolZod(SessionIdSchema));

/** Closed, connection-local routing operation; no content or claimed authority. */
export const SessionConsumptionReplaceV1Schema = z.strictObject({
  v: z.literal(1), liveSessionIds: sessionIds, durableSessionIds: sessionIds,
});
export type SessionConsumptionReplaceV1 = z.infer<typeof SessionConsumptionReplaceV1Schema>;
export const SessionConsumptionReplaceAckV1Schema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), v: z.literal(1), liveSessionIds: sessionIds, durableSessionIds: sessionIds }),
  z.strictObject({ ok: z.literal(false), error: z.enum(['invalid_request', 'not_allowed', 'unavailable']) }),
]);
export type SessionConsumptionReplaceAckV1 = z.infer<typeof SessionConsumptionReplaceAckV1Schema>;
