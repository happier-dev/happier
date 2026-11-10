import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Host-stamped values that a session-bound Action tool may omit from model input. */
export const ActionContextualDefaultsSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.literal('current_session')),
  machineId: z.optional(z.literal('current_session_machine')),
  rootPath: z.optional(z.literal('current_session_root')),
}));

export type ActionContextualDefaults = z.infer<typeof ActionContextualDefaultsSchema>;
