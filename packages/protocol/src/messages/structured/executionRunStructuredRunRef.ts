import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import { ExecutionRunRetentionPolicySchema } from '../../execution/runs/runPrimitives.js';

export const ExecutionRunStructuredRunRefSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  callId: z.string().check(z.minLength(1)),
  backendId: z.string().check(z.minLength(1)),
  backendTarget: z.optional(BackendTargetRefSchema),
  retentionPolicy: z.optional(ExecutionRunRetentionPolicySchema),
}));

export type ExecutionRunStructuredRunRef = z.infer<typeof ExecutionRunStructuredRunRefSchema>;
