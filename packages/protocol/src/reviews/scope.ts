import { normalizeScmRepoRootRelativePath } from '../scm/pathScope.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ScmBackendIdSchema } from '../scm/backendIdentity.js';
import { ScmComparisonSchema, ScmRevisionRangeV1Schema, type ScmComparison } from '../scm/comparison.js';
import { ScmEntryKindSchema, ScmRepoModeSchema } from '../scm/workingSnapshot.js';

export const ReviewScopeSchema = lazyZodSchema(() => z.enum(['changes', 'repository']));
export type ReviewScope = z.infer<typeof ReviewScopeSchema>;

export const ReviewScmScopeDiagnosticCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_path',
  'not_repository',
  'scm_status_unavailable',
]));
export type ReviewScmScopeDiagnosticCodeV1 = z.infer<typeof ReviewScmScopeDiagnosticCodeV1Schema>;

export const ReviewScmScopeDiagnosticV1Schema = lazyZodSchema(() => z.looseObject({
  code: ReviewScmScopeDiagnosticCodeV1Schema,
  severity: z.enum(['warning', 'error']),
  message: z.string().check(z.minLength(1)),
}));
export type ReviewScmScopeDiagnosticV1 = z.infer<typeof ReviewScmScopeDiagnosticV1Schema>;

export const ReviewScmScopeBaseRefSourceV1Schema = lazyZodSchema(() => z.enum([
  'explicit',
  'branch_upstream',
  'default_branch',
  'unavailable',
]));
export type ReviewScmScopeBaseRefSourceV1 = z.infer<typeof ReviewScmScopeBaseRefSourceV1Schema>;

export const ReviewScmScopeBaseRefV1Schema = lazyZodSchema(() => z.looseObject({
  source: ReviewScmScopeBaseRefSourceV1Schema,
  ref: z.nullable(z.string().check(z.minLength(1))),
}));
export type ReviewScmScopeBaseRefV1 = z.infer<typeof ReviewScmScopeBaseRefV1Schema>;

export const ReviewScmScopePathDiffV1Schema = lazyZodSchema(() => z.looseObject({
  committedAvailable: z.boolean(),
  uncommittedAvailable: z.boolean(),
  isBinary: z.boolean(),
}));
export type ReviewScmScopePathDiffV1 = z.infer<typeof ReviewScmScopePathDiffV1Schema>;

export const ReviewScmScopePathV1Schema = lazyZodSchema(() => z.looseObject({
  path: z.string().check(z.minLength(1)),
  previousPath: z.nullable(z.string().check(z.minLength(1))),
  kind: ScmEntryKindSchema,
  hasCommittedDelta: z.boolean(),
  hasUncommittedDelta: z.boolean(),
  diff: ReviewScmScopePathDiffV1Schema,
}));
export type ReviewScmScopePathV1 = z.infer<typeof ReviewScmScopePathV1Schema>;

export const ReviewScmScopeDiffV1Schema = lazyZodSchema(() => z.looseObject({
  committedAvailable: z.boolean(),
  uncommittedAvailable: z.boolean(),
  byteLimit: z.optional(z.nullable(z.number().check(z.int(), z.positive()))),
}));
export type ReviewScmScopeDiffV1 = z.infer<typeof ReviewScmScopeDiffV1Schema>;

export const ReviewScmScopeV1Schema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('review_scm_scope.v1'),
  scope: z.optional(ReviewScopeSchema),
  status: z.enum(['supported', 'unsupported']),
  scmBackendId: z.nullable(ScmBackendIdSchema),
  scmMode: z.nullable(ScmRepoModeSchema),
  repositoryRoot: z.nullable(z.string().check(z.minLength(1))),
  worktreeRoot: z.nullable(z.string().check(z.minLength(1))),
  baseRef: ReviewScmScopeBaseRefV1Schema,
  // Bodies remain in the admitted comparison input; adapters consume its captured identity/endpoints.
  comparison: z.optional(z.strictObject({ id: ScmComparisonSchema.shape.id,
    source: ScmComparisonSchema.shape.source, endpoints: ScmComparisonSchema.shape.endpoints })),
  revisionRange: z.optional(ScmRevisionRangeV1Schema),
  selectedPaths: z.array(z.string().check(z.minLength(1))),
  committedPaths: z.array(ReviewScmScopePathV1Schema),
  uncommittedPaths: z.array(ReviewScmScopePathV1Schema),
  changedPaths: z.array(ReviewScmScopePathV1Schema),
  diff: ReviewScmScopeDiffV1Schema,
  diagnostics: z.array(ReviewScmScopeDiagnosticV1Schema),
}));
export type ReviewScmScopeV1 = z.infer<typeof ReviewScmScopeV1Schema>;

export function unsupportedReviewScmScopeV1(input: Readonly<{
  code: ReviewScmScopeDiagnosticCodeV1;
  message: string;
  severity?: ReviewScmScopeDiagnosticV1['severity'];
}>): ReviewScmScopeV1 {
  return ReviewScmScopeV1Schema.parse({
    kind: 'review_scm_scope.v1',
    status: 'unsupported',
    scmBackendId: null,
    scmMode: null,
    repositoryRoot: null,
    worktreeRoot: null,
    baseRef: { source: 'unavailable', ref: null },
    selectedPaths: [],
    committedPaths: [],
    uncommittedPaths: [],
    changedPaths: [],
    diff: { committedAvailable: false, uncommittedAvailable: false },
    diagnostics: [{
      code: input.code,
      severity: input.severity ?? 'error',
      message: input.message,
    }],
  });
}

export function readReviewSelectedPathsV1(record: Readonly<Record<string, unknown>>, pathStyle: 'posix' | 'win32'): readonly string[] | null {
  const selected = new Set<string>();
  for (const key of ['selectedPaths', 'selectedFiles'] as const) {
    const paths = record[key];
    if (paths === undefined) continue;
    if (!Array.isArray(paths)) return null;
    for (const path of paths) {
      const normalized = typeof path === 'string' ? normalizeScmRepoRootRelativePath(path, pathStyle) : null;
      if (!normalized?.ok) return null;
      selected.add(normalized.relativePath);
    }
  }
  return [...selected];
}

export function resolveCapturedReviewScmScopeV1(comparison: ScmComparison, record: Readonly<Record<string, unknown>>): ReviewScmScopeV1 {
  const pathStyle = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(comparison.repository.rootPath) ? 'win32' : 'posix';
  const requestedPaths = readReviewSelectedPathsV1(record, pathStyle);
  if (!requestedPaths) return unsupportedReviewScmScopeV1({ code: 'invalid_path', message: 'Selected review paths must be repository-relative paths.' });
  const filesByPath = new Map(comparison.inventory.files.map(file => [file.path, file]));
  if (requestedPaths.some(path => !filesByPath.has(path))) {
    return unsupportedReviewScmScopeV1({ code: 'invalid_path', message: 'A selected review path is outside the captured comparison.' });
  }
  const selectedPaths = [...new Set(requestedPaths.length ? requestedPaths : filesByPath.keys())];
  const workingTree = comparison.source.kind === 'workingTree';
  const committed = !workingTree || comparison.source.area === 'included';
  const uncommitted = workingTree && comparison.source.area !== 'included';
  const changedPaths = selectedPaths.map(path => {
    const file = filesByPath.get(path)!;
    const available = file.evidence.state === 'available' && file.binary === false;
    const kind = ScmEntryKindSchema.safeParse(file.changeKind);
    return { path, previousPath: file.previousPath ?? null, kind: kind.success ? kind.data : 'modified' as const,
      hasCommittedDelta: committed, hasUncommittedDelta: uncommitted,
      diff: { committedAvailable: committed && available, uncommittedAvailable: uncommitted && available,
        isBinary: file.binary === true } };
  });
  return ReviewScmScopeV1Schema.parse({ kind: 'review_scm_scope.v1', scope: 'changes', status: 'supported',
    scmBackendId: 'git', scmMode: '.git', repositoryRoot: comparison.repository.rootPath,
    worktreeRoot: comparison.repository.rootPath,
    baseRef: { source: comparison.endpoints.before ? 'explicit' : 'unavailable', ref: comparison.endpoints.before ?? null },
    comparison: { id: comparison.id, source: comparison.source, endpoints: comparison.endpoints },
    selectedPaths, changedPaths, committedPaths: changedPaths.filter(path => path.hasCommittedDelta),
    uncommittedPaths: changedPaths.filter(path => path.hasUncommittedDelta),
    diff: { committedAvailable: changedPaths.some(path => path.diff.committedAvailable),
      uncommittedAvailable: changedPaths.some(path => path.diff.uncommittedAvailable) }, diagnostics: [] });
}
