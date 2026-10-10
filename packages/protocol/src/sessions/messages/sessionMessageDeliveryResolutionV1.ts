import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/** Witnessed host admission; requested delivery intent is not accepted delivery evidence. */
export const SessionMessageAcceptedDeliveryFactsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  acceptedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  delivery: z.object({
    kind: z.enum(['newTurn', 'followUp', 'steer']),
    turnId: z.string().refine((value) => value.trim().length > 0),
  }).strict(),
}).strict());

export const SessionMessageAcceptedDeliveryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: SessionMessageAcceptedDeliveryFactsV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));

export const SessionMessageDeliveryResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('manual_handled') }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('provider_accepted'),
    content: SessionMessageAcceptedDeliveryContentV1Schema }).strict(),
]));

export type SessionMessageAcceptedDeliveryFactsV1 = z.infer<typeof SessionMessageAcceptedDeliveryFactsV1Schema>;
export type SessionMessageAcceptedDeliveryContentV1 = z.infer<typeof SessionMessageAcceptedDeliveryContentV1Schema>;

export type SessionMessageDeliveryResolutionV1 = z.infer<typeof SessionMessageDeliveryResolutionV1Schema>;

export function parseSessionMessageDeliveryResolutionV1(value: unknown): SessionMessageDeliveryResolutionV1 | null {
  const parsed = SessionMessageDeliveryResolutionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
