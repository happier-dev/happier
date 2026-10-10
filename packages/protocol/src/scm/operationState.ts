import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ScmBranchIntegrationOperationSchema = lazyZodSchema(() => z.enum(['merge', 'rebase']));
export type ScmBranchIntegrationOperation = z.infer<typeof ScmBranchIntegrationOperationSchema>;

export const ScmRepositoryOperationKindSchema = lazyZodSchema(() => z.enum(['merge', 'rebase', 'revert', 'cherry_pick']));
export type ScmRepositoryOperationKind = z.infer<typeof ScmRepositoryOperationKindSchema>;

export const ScmOperationStateSchema = lazyZodSchema(() => z.object({
  kind: ScmRepositoryOperationKindSchema,
  sourceRef: z.string().nullable().optional(),
  replayCommit: z.string().optional(),
  baseOid: z.string().optional(),
  headOid: z.string().optional(),
  unresolvedCount: z.number().int().nonnegative().optional(),
  conflicts: z.array(z.object({
    path: z.string(),
    kind: z.string(),
    indexStages: z.object({ base: z.string().optional(), ours: z.string().optional(), theirs: z.string().optional() }).strict().optional(),
  }).strict()).optional(),
  canContinue: z.boolean(),
  canAbort: z.boolean(),
  canSkip: z.boolean().optional(),
}).strict().refine((state) => !state.canContinue || !state.unresolvedCount, {
  message: 'Unresolved conflicts prevent continuation', path: ['canContinue'],
}));
export type ScmOperationState = z.infer<typeof ScmOperationStateSchema>;
