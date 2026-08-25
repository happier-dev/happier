import { z } from 'zod';

export const AutomationReplyHandoffStateV1Schema = z.enum([
  'none',
  'awaitingResult',
  'ready',
  'handingOff',
  'accepted',
  'suppressed',
  'blocked',
]);
export type AutomationReplyHandoffStateV1 = z.infer<
  typeof AutomationReplyHandoffStateV1Schema
>;
