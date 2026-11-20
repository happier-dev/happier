import {
  ReviewScmScopeV1Schema,
  type ReviewScmScopeV1,
  type ReviewStartInput,
} from '@happier-dev/plugin-sdk/reviews';
import { isPluginActionApprovalRequestCreated, type ActionsService,
  type ActionApprovalRequestCreatedResult, type PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import { CODERABBIT_REVIEW_SCOPES } from './profile.js';

export type CodeRabbitReviewScopePreflightResult =
  | Readonly<{ ok: true; eligibleFileCount: number; changeType: ReviewStartInput['changeType'];
      base: Readonly<{ kind: 'branch' | 'commit'; ref: string }> | null }>
  | Readonly<{ ok: false; error: string }>;

export type CodeRabbitReviewScopeFacts = ReviewScmScopeV1;

export function readCodeRabbitReviewScopeFacts(value: unknown): CodeRabbitReviewScopeFacts | null {
  const parsed = ReviewScmScopeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

function resolveCodeRabbitBaseRef(params: Readonly<{
  reviewInput: ReviewStartInput;
  scope?: CodeRabbitReviewScopeFacts | null;
}>): string | null {
  if (params.reviewInput.changeType !== 'committed' && params.reviewInput.changeType !== 'all') return null;
  if (params.reviewInput.base.kind === 'branch') return params.reviewInput.base.baseBranch;
  if (params.reviewInput.base.kind === 'commit') return params.reviewInput.base.baseCommit;
  return params.scope?.baseRef.ref?.trim() || null;
}

function selectedPathsForInput(params: Readonly<{
  scope: CodeRabbitReviewScopeFacts;
}>): readonly string[] {
  return uniquePaths(params.scope.selectedPaths);
}

export async function preflightCodeRabbitReviewScope(params: Readonly<{
  cwd: string;
  reviewInput: ReviewStartInput;
  scope?: CodeRabbitReviewScopeFacts | null;
  actions?: Pick<ActionsService, 'execute'>;
  signal?: AbortSignal;
}>): Promise<CodeRabbitReviewScopePreflightResult> {
  const cwd = String(params.cwd ?? '').trim();
  if (!cwd) return { ok: false, error: 'CodeRabbit review requires a session working directory.' };
  const scope = params.scope ?? null;
  if (!scope) return { ok: false, error: 'CodeRabbit review requires host-resolved SCM scope facts.' };
  if (scope.status !== 'supported') {
    return {
      ok: false,
      error: scope.diagnostics[0]?.message
        || 'CodeRabbit review requires a source-control repository in the current session scope.',
    };
  }
  if (scope.scmMode !== '.git') return { ok: false, error: 'CodeRabbit review requires a git worktree in the current session scope.' };
  const reviewInput = params.reviewInput;

  if (
    !CODERABBIT_REVIEW_SCOPES.includes('paths')
    && ('selectedPaths' in reviewInput || 'selectedFiles' in reviewInput)
  ) {
    return { ok: false, error: 'CodeRabbit cannot review exact file paths; choose a worktree scope or another engine.' };
  }

  const eligibleFileCount = selectedPathsForInput({ scope }).length;
  if (eligibleFileCount <= 0) {
    return {
      ok: false,
      error:
        'No reviewable files found in the current session scope. Change the review scope, choose another change type, or start the review from a session rooted at the files you want reviewed.',
    };
  }

  let changeType = reviewInput.changeType;
  const baseRef = resolveCodeRabbitBaseRef({ reviewInput, scope });
  let base: Readonly<{ kind: 'branch' | 'commit'; ref: string }> | null = baseRef
    ? { kind: reviewInput.base.kind === 'commit' ? 'commit' : 'branch', ref: baseRef } : null;
  if (scope.comparison || scope.revisionRange) {
    const unsupported = { ok: false as const,
      error: 'CodeRabbit requires the captured comparison to match this checkout HEAD and base or whole working-tree scope. Choose another review engine for a different checkout or partial working-tree scope.' };
    if (!params.actions) return { ok: false, error: 'CodeRabbit cannot read live SCM checkout facts for this comparison.' };
    let status: PluginActionResultById['scm.status.snapshot'] | ActionApprovalRequestCreatedResult;
    try {
      status = await params.actions.execute('scm.status.snapshot', { cwd, detail: 'facts', includeWorktreeStatus: false },
        params.signal ? { signal: params.signal } : undefined);
    } catch {
      return { ok: false, error: 'CodeRabbit cannot read live SCM checkout facts for this comparison.' };
    } finally {
      params.signal?.throwIfAborted();
    }
    if (isPluginActionApprovalRequestCreated(status) || !status.success || !status.snapshot?.repo.isRepo
      || status.snapshot.repo.mode !== '.git' || !status.snapshot.branch.headOid) {
      return { ok: false, error: 'CodeRabbit cannot read live SCM checkout facts for this comparison.' };
    }
    if (status.snapshot.repo.rootPath !== scope.repositoryRoot) return unsupported;
    const headOid = status.snapshot.branch.headOid;
    const comparison = scope.comparison;
    if (comparison?.source.kind === 'workingTree') {
      if ((comparison.source.area ?? 'both') !== 'both' || comparison.endpoints.before !== headOid) return unsupported;
      changeType = 'uncommitted';
      base = null;
    } else {
      if (comparison && comparison.source.kind !== 'branch' && comparison.source.kind !== 'commit'
        && comparison.source.kind !== 'revisionRange' && comparison.source.kind !== 'pullRequest') return unsupported;
      const before = comparison?.endpoints.before ?? scope.revisionRange?.baseOid;
      const after = comparison?.endpoints.after ?? scope.revisionRange?.headOid;
      if (!before || after !== headOid) return unsupported;
      changeType = 'committed';
      base = { kind: 'commit', ref: before };
    }
  }
  if ((changeType === 'committed' || changeType === 'all') && !base) {
    return { ok: false, error: 'CodeRabbit review requires a host-resolved base ref for committed review scopes.' };
  }
  return { ok: true, eligibleFileCount, changeType, base };
}
