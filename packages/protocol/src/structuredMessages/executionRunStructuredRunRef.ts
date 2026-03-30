import { z } from 'zod';

import { BackendTargetRefSchema } from '../backendTargets/backendTargetRef.js';
import { ExecutionRunRetentionPolicySchema } from '../executionRuns.js';

export const ExecutionRunStructuredRunRefSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  backendId: z.string().min(1),
  backendTarget: BackendTargetRefSchema.optional(),
  retentionPolicy: ExecutionRunRetentionPolicySchema.optional(),
}).passthrough();

export type ExecutionRunStructuredRunRef = z.infer<typeof ExecutionRunStructuredRunRefSchema>;
