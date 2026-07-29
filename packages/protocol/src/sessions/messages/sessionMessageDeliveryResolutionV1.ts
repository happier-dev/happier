import { z } from 'zod';

export const SessionMessageDeliveryResolutionV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('manual_handled'),
}).strict();

export type SessionMessageDeliveryResolutionV1 = z.infer<typeof SessionMessageDeliveryResolutionV1Schema>;

export function parseSessionMessageDeliveryResolutionV1(value: unknown): SessionMessageDeliveryResolutionV1 | null {
  const parsed = SessionMessageDeliveryResolutionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
