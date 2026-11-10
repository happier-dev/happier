import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ScmBranchIntegrationOperationSchema = lazyZodSchema(() => z.enum(['merge', 'rebase']));
export type ScmBranchIntegrationOperation = z.infer<typeof ScmBranchIntegrationOperationSchema>;

export const ScmRepositoryOperationKindSchema = lazyZodSchema(() => z.enum(['merge', 'rebase', 'revert', 'cherry_pick']));
export type ScmRepositoryOperationKind = z.infer<typeof ScmRepositoryOperationKindSchema>;

export const ScmOperationStateSchema = lazyZodSchema(() => z.strictObject({
  kind: ScmRepositoryOperationKindSchema,
  sourceRef: z.optional(z.nullable(z.string())),
  replayCommit: z.optional(z.string()),
  baseOid: z.optional(z.string()),
  headOid: z.optional(z.string()),
  unresolvedCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  conflicts: z.optional(z.array(z.strictObject({
    path: z.string(),
    kind: z.string(),
    indexStages: z.optional(z.strictObject({ base: z.optional(z.string()), ours: z.optional(z.string()), theirs: z.optional(z.string()) })),
  }))),
  canContinue: z.boolean(),
  canAbort: z.boolean(),
  canSkip: z.optional(z.boolean()),
}).check(z.refine((state) => !state.canContinue || !state.unresolvedCount, {
  message: 'Unresolved conflicts prevent continuation', path: ['canContinue'],
})));
export type ScmOperationState = z.infer<typeof ScmOperationStateSchema>;
