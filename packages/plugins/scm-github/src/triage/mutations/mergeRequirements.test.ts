import { TriagePullRequestStatusV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { classifyGithubPullRequestMergeRequirementsV1 } from './mergeRequirements.js';

describe('merge requirement evidence completeness', () => {
  it('does not accept a complete flag that contradicts a retained failure or incomplete review', () => {
    const input = {
      kind: 'status', observedAtMs: 1,
      checks: { state: 'complete', passed: 0, failed: 1, pending: 0, total: 1, incomplete: false,
        rows: [{ id: 'native-check', name: 'Required build', state: 'failed', required: true }] },
      review: { decision: 'approved', reviewers: [], incomplete: false },
      merge: { state: 'blocked', blocker: null, nativeState: 'UNSTABLE', draft: false },
      branch: null, facts: [],
    };
    expect(classifyGithubPullRequestMergeRequirementsV1(TriagePullRequestStatusV1Schema.parse(input)).complete).toBe(true);
    const failed = TriagePullRequestStatusV1Schema.parse({ ...input,
      checks: { ...input.checks, failure: { class: 'permission', code: 'github_forbidden' } },
    });
    expect(classifyGithubPullRequestMergeRequirementsV1(failed).complete).toBe(false);
    const incompleteReview = TriagePullRequestStatusV1Schema.parse({ ...input,
      review: { ...input.review, incomplete: true },
    });
    expect(classifyGithubPullRequestMergeRequirementsV1(incompleteReview).complete).toBe(false);
  });
});
