import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const SessionMessageDeliveryResolutionV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('manual_handled'),
}).strict());

export type SessionMessageDeliveryResolutionV1 = z.infer<typeof SessionMessageDeliveryResolutionV1Schema>;
