import { ReviewScmScopeV1Schema } from '@happier-dev/protocol/reviews/scope';
import { hasConflictingReviewScope, ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ScmComparisonSchema, ScmRevisionRangeV1Schema } from '@happier-dev/protocol/scm/comparison';
import { resolveScmPullRequestReviewScope } from '@happier-dev/protocol/reviews/scmPullRequestScope';
import { ScmEntryKindSchema } from '@happier-dev/protocol/scm/workingSnapshot';
import type { ReviewBase, ReviewChangeType, ReviewScmScopeBaseRefV1, ReviewScmScopeDiagnosticCodeV1, ReviewScmScopeDiagnosticV1, ReviewScmScopePathV1, ReviewScmScopeV1, ScmWorkingEntry, ScmWorkingSnapshot } from '@happier-dev/protocol';

import { resolveScmSelection } from '@/scm/resolveScmSelection';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import type { ScmBackendRegistry } from '@/scm/registry';
import { normalizeRepoRootRelativePath, resolveCwd } from '@/scm/runtime';

type ReviewInputRecord = Readonly<Record<string, unknown>>;

export type ResolveReviewScmScopeInput = Readonly<{
  cwd: string;
  workingDirectory?: string;
  intentInput?: unknown;
  registry?: ScmBackendRegistry;
}>;

function isRecord(value: unknown): value is ReviewInputRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function unsupportedScope(input: Readonly<{
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

function parseReviewInput(intentInput: unknown): Readonly<{
  record: ReviewInputRecord;
  changeType: ReviewChangeType;
  base: ReviewBase;
}> {
  const raw = isRecord(intentInput) ? intentInput : {};
  const parsed = ReviewStartInputSchema.safeParse({
    reviewers: [{ kind: 'engine', engineId: 'review-scope' }],
    instructions: 'Review.',
    ...raw,
  });
  if (parsed.success) {
    return {
      record: parsed.data,
      changeType: parsed.data.changeType,
      base: parsed.data.base,
    };
  }
  return {
    record: raw,
    changeType: 'uncommitted',
    base: { kind: 'none' },
  };
}

function uniqueSafePaths(paths: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRepoRootRelativePath(path);
    if (!normalized.ok) continue;
    if (seen.has(normalized.relativePath)) continue;
    seen.add(normalized.relativePath);
    out.push(normalized.relativePath);
  }
  return out;
}

function explicitSelectedPaths(record: ReviewInputRecord): readonly string[] | null {
  const selected = new Set<string>();
  for (const key of ['selectedPaths', 'selectedFiles'] as const) {
    const paths = record[key];
    if (paths === undefined) continue;
    if (!Array.isArray(paths)) return null;
    for (const path of paths) {
      const normalized = typeof path === 'string' ? normalizeRepoRootRelativePath(path) : null;
      if (!normalized?.ok) return null;
      selected.add(normalized.relativePath);
    }
  }
  return [...selected];
}

function resolveBaseRef(input: Readonly<{
  base: ReviewBase;
  snapshot: ScmWorkingSnapshot;
}>): ReviewScmScopeBaseRefV1 {
  if (input.base.kind === 'branch') {
    return { source: 'explicit', ref: input.base.baseBranch };
  }
  if (input.base.kind === 'commit') {
    return { source: 'explicit', ref: input.base.baseCommit };
  }
  const upstream = readString(input.snapshot.branch.upstream);
  if (upstream) {
    return { source: 'branch_upstream', ref: upstream };
  }
  const defaultBranch = readString(input.snapshot.repo.defaultBranch);
  if (defaultBranch) {
    return { source: 'default_branch', ref: defaultBranch };
  }
  return { source: 'unavailable', ref: null };
}

function diffAvailable(input: Readonly<{
  area: 'committed' | 'uncommitted';
  snapshot: ScmWorkingSnapshot;
  entry?: ScmWorkingEntry;
}>): boolean {
  if (!input.snapshot.capabilities.readDiffFile) return false;
  if (input.entry?.stats.isBinary) return false;
  const areas = input.snapshot.capabilities.supportedDiffAreas;
  if (input.area === 'committed') {
    return areas.includes('included') || areas.includes('both');
  }
  return areas.includes('pending') || areas.includes('both');
}

function toReviewScopePath(input: Readonly<{
  entry: ScmWorkingEntry;
  snapshot: ScmWorkingSnapshot;
}>): ReviewScmScopePathV1 {
  return {
    path: input.entry.path,
    previousPath: input.entry.previousPath,
    kind: input.entry.kind,
    hasCommittedDelta: input.entry.hasIncludedDelta,
    hasUncommittedDelta: input.entry.hasPendingDelta,
    diff: {
      committedAvailable: input.entry.hasIncludedDelta && diffAvailable({
        area: 'committed',
        snapshot: input.snapshot,
        entry: input.entry,
      }),
      uncommittedAvailable: input.entry.hasPendingDelta && diffAvailable({
        area: 'uncommitted',
        snapshot: input.snapshot,
        entry: input.entry,
      }),
      isBinary: input.entry.stats.isBinary,
    },
  };
}

function selectPathsForChangeType(input: Readonly<{
  explicitPaths: readonly string[];
  changeType: ReviewChangeType;
  committedPaths: readonly ReviewScmScopePathV1[];
  uncommittedPaths: readonly ReviewScmScopePathV1[];
  changedPaths: readonly ReviewScmScopePathV1[];
}>): readonly string[] {
  if (input.explicitPaths.length > 0) return input.explicitPaths;
  if (input.changeType === 'committed') {
    return input.committedPaths.map((entry) => entry.path);
  }
  if (input.changeType === 'all') {
    return input.changedPaths.map((entry) => entry.path);
  }
  return input.uncommittedPaths.map((entry) => entry.path);
}

export async function resolveReviewScmScope(input: ResolveReviewScmScopeInput): Promise<ReviewScmScopeV1> {
  const workingDirectory = input.workingDirectory ?? input.cwd;
  const resolvedCwd = resolveCwd(input.cwd, workingDirectory);
  if (!resolvedCwd.ok) {
    return unsupportedScope({
      code: 'invalid_path',
      message: resolvedCwd.error,
    });
  }

  const record = isRecord(input.intentInput) ? input.intentInput : {};
  if (hasConflictingReviewScope(record)) {
    return unsupportedScope({ code: 'scm_status_unavailable', message: 'Repository review scope conflicts with the selected comparison or pull request.' });
  }
  const requestedPaths = explicitSelectedPaths(record);
  if (!requestedPaths) {
    return unsupportedScope({ code: 'invalid_path', message: 'Selected review paths must be repository-relative paths.' });
  }
  const pullRequest = resolveScmPullRequestReviewScope(record);
  if (pullRequest.status === 'scope_malformed') {
    return unsupportedScope({ code: 'scm_status_unavailable', message: 'The selected pull request scope is unreadable.' });
  }
  if (record.comparison !== undefined || record.comparisonId !== undefined) {
    const captured = ScmComparisonSchema.safeParse(record.comparison);
    if (!captured.success || captured.data.id !== record.comparisonId) {
      return unsupportedScope({ code: 'scm_status_unavailable', message: 'The selected captured comparison is unavailable.' });
    }
    const comparison = captured.data;
    const filesByPath = new Map(comparison.inventory.files.map(file => [file.path, file]));
    if (requestedPaths.some(path => !filesByPath.has(path))) {
      return unsupportedScope({ code: 'invalid_path', message: 'A selected review path is outside the captured comparison.' });
    }
    const selectedPaths = [...new Set(requestedPaths.length ? requestedPaths : filesByPath.keys())];
    const workingTree = comparison.source.kind === 'workingTree';
    const changedPaths = selectedPaths.map(path => {
      const file = filesByPath.get(path)!;
      const available = file.evidence.state === 'available' && file.binary === false;
      const kind = ScmEntryKindSchema.safeParse(file.changeKind);
      return { path, previousPath: file.previousPath ?? null, kind: kind.success ? kind.data : 'modified' as const,
        hasCommittedDelta: !workingTree, hasUncommittedDelta: workingTree,
        diff: { committedAvailable: !workingTree && available, uncommittedAvailable: workingTree && available,
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

  if (pullRequest.status === 'scope_present') {
    const observed = pullRequest.scope.observed;
    const range = ScmRevisionRangeV1Schema.safeParse({ kind: 'revisionRange',
      baseOid: observed.baseSha, headOid: observed.headSha });
    if (!range.success) {
      return unsupportedScope({ code: 'scm_status_unavailable', message: 'The selected pull request has no supported revision range.' });
    }
    return ReviewScmScopeV1Schema.parse({ kind: 'review_scm_scope.v1', scope: 'changes', status: 'supported',
      scmBackendId: 'git', scmMode: '.git', repositoryRoot: resolvedCwd.cwd, worktreeRoot: resolvedCwd.cwd,
      baseRef: { source: 'explicit', ref: range.data.baseOid }, revisionRange: range.data,
      selectedPaths: requestedPaths, changedPaths: [], committedPaths: [], uncommittedPaths: [],
      diff: { committedAvailable: true, uncommittedAvailable: false }, diagnostics: [] });
  }

  return runWithScmBackendRegistryLease(input.registry, async (registry) => {
    const selected = await resolveScmSelection({
      workingDirectory,
      cwd: resolvedCwd.cwd,
      registry,
    });
    if (!selected) {
      return unsupportedScope({
        code: 'not_repository',
        message: 'Review scope requires a source-control repository in the current session directory.',
      });
    }

    const status = await selected.selection.backend.statusSnapshot({
      context: selected.context,
      request: { cwd: resolvedCwd.cwd, includeWorktreeStatus: true },
    });
    if (!status.success || !status.snapshot || !status.snapshot.repo.isRepo) {
      return unsupportedScope({
        code: status.errorCode === 'INVALID_PATH' ? 'invalid_path' : 'scm_status_unavailable',
        message: status.error || 'SCM status snapshot is unavailable for the current review scope.',
      });
    }

    const reviewInput = parseReviewInput(input.intentInput);
    const changedPaths = status.snapshot.entries.map((entry) => toReviewScopePath({
      entry,
      snapshot: status.snapshot!,
    }));
    const committedPaths = changedPaths.filter((entry) => entry.hasCommittedDelta);
    const uncommittedPaths = changedPaths.filter((entry) => entry.hasUncommittedDelta);
    const explicitPaths = requestedPaths;
    const scope = reviewInput.record.scope === 'repository' ? 'repository' : 'changes';
    const selectedPaths = scope === 'repository' ? [] : uniqueSafePaths(selectPathsForChangeType({
      explicitPaths,
      changeType: reviewInput.changeType,
      committedPaths,
      uncommittedPaths,
      changedPaths,
    }));

    return ReviewScmScopeV1Schema.parse({
      kind: 'review_scm_scope.v1',
      scope,
      status: 'supported',
      scmBackendId: status.snapshot.repo.backendId ?? selected.selection.backend.id,
      scmMode: status.snapshot.repo.mode ?? selected.selection.mode,
      repositoryRoot: status.snapshot.repo.rootPath ?? selected.context.detection.rootPath,
      worktreeRoot: status.snapshot.repo.rootPath ?? selected.context.detection.rootPath,
      baseRef: resolveBaseRef({ base: reviewInput.base, snapshot: status.snapshot }),
      selectedPaths,
      committedPaths,
      uncommittedPaths,
      changedPaths,
      diff: {
        committedAvailable: committedPaths.some((entry) => entry.diff.committedAvailable),
        uncommittedAvailable: uncommittedPaths.some((entry) => entry.diff.uncommittedAvailable),
      },
      diagnostics: [],
    });
  });
}
