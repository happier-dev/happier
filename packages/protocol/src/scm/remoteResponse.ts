import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ScmOperationErrorCodeSchema } from './operationError.js';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';

export const ScmRemoteResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmRemoteResponse = z.infer<typeof ScmRemoteResponseSchema>;
