import { z } from 'zod';

/** Host-stamped values that a session-bound Action tool may omit from model input. */
export const ActionContextualDefaultsSchema = z.object({
  sessionId: z.literal('current_session').optional(),
  machineId: z.literal('current_session_machine').optional(),
}).strict();

export type ActionContextualDefaults = z.infer<typeof ActionContextualDefaultsSchema>;
