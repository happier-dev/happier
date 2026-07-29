import { z } from 'zod';

export const PendingRequestedActionKindV1Schema = z.enum([
  'enqueue',
  'steer_if_active',
  'steer_now',
  'send_now',
]);

export const PendingRequestedActionV1Schema = z.object({
  v: z.literal(1),
  kind: PendingRequestedActionKindV1Schema,
}).strict();

export type PendingRequestedActionKindV1 = z.infer<typeof PendingRequestedActionKindV1Schema>;
export type PendingRequestedActionV1 = z.infer<typeof PendingRequestedActionV1Schema>;

export const DEFAULT_PENDING_REQUESTED_ACTION_V1 = Object.freeze({
  v: 1,
  kind: 'enqueue',
} satisfies PendingRequestedActionV1);

export function normalizePendingRequestedActionV1(value: unknown): PendingRequestedActionV1 {
  if (value === null || value === undefined) {
    return DEFAULT_PENDING_REQUESTED_ACTION_V1;
  }
  const parsed = PendingRequestedActionV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Malformed non-null Pending requested action');
  }
  return parsed.data;
}
