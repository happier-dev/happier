import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';

/**
 * Bounded result for the passive Agent realtime setup probe. It intentionally
 * contains no provider account, app-server, or credential material.
 */
export const AgentPassiveRealtimeSetupStatusV1Schema = lazyZodSchema(() => z.enum([
  'ready',
  'runtime_incompatible',
  'authentication_required',
  'feature_disabled',
  'unavailable',
]));
export type AgentPassiveRealtimeSetupStatusV1 = z.infer<
  typeof AgentPassiveRealtimeSetupStatusV1Schema
>;

export const AgentPassiveRealtimeSetupResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  status: AgentPassiveRealtimeSetupStatusV1Schema,
  failureCause: z.optional(ActionFailureCauseV1Schema),
}));
export type AgentPassiveRealtimeSetupResultV1 = z.infer<
  typeof AgentPassiveRealtimeSetupResultV1Schema
>;
