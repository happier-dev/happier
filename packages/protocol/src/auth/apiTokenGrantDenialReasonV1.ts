import { z } from '../zodRuntimePolicy.js';

export const ApiTokenGrantDenialReasonV1Schema = z.enum([
  'action_not_granted',
  'target_required',
  'target_not_granted',
  'create_not_granted',
  'automation_not_granted',
  'environment_not_granted',
]);
export type ApiTokenGrantDenialReasonV1 = z.infer<typeof ApiTokenGrantDenialReasonV1Schema>;
