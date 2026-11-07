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
  // Story rereads update membership without requesting repository directories.
  // Omission leaves that independent projection alone; an explicit unavailable
  // directory is a new fact and replaces the previous choices.
  const value = next.propertyChoices === undefined && previous.value?.propertyChoices !== undefined
    ? { ...next, propertyChoices: previous.value.propertyChoices }
    : next;
  if (value.kindId !== 'pull-request' || !value.pullRequestStatus) {
    return { value, checkedAtMs: null, failure: null, refreshing: false };
  }
  const prior = previous.value?.kindId === 'pull-request' ? previous.value.pullRequestStatus : undefined;
  const head = value.pullRequestStatus.branch?.headRevision;
  const baseline = head !== undefined && head === prior?.branch?.headRevision ? prior ?? null : null;
  const reconciled = reconcileTriagePullRequestStatusV1(baseline, value.pullRequestStatus);
  return { value: { ...value, pullRequestStatus: reconciled.value }, checkedAtMs: reconciled.checkedAtMs,
    refreshing: false, failure: null };
}
