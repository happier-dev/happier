import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ScmBranchSourceRefSchema } from './remoteNormalization.js';
import { ScmSelectedMutationPathSchema } from './selectedMutationPath.js';

export const ScmCommitOidSchema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)));
export const ScmCommitExpectedRefSchema = lazyZodSchema(() => z.nullable(ScmBranchSourceRefSchema.check(z.refine((value) => value.startsWith('refs/'), 'Expected ref must be a full symbolic Git ref'))));

/** Null base is unborn; null ref is detached. A candidate alone is never publication evidence. */
export const ScmCommitPublicationSchema = lazyZodSchema(() => z.strictObject({
  state: z.enum(['not_published', 'published', 'unknown']),
  expectedHeadOid: z.nullable(ScmCommitOidSchema),
  expectedRef: ScmCommitExpectedRefSchema,
  candidateOid: z.optional(ScmCommitOidSchema),
  actualMessage: z.optional(z.string()),
  indexReconciliation: z.enum(['not_required', 'pending', 'reconciled', 'failed']),
  indexTreeOid: z.optional(ScmCommitOidSchema),
  /** The normal hook that stopped the commit or changed its content (pre-commit, commit-msg, …). */
  hookName: z.optional(z.string().check(z.minLength(1))),
  /** The committer time of the constructed commit object. */
  committedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  /** Whether the writer actually signed the constructed commit object (repository signing policy ran). */
  signed: z.optional(z.boolean()),
}).check(z.superRefine((publication, context) => {
  if (publication.indexTreeOid !== undefined && (publication.state !== 'published' || publication.indexReconciliation !== 'reconciled')) {
    context.addIssue({ code: "custom", path: ['indexTreeOid'], message: 'Index tree evidence requires successful publication and verified index reconciliation' });
  }
})));
export type ScmCommitPublication = z.infer<typeof ScmCommitPublicationSchema>;

export const ScmCommitHookContentChangesSchema = lazyZodSchema(() => z.strictObject({
  beforeTreeOid: ScmCommitOidSchema,
  afterTreeOid: ScmCommitOidSchema,
  changes: z.array(z.strictObject({
    path: ScmSelectedMutationPathSchema,
    previousPath: z.optional(ScmSelectedMutationPathSchema),
    kind: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed']),
  })),
}));
export type ScmCommitHookContentChanges = z.infer<typeof ScmCommitHookContentChangesSchema>;
