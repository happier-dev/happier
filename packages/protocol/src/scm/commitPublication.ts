import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ScmBranchSourceRefSchema } from './remoteNormalization.js';
import { ScmSelectedMutationPathSchema } from './selectedMutationPath.js';

export const ScmCommitOidSchema = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));
export const ScmCommitExpectedRefSchema = lazyZodSchema(() => ScmBranchSourceRefSchema.refine(
  (value) => value.startsWith('refs/'),
  'Expected ref must be a full symbolic Git ref',
).nullable());

/** Null base is unborn; null ref is detached. A candidate alone is never publication evidence. */
export const ScmCommitPublicationSchema = lazyZodSchema(() => z.object({
  state: z.enum(['not_published', 'published', 'unknown']),
  expectedHeadOid: ScmCommitOidSchema.nullable(),
  expectedRef: ScmCommitExpectedRefSchema,
  candidateOid: ScmCommitOidSchema.optional(),
  actualMessage: z.string().optional(),
  indexReconciliation: z.enum(['not_required', 'pending', 'reconciled', 'failed']),
  indexTreeOid: ScmCommitOidSchema.optional(),
  /** The normal hook that stopped the commit or changed its content (pre-commit, commit-msg, …). */
  hookName: z.string().min(1).optional(),
  /** The committer time of the constructed commit object. */
  committedAtMs: z.number().int().nonnegative().optional(),
  /** Whether the writer actually signed the constructed commit object (repository signing policy ran). */
  signed: z.boolean().optional(),
}).strict().superRefine((publication, context) => {
  if (publication.indexTreeOid !== undefined && (publication.state !== 'published' || publication.indexReconciliation !== 'reconciled')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['indexTreeOid'], message: 'Index tree evidence requires successful publication and verified index reconciliation' });
  }
}));
export type ScmCommitPublication = z.infer<typeof ScmCommitPublicationSchema>;

export const ScmCommitHookContentChangesSchema = lazyZodSchema(() => z.object({
  beforeTreeOid: ScmCommitOidSchema,
  afterTreeOid: ScmCommitOidSchema,
  changes: z.array(z.object({
    path: ScmSelectedMutationPathSchema,
    previousPath: ScmSelectedMutationPathSchema.optional(),
    kind: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed']),
  }).strict()),
}).strict());
export type ScmCommitHookContentChanges = z.infer<typeof ScmCommitHookContentChangesSchema>;
