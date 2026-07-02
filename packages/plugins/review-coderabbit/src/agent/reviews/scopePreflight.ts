import {
  ReviewScmScopeV1Schema,
  type ReviewScmScopeV1,
} from '@happier-dev/plugin-sdk';
import type { ReviewStartInput } from '@happier-dev/protocol';

import { normalizeCodeRabbitReviewStartInput } from './startInput.js';

export type CodeRabbitReviewScopePreflightResult =
  | Readonly<{ ok: true; eligibleFileCount: number }>
  | Readonly<{ ok: false; error: string }>;

export type CodeRabbitReviewScopeFacts = ReviewScmScopeV1;

export function readCodeRabbitReviewScopeFacts(value: unknown): CodeRabbitReviewScopeFacts | null {
  const parsed = ReviewScmScopeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

export function resolveCodeRabbitBaseRef(params: Readonly<{
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
  intentInput: unknown;
  scope?: CodeRabbitReviewScopeFacts | null;
  maxEligibleFiles?: number | null;
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

  let reviewInput: ReviewStartInput;
  try {
    reviewInput = normalizeCodeRabbitReviewStartInput({
      intentInput: params.intentInput ?? {},
      fallbackInstructions: 'Review.',
    });
  } catch {
      return { ok: false, error: 'Invalid CodeRabbit review input.' };
  }

  if (
    (reviewInput.changeType === 'committed' || reviewInput.changeType === 'all')
    && reviewInput.base.kind === 'none'
    && !resolveCodeRabbitBaseRef({ reviewInput, scope })
  ) {
    return { ok: false, error: 'CodeRabbit review requires a host-resolved base ref for committed review scopes.' };
  }

  const eligibleFileCount = selectedPathsForInput({ scope }).length;
  if (eligibleFileCount <= 0) {
    return {
      ok: false,
      error:
        'No reviewable files found in the current session scope. Change the review scope, choose another change type, or start the review from a session rooted at the files you want reviewed.',
    };
  }

  const maxEligibleFiles =
    typeof params.maxEligibleFiles === 'number' && Number.isFinite(params.maxEligibleFiles)
      ? Math.max(1, Math.trunc(params.maxEligibleFiles))
      : null;
  if (maxEligibleFiles !== null && eligibleFileCount > maxEligibleFiles) {
    return {
      ok: false,
      error:
        `Too many reviewable files found in the current session scope for CodeRabbit (${eligibleFileCount} > ${maxEligibleFiles}). Narrow the review scope, choose another change type, or increase HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES if the provider limit has changed.`,
    };
  }

  return { ok: true, eligibleFileCount };
}
