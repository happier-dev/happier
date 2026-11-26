import { ReviewScmScopeV1Schema, readReviewSelectedPathsV1, resolveCapturedReviewScmScopeV1, unsupportedReviewScmScopeV1 } from '@happier-dev/protocol/reviews/scope';
import { sep } from 'node:path';
import { hasConflictingReviewScope, ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ScmComparisonSchema, ScmRevisionRangeV1Schema } from '@happier-dev/protocol/scm/comparison';
import { resolveScmPullRequestReviewScope } from '@happier-dev/protocol/reviews/scmPullRequestScope';
import { resolveReviewBaseRefV1, resolveReviewComparisonSourceV1 } from '@happier-dev/protocol/reviews/prepareReviewRoundV1';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ReviewBase, ReviewChangeType, ReviewScmScopePathV1, ReviewScmScopeV1, ScmWorkingEntry, ScmWorkingSnapshot } from '@happier-dev/protocol';

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

function parseReviewInput(intentInput: unknown): Readonly<{
  record: ReviewInputRecord;
  changeType: ReviewChangeType;
  base: ReviewBase;
  headRef?: string;
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
      headRef: parsed.data.headRef,
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
  uncommittedPaths: readonly ReviewScmScopePathV1[];
  changedPaths: readonly ReviewScmScopePathV1[];
}>): readonly string[] {
  if (input.explicitPaths.length > 0) return input.explicitPaths;
  if (input.changeType === 'all') {
    return input.changedPaths.map((entry) => entry.path);
  }
  return input.uncommittedPaths.map((entry) => entry.path);
}

export async function resolveReviewScmScope(input: ResolveReviewScmScopeInput): Promise<ReviewScmScopeV1> {
  const workingDirectory = input.workingDirectory ?? input.cwd;
  const resolvedCwd = resolveCwd(input.cwd, workingDirectory);
  if (!resolvedCwd.ok) {
    return unsupportedReviewScmScopeV1({
      code: 'invalid_path',
      message: resolvedCwd.error,
    });
  }

  const record = isRecord(input.intentInput) ? input.intentInput : {};
  if (hasConflictingReviewScope(record)) {
    return unsupportedReviewScmScopeV1({ code: 'scm_status_unavailable', message: 'Repository review scope conflicts with the selected comparison or pull request.' });
  }
  const pullRequest = resolveScmPullRequestReviewScope(record);
  if (pullRequest.status === 'scope_malformed') {
    return unsupportedReviewScmScopeV1({ code: 'scm_status_unavailable', message: 'The selected pull request scope is unreadable.' });
  }
  if (record.comparison !== undefined || record.comparisonId !== undefined) {
    const captured = ScmComparisonSchema.safeParse(record.comparison);
    if (!captured.success || captured.data.id !== record.comparisonId) {
      return unsupportedReviewScmScopeV1({ code: 'scm_status_unavailable', message: 'The selected captured comparison is unavailable.' });
    }
    return resolveCapturedReviewScmScopeV1(captured.data, record);
  }

  const requestedPaths = readReviewSelectedPathsV1(record, sep === '\\' ? 'win32' : 'posix');
  if (!requestedPaths) {
    return unsupportedReviewScmScopeV1({ code: 'invalid_path', message: 'Selected review paths must be repository-relative paths.' });
  }

  if (pullRequest.status === 'scope_present') {
    const observed = pullRequest.scope.observed;
    const range = ScmRevisionRangeV1Schema.safeParse({ kind: 'revisionRange',
      baseOid: observed.baseSha, headOid: observed.headSha });
    if (!range.success) {
      return unsupportedReviewScmScopeV1({ code: 'scm_status_unavailable', message: 'The selected pull request has no supported revision range.' });
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
      return unsupportedReviewScmScopeV1({
        code: 'not_repository',
        message: 'Review scope requires a source-control repository in the current session directory.',
      });
    }

    const reviewInput = parseReviewInput(input.intentInput);
    const scope = reviewInput.record.scope === 'repository' ? 'repository' : 'changes';
    const capturesCommittedBranch = scope === 'changes' && reviewInput.changeType === 'committed';
    const status = await selected.selection.backend.statusSnapshot({
      context: selected.context,
      request: { cwd: resolvedCwd.cwd, includeWorktreeStatus: !capturesCommittedBranch },
    });
    if (!status.success || !status.snapshot || !status.snapshot.repo.isRepo) {
      return unsupportedReviewScmScopeV1({
        code: status.errorCode === 'INVALID_PATH' ? 'invalid_path' : 'scm_status_unavailable',
        message: status.error || 'SCM status snapshot is unavailable for the current review scope.',
      });
    }

    if (capturesCommittedBranch) {
      const source = await resolveReviewComparisonSourceV1({ ...reviewInput, source: reviewInput.record.source }, async () => status.snapshot);
      const captured = await captureScmComparison({ cwd: resolvedCwd.cwd, source: source!, registry });
      return resolveCapturedReviewScmScopeV1(captured.comparison, reviewInput.record);
    }
    const changedPaths = status.snapshot.entries.map((entry) => toReviewScopePath({
      entry,
      snapshot: status.snapshot!,
    }));
    const committedPaths = changedPaths.filter((entry) => entry.hasCommittedDelta);
    const uncommittedPaths = changedPaths.filter((entry) => entry.hasUncommittedDelta);
    const explicitPaths = requestedPaths;
    const selectedPaths = scope === 'repository' ? [] : uniqueSafePaths(selectPathsForChangeType({
      explicitPaths,
      changeType: reviewInput.changeType,
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
      baseRef: resolveReviewBaseRefV1(reviewInput.base, status.snapshot),
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
