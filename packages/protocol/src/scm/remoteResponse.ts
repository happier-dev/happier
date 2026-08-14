import { z } from 'zod';

import { ScmOperationErrorCodeSchema } from './operationError.js';

export const ScmRemoteResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmRemoteResponse = z.infer<typeof ScmRemoteResponseSchema>;
