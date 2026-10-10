import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import { ExecutionRunRetentionPolicySchema } from '../../execution/runs/runPrimitives.js';

export const ExecutionRunStructuredRunRefSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  backendId: z.string().min(1),
  backendTarget: BackendTargetRefSchema.optional(),
  retentionPolicy: ExecutionRunRetentionPolicySchema.optional(),
}).passthrough());

export type ExecutionRunStructuredRunRef = z.infer<typeof ExecutionRunStructuredRunRefSchema>;
