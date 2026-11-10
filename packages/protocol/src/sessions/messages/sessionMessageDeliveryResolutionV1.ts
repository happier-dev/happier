import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

/** Witnessed host admission; requested delivery intent is not accepted delivery evidence. */
export const SessionMessageAcceptedTurnV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['newTurn', 'followUp', 'steer']),
  turnId: z.string().check(z.refine((value) => value.trim().length > 0)),
}));
export type SessionMessageAcceptedTurnV1 = z.infer<typeof SessionMessageAcceptedTurnV1Schema>;

export const SessionMessageAcceptedDeliveryFactsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  acceptedAtMs: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  delivery: SessionMessageAcceptedTurnV1Schema,
}));
export const SessionMessageAcceptedDeliveryFactsV1StoredSchema = createStoredReadSchema(SessionMessageAcceptedDeliveryFactsV1Schema);

export const SessionMessageAcceptedDeliveryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: SessionMessageAcceptedDeliveryFactsV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));

export const SessionMessageDeliveryResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ v: z.literal(1), kind: z.literal('manual_handled') }),
  z.strictObject({ v: z.literal(1), kind: z.literal('provider_accepted'),
    content: SessionMessageAcceptedDeliveryContentV1Schema }),
]));

export type SessionMessageAcceptedDeliveryFactsV1 = z.infer<typeof SessionMessageAcceptedDeliveryFactsV1Schema>;
export type SessionMessageAcceptedDeliveryContentV1 = z.infer<typeof SessionMessageAcceptedDeliveryContentV1Schema>;

export type SessionMessageDeliveryResolutionV1 = z.infer<typeof SessionMessageDeliveryResolutionV1Schema>;

export function parseSessionMessageDeliveryResolutionV1(value: unknown): SessionMessageDeliveryResolutionV1 | null {
  const parsed = SessionMessageDeliveryResolutionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const storedSessionMessageDeliveryResolutionV1Schema = createStoredReadSchema(SessionMessageDeliveryResolutionV1Schema);

export function readStoredSessionMessageDeliveryResolutionV1(value: unknown): SessionMessageDeliveryResolutionV1 | null {
  const parsed = storedSessionMessageDeliveryResolutionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
