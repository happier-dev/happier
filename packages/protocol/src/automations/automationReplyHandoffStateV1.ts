import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const AutomationReplyHandoffStateV1Schema = lazyZodSchema(() => z.enum([
  'none',
  'awaitingResult',
  'ready',
  'handingOff',
  'accepted',
  'suppressed',
  'blocked',
]));
export type AutomationReplyHandoffStateV1 = z.infer<
  typeof AutomationReplyHandoffStateV1Schema
>;
