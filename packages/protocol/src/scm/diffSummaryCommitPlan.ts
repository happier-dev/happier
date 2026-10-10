import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ScmDiffSummaryCommitPlanSchema } from './diffSummary.js';
import { ScmCommitOidSchema, ScmCommitExpectedRefSchema, ScmCommitPublicationSchema, ScmCommitHookContentChangesSchema } from './commitPublication.js';

/** Host-checked acceptance, never a model-authored authorization. All nested authority is closed. */
export const ScmCommitPlanAcceptanceSchema = lazyZodSchema(() => ScmDiffSummaryCommitPlanSchema.extend({
  comparisonId: z.string().min(1), repositoryRootPath: z.string().min(1),
  expectedHeadOid: ScmCommitOidSchema.nullable(), expectedRef: ScmCommitExpectedRefSchema,
}).strict());
export type ScmCommitPlanAcceptance = z.infer<typeof ScmCommitPlanAcceptanceSchema>;
export const ScmCommitPlanStepSchema = lazyZodSchema(() => z.object({
  groupId: z.string().min(1), state: z.enum(['pending', 'writing', 'published', 'not_published', 'unknown']),
  targetTreeOid: ScmCommitOidSchema.optional(), expectedHeadOid: ScmCommitOidSchema.nullable().optional(),
  commitSha: ScmCommitOidSchema.optional(), actualMessage: z.string().optional(),
  publication: ScmCommitPublicationSchema.optional(), hookContentChanges: ScmCommitHookContentChangesSchema.optional(),
  errorCode: z.string().min(1).optional(), error: z.string().optional(),
  acceptedHookTreeOid: ScmCommitOidSchema.optional(),
}).strict());
export type ScmCommitPlanStep = z.infer<typeof ScmCommitPlanStepSchema>;
export const ScmCommitPlanApplicationSchema = lazyZodSchema(() => z.object({
  acceptedRevision: z.number().int().nonnegative(), acceptance: ScmCommitPlanAcceptanceSchema,
  status: z.enum(['applying', 'paused', 'failed', 'unknown', 'stopped', 'complete']),
  steps: z.array(ScmCommitPlanStepSchema), nextGroupIndex: z.number().int().nonnegative(),
  stopAfterCurrent: z.boolean(),
  reason: z.enum(['hook_content_changed', 'hook_failed', 'signing_failed', 'head_moved', 'source_changed',
    'staging_conflict', 'selection_conflict', 'writer_failed', 'publication_warning', 'outcome_unknown', 'cancelled', 'stopped']).optional(),
}).strict());
export type ScmCommitPlanApplication = z.infer<typeof ScmCommitPlanApplicationSchema>;

const base = z.object({ cwd: z.string().min(1), resultId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative() }).strict();
export const ScmCommitPlanAcceptInputSchema = base.extend({ acceptance: ScmCommitPlanAcceptanceSchema }).strict();
export type ScmCommitPlanAcceptInput = z.infer<typeof ScmCommitPlanAcceptInputSchema>;
export const ScmCommitPlanControlInputSchema = base;
export type ScmCommitPlanControlInput = z.infer<typeof ScmCommitPlanControlInputSchema>;
export const ScmCommitPlanIncludeHookChangesInputSchema = base.extend({
  groupId: z.string().min(1), beforeTreeOid: ScmCommitOidSchema, afterTreeOid: ScmCommitOidSchema,
}).strict();
export type ScmCommitPlanIncludeHookChangesInput = z.infer<typeof ScmCommitPlanIncludeHookChangesInputSchema>;

export function isScmCommitPlanApplicationLocked(application: ScmCommitPlanApplication | undefined): boolean {
  return application?.status === 'applying' || application?.status === 'paused' || application?.status === 'unknown';
}

/** Compact proposal selection projects the exact references, never commit permission. */
export function selectScmCommitPlanGroup(plan: z.infer<typeof ScmDiffSummaryCommitPlanSchema>, groupId: string) {
  const group = plan.groups.find((candidate) => candidate.id === groupId);
  return group ? { groupId: group.id, changeRefs: [...group.changeRefs] } : null;
}
