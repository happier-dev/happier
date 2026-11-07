import { describe, expect, it } from 'vitest';
import { TriagePullRequestStatusV1Schema } from '@happier-dev/triage-protocol/v1';
import { settleGithubOverviewReadV1 } from './overviewState.js';
import type { GithubOverviewResultV1 } from '../../triage/detail/contracts.js';

function overview(observedAtMs: number, headRevision = 'a'.repeat(40)): Extract<GithubOverviewResultV1, { kind: 'overview'; kindId: 'pull-request' }> {
  return { kind: 'overview', kindId: 'pull-request', observedAtMs,
    branchUpdateEligibility: 'unknown', headRevision,
    pullRequestStatus: TriagePullRequestStatusV1Schema.parse({ kind: 'status', observedAtMs,
      checks: { state: 'complete', passed: 1, failed: 0, pending: 0, total: 1, incomplete: false,
        rows: [{ id: 'check:1', name: 'Build', state: 'passed', required: true }] },
      review: { decision: 'approved', reviewers: [], incomplete: false },
      merge: { state: 'mergeable', blocker: null, nativeState: 'CLEAN', draft: false },
      branch: { head: 'topic', base: 'main', headRevision }, facts: [] }) };
}

describe('mounted exact overview native status retention', () => {
  it('keeps semantic status for equal successful observations and advances only the successful check clock', () => {
    let state = settleGithubOverviewReadV1({ value: null, checkedAtMs: null, failure: null, refreshing: true }, overview(1));
    const first = state.value?.kindId === 'pull-request' ? state.value.pullRequestStatus : undefined;
    let statusPublications = 0;
    for (let time = 2; time <= 12; time += 1) {
      state = settleGithubOverviewReadV1(state, overview(time));
      const status = state.value?.kindId === 'pull-request' ? state.value.pullRequestStatus : undefined;
      statusPublications += Number(status !== first);
      expect(state.checkedAtMs).toBe(time);
      expect(status?.checks).toBe(first?.checks);
    }
    expect(statusPublications).toBe(0);
    const stale = settleGithubOverviewReadV1(state, { kind: 'unavailable', failure: { class: 'transient', code: 'read-failed' } });
    expect(stale.value).toBe(state.value);
    expect(stale.checkedAtMs).toBe(12);
    expect(stale.failure?.code).toBe('read-failed');
  });

  it('does not carry a semantic baseline across a changed head', () => {
    const first = settleGithubOverviewReadV1({ value: null, checkedAtMs: null, failure: null, refreshing: false }, overview(1));
    const next = overview(2, 'b'.repeat(40));
    const changed = settleGithubOverviewReadV1(first, next);
    expect(changed.value?.kindId === 'pull-request' && changed.value.pullRequestStatus).toBe(next.pullRequestStatus);
  });
});
