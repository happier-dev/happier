import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ScmDiffSummaryCommitPlanSchema } from './diffSummary.js';
import { ScmCommitOidSchema, ScmCommitExpectedRefSchema, ScmCommitPublicationSchema, ScmCommitHookContentChangesSchema } from './commitPublication.js';

/** Host-checked acceptance, never a model-authored authorization. All nested authority is closed. */
export const ScmCommitPlanAcceptanceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmDiffSummaryCommitPlanSchema, {
  comparisonId: z.string().check(z.minLength(1)), repositoryRootPath: z.string().check(z.minLength(1)),
  expectedHeadOid: z.nullable(ScmCommitOidSchema), expectedRef: ScmCommitExpectedRefSchema,
})));
export type ScmCommitPlanAcceptance = z.infer<typeof ScmCommitPlanAcceptanceSchema>;
export const ScmCommitPlanStepSchema = lazyZodSchema(() => z.strictObject({
  groupId: z.string().check(z.minLength(1)), state: z.enum(['pending', 'writing', 'published', 'not_published', 'unknown']),
  targetTreeOid: z.optional(ScmCommitOidSchema), expectedHeadOid: z.optional(z.nullable(ScmCommitOidSchema)),
  commitSha: z.optional(ScmCommitOidSchema), actualMessage: z.optional(z.string()),
  publication: z.optional(ScmCommitPublicationSchema), hookContentChanges: z.optional(ScmCommitHookContentChangesSchema),
  errorCode: z.optional(z.string().check(z.minLength(1))), error: z.optional(z.string()),
  acceptedHookTreeOid: z.optional(ScmCommitOidSchema),
}));
export type ScmCommitPlanStep = z.infer<typeof ScmCommitPlanStepSchema>;
export const ScmCommitPlanApplicationSchema = lazyZodSchema(() => z.strictObject({
  acceptedRevision: z.number().check(z.int(), z.nonnegative()), acceptance: ScmCommitPlanAcceptanceSchema,
  status: z.enum(['applying', 'paused', 'failed', 'unknown', 'stopped', 'complete']),
  steps: z.array(ScmCommitPlanStepSchema), nextGroupIndex: z.number().check(z.int(), z.nonnegative()),
  stopAfterCurrent: z.boolean(),
  reason: z.optional(z.enum(['hook_content_changed', 'hook_failed', 'signing_failed', 'head_moved', 'source_changed',
    'staging_conflict', 'selection_conflict', 'writer_failed', 'publication_warning', 'outcome_unknown', 'cancelled', 'stopped'])),
}));
export type ScmCommitPlanApplication = z.infer<typeof ScmCommitPlanApplicationSchema>;

const base = z.strictObject({ cwd: z.string().check(z.minLength(1)), resultId: z.string().check(z.minLength(1)),
  expectedRevision: z.number().check(z.int(), z.nonnegative()) });
export const ScmCommitPlanAcceptInputSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(base, { acceptance: ScmCommitPlanAcceptanceSchema }));
export type ScmCommitPlanAcceptInput = z.infer<typeof ScmCommitPlanAcceptInputSchema>;
export const ScmCommitPlanControlInputSchema = base;
export type ScmCommitPlanControlInput = z.infer<typeof ScmCommitPlanControlInputSchema>;
export const ScmCommitPlanIncludeHookChangesInputSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(base, {
  groupId: z.string().check(z.minLength(1)), beforeTreeOid: ScmCommitOidSchema, afterTreeOid: ScmCommitOidSchema,
}));
export type ScmCommitPlanIncludeHookChangesInput = z.infer<typeof ScmCommitPlanIncludeHookChangesInputSchema>;

export function isScmCommitPlanApplicationLocked(application: ScmCommitPlanApplication | undefined): boolean {
  return application?.status === 'applying' || application?.status === 'paused' || application?.status === 'unknown';
}

/** Compact proposal selection projects the exact references, never commit permission. */
export function selectScmCommitPlanGroup(plan: z.infer<typeof ScmDiffSummaryCommitPlanSchema>, groupId: string) {
  const group = plan.groups.find((candidate) => candidate.id === groupId);
  return group ? { groupId: group.id, changeRefs: [...group.changeRefs] } : null;
}
