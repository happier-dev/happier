import { z } from 'zod';

import { BackendTargetRefSchema } from '../backendTargets/backendTargetRef.js';
import { ExecutionRunRetentionPolicySchema } from '../executionRuns.js';
import { lazySchema } from '../lazySchema.js';

export const ExecutionRunStructuredRunRefSchema = lazySchema(() => z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  backendId: z.string().min(1),
  backendTarget: BackendTargetRefSchema.optional(),
  retentionPolicy: ExecutionRunRetentionPolicySchema.optional(),
}).passthrough());

export type ExecutionRunStructuredRunRef = z.infer<typeof ExecutionRunStructuredRunRefSchema>;
