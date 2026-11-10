import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SessionRunnerRuntimeStateV1Schema } from './sessionRunnerRuntimeV1.js';

export const SessionRunnerProcessIdentityV2Schema = lazyZodSchema(() => z.strictObject({
  pid: z.number().check(z.int(), z.positive()),
  processStartTimeMs: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionRunnerProcessIdentityV2 = z.infer<typeof SessionRunnerProcessIdentityV2Schema>;

/** Additive status read carrying only exact process-currentness evidence beside unchanged V1 state. */
export const SessionRunnerRuntimeStatusV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  state: SessionRunnerRuntimeStateV1Schema,
  runnerProcessIdentity: z.nullable(SessionRunnerProcessIdentityV2Schema),
}));
export type SessionRunnerRuntimeStatusV2 = z.infer<typeof SessionRunnerRuntimeStatusV2Schema>;
