import { z } from 'zod';

import { ScmOperationErrorCodeSchema } from './operationError.js';

/**
 * The source-neutral request to materialize an already selected local
 * workspace. Provider/account/ref authority stays with the source plugin; this
 * owner receives only the exact root and prepared checkout facts.
 */
export const ScmReviewWorkspaceMaterializePreparedRequestSchema = z.object({
  cwd: z.string().min(1),
  displayName: z.string().min(1),
  baseRef: z.string().min(1).nullable(),
  branchMode: z.enum(['new', 'existing']),
}).strict();
export type ScmReviewWorkspaceMaterializePreparedRequest = z.infer<
  typeof ScmReviewWorkspaceMaterializePreparedRequestSchema
>;

export const ScmReviewWorkspaceMaterializePreparedResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    targetPath: z.string().min(1),
    branchName: z.string().min(1),
    created: z.boolean(),
  }).strict(),
  z.object({
    success: z.literal(false),
    error: z.string().min(1),
    errorCode: ScmOperationErrorCodeSchema,
  }).strict(),
]);
export type ScmReviewWorkspaceMaterializePreparedResponse = z.infer<
  typeof ScmReviewWorkspaceMaterializePreparedResponseSchema
>;
