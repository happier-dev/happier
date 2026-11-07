import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';

import type { GithubSkippedRequirementV1 } from './contracts.js';

export type GithubPullRequestMergeRequirementsV1 = Readonly<{
  unmetRequirements: readonly GithubSkippedRequirementV1[];
  /** All skipped requirements can be named; this is never merge permission. */
  complete: boolean;
  structuralRefusal?: 'not_mergeable';
}>;

/** The one requirements decision consumed by admission and source presentation. */
export function classifyGithubPullRequestMergeRequirementsV1(
  status: TriagePullRequestStatusV1,
): GithubPullRequestMergeRequirementsV1 {
  const unmetRequirements: GithubSkippedRequirementV1[] = [];
  const merge = status.merge;
  const nativeState = merge?.nativeState;
  if (merge?.draft === true || nativeState === 'DRAFT' || nativeState === 'DIRTY' || merge?.state === 'conflicts') {
    return { unmetRequirements, complete: false, structuralRefusal: 'not_mergeable' };
  }

  for (const row of status.checks?.rows ?? []) {
    if (row.required === true && (row.state === 'failed' || row.state === 'pending')) {
      unmetRequirements.push({ kind: 'check', id: row.id, label: row.name });
    }
  }
  if (status.review?.decision === 'changesRequested' || status.review?.decision === 'reviewRequired') {
    unmetRequirements.push({ kind: 'review', id: 'github:review',
      label: status.review.decision === 'changesRequested' ? 'Changes requested' : 'Required review' });
  }
  if (merge?.queueRequired === true) {
    unmetRequirements.push({ kind: 'queue', id: 'github:merge-queue', label: 'Merge queue required' });
  }
  if (nativeState === 'BEHIND' && merge?.upToDateRequired === true) {
    unmetRequirements.push({ kind: 'policy', id: 'github:up-to-date', label: 'Branch must be up to date' });
  }

  // BLOCKED is an affirmative provider decision even when its finer reason is
  // unreadable. A generic native explanation cannot acknowledge an exact scope.
  const providerBlocked = nativeState === 'BLOCKED' || merge?.state === 'blocked';
  const unexplainedBlock = providerBlocked && unmetRequirements.length === 0;
  if (unexplainedBlock) {
    unmetRequirements.push({ kind: 'policy', id: 'github:merge-state:BLOCKED', label: 'Blocked on GitHub' });
  }
  const checksKnown = status.checks !== null && !status.checks.incomplete && status.checks.failure === undefined
    && (status.checks.state === 'complete' || status.checks.state === 'none')
    && status.checks.rows.every((row) => typeof row.required === 'boolean' && row.state !== 'unknown');
  // Named native blockers explain BLOCKED. An unknown queue-required bit does
  // not invent another unmet requirement or assert that the viewer is exempt.
  const nativeScopeKnown = nativeState === 'CLEAN' || nativeState === 'HAS_HOOKS' || nativeState === 'UNSTABLE'
    || (nativeState === 'BLOCKED' && !unexplainedBlock)
    || (nativeState === 'BEHIND' && merge?.upToDateRequired === true);
  // These three rule families have native evidence above. Other applicable
  // rules have no per-rule outcome in this read, so their skipped scope remains
  // unknown; merely listing a rule never means it is currently unmet.
  const policyScopeKnown = merge?.branchRules === undefined || merge.branchRules.state === 'complete'
    && merge.branchRules.rows.every((row) => row.type === 'required_status_checks'
      || row.type === 'merge_queue'
      // reviewDecision reports approval policy, not conversation resolution.
      // With that separate enforcement active or unreadable, the current read
      // cannot establish whether this acknowledgement names every skipped rule.
      || row.type === 'pull_request' && row.reviewThreadResolutionRequired === false);
  return {
    unmetRequirements,
    complete: !unexplainedBlock && !status.projectionTruncated && checksKnown && nativeScopeKnown
      && status.review !== null && !status.review.incomplete && status.review.decision !== null
      && policyScopeKnown,
  };
}

/** Order does not change the acknowledged set; duplicate or changed names do. */
export function githubMergeRequirementAcknowledgementMatchesV1(
  acknowledged: readonly GithubSkippedRequirementV1[],
  current: readonly GithubSkippedRequirementV1[],
): boolean {
  if (acknowledged.length !== current.length) return false;
  const remaining = new Map(current.map((requirement) => [`${requirement.kind}:${requirement.id}`, requirement.label]));
  for (const requirement of acknowledged) {
    const key = `${requirement.kind}:${requirement.id}`;
    if (remaining.get(key) !== requirement.label) return false;
    remaining.delete(key);
  }
  return remaining.size === 0;
}
