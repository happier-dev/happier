import { reconcileTriagePullRequestStatusV1, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubOverviewResultV1 } from '../../triage/detail/contracts.js';

export type GithubOverviewReadStateV1 = Readonly<{
  value: Extract<GithubOverviewResultV1, { kind: 'overview' }> | null;
  checkedAtMs: number | null;
  failure: TriageSourceFailureV1 | null;
  refreshing: boolean;
}>;

/** The mounted producer supplies a baseline only inside its same admitted scope. */
export function settleGithubOverviewReadV1(previous: GithubOverviewReadStateV1, next: GithubOverviewResultV1): GithubOverviewReadStateV1 {
  if (next.kind === 'unavailable') return { ...previous, refreshing: false, failure: next.failure };
  if (next.kindId !== 'pull-request' || !next.pullRequestStatus) {
    return { value: next, checkedAtMs: null, failure: null, refreshing: false };
  }
  const prior = previous.value?.kindId === 'pull-request' ? previous.value.pullRequestStatus : undefined;
  const head = next.pullRequestStatus.branch?.headRevision;
  const baseline = head !== undefined && head === prior?.branch?.headRevision ? prior ?? null : null;
  const reconciled = reconcileTriagePullRequestStatusV1(baseline, next.pullRequestStatus);
  return { value: { ...next, pullRequestStatus: reconciled.value }, checkedAtMs: reconciled.checkedAtMs,
    refreshing: false, failure: null };
}
