import { z } from 'zod';

import { SessionRunnerRuntimeStateV1Schema } from './sessionRunnerRuntimeV1.js';

export const SessionRunnerProcessIdentityV2Schema = z.object({
  pid: z.number().int().positive(),
  processStartTimeMs: z.number().int().nonnegative(),
}).strict();
export type SessionRunnerProcessIdentityV2 = z.infer<typeof SessionRunnerProcessIdentityV2Schema>;

/** Additive status read carrying only exact process-currentness evidence beside unchanged V1 state. */
export const SessionRunnerRuntimeStatusV2Schema = z.object({
  v: z.literal(2),
  state: SessionRunnerRuntimeStateV1Schema,
  runnerProcessIdentity: SessionRunnerProcessIdentityV2Schema.nullable(),
}).strict();
export type SessionRunnerRuntimeStatusV2 = z.infer<typeof SessionRunnerRuntimeStatusV2Schema>;
