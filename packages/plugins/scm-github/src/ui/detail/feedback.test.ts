import type { TriageRowFactV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { GithubFeedbackCommentV1 } from '../../triage/feedback.js';

import { projectGithubFeedback } from './feedback.js';

const OBSERVED_AT_MS = 1_760_000_700_000;

function statusFact(
  id: string,
  value: string,
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral',
): TriageRowFactV1 {
  return Object.freeze({
    id,
    importance: 'primary',
    value: Object.freeze({ kind: 'status', value, tone }),
  });
}

function comment(
  overrides: Partial<GithubFeedbackCommentV1> & Pick<GithubFeedbackCommentV1, 'id'>,
): GithubFeedbackCommentV1 {
  return Object.freeze({
    author: null,
    body: 'a comment',
    createdAtMs: null,
    url: null,
    ...overrides,
  });
}

describe('the GitHub feedback projection', () => {
  it('replaces stale review and check facts with the current review and check reads, while retaining mergeability', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [
        // These arrived with the applied observation. The detail reads below are
        // newer, so retaining either would give the Feedback panel two answers.
        statusFact('github/review-decision', 'Approved', 'success'),
        statusFact('github/checks', 'All passing', 'success'),
        statusFact('github/mergeability', 'Conflicts', 'danger'),
      ],
      comments: [
        comment({
          id: 'github-issue-comment:11',
          author: 'octocat',
          body: 'This normalizer is duplicated.',
          createdAtMs: OBSERVED_AT_MS - 20_000,
          url: 'https://github.com/octo-org/example-app/pull/1284#issuecomment-11',
        }),
      ],
      historicalReviews: [{
        id: 'PRR_11',
        author: 'octocat',
        body: 'This normalizer is duplicated.',
        state: 'CHANGES_REQUESTED',
        submittedAtMs: OBSERVED_AT_MS - 10_000,
        url: null,
      }],
      threads: [],
      reviewDecision: 'changes-requested',
      requests: [{ kind: 'team', subject: 'Client Platform' }],
      checks: { kind: 'failing', failingCount: 3 },
    });

    expect(view.review).toEqual({
      kind: 'decided',
      label: 'Changes requested',
      tone: 'danger',
    });
    expect(view.people).toEqual({
      reviewed: [{
        login: 'octocat',
        state: 'CHANGES_REQUESTED',
        submittedAtMs: OBSERVED_AT_MS - 10_000,
      }],
      requested: [{ kind: 'team', subject: 'Client Platform' }],
    });
    expect(view.findings).toEqual([
      {
        resource: 'comment',
        kind: 'remark',
        id: 'github-issue-comment:11',
        atMs: OBSERVED_AT_MS - 20_000,
        author: 'octocat',
        body: 'This normalizer is duplicated.',
        webUrl: 'https://github.com/octo-org/example-app/pull/1284#issuecomment-11',
        truncated: false,
      },
      {
        resource: 'review',
        kind: 'remark',
        id: 'PRR_11',
        atMs: OBSERVED_AT_MS - 10_000,
        author: 'octocat',
        body: 'This normalizer is duplicated.',
        state: 'CHANGES_REQUESTED',
        webUrl: null,
        truncated: false,
      },
      {
        resource: 'state',
        kind: 'check',
        id: 'github/checks',
        atMs: OBSERVED_AT_MS,
        label: '3 failing',
        tone: 'danger',
      },
      {
        resource: 'state',
        kind: 'conflict',
        id: 'github/mergeability',
        atMs: OBSERVED_AT_MS,
        label: 'Conflicts',
        tone: 'danger',
      },
    ]);
  });

  it('does not retain stale snapshot review or check state while their live reads are unsettled', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [
        statusFact('github/review-decision', 'Approved', 'success'),
        statusFact('github/checks', 'All passing', 'success'),
        statusFact('github/mergeability', 'Conflicts', 'danger'),
      ],
      comments: [],
      historicalReviews: [],
      threads: [],
      reviewDecision: null,
      requests: [],
      checks: null,
    });

    expect(view.review).toEqual({ kind: 'unresolved' });
    expect(view.people).toEqual({ reviewed: [], requested: [] });
    expect(view.findings).toEqual([{
      resource: 'state',
      kind: 'conflict',
      id: 'github/mergeability',
      atMs: OBSERVED_AT_MS,
      label: 'Conflicts',
      tone: 'danger',
    }]);
  });

  it('uses a reviewer submittedAtMs and leaves requested-review time absent', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [],
      historicalReviews: [{
        id: 'PRR_1', author: 'octocat', body: '', state: 'APPROVED',
        submittedAtMs: 300, url: null,
      }],
      threads: [],
      reviewDecision: 'approved',
      requests: [{ kind: 'team', subject: 'Client Platform' }],
      checks: null,
    });

    expect(view.people).toEqual({
      reviewed: [{ login: 'octocat', state: 'APPROVED', submittedAtMs: 300 }],
      requested: [{ kind: 'team', subject: 'Client Platform' }],
    });
  });

  it('orders comments and current adverse state findings by time', () => {
    const view = projectGithubFeedback({
      observedAtMs: 500,
      facts: [
        statusFact('github/mergeability', 'Conflicts', 'danger'),
        statusFact('github/checks', 'All passing', 'success'),
      ],
      comments: [
        comment({ id: 'github-issue-comment:2', createdAtMs: 500 }),
        comment({ id: 'github-issue-comment:1', createdAtMs: 100 }),
        comment({ id: 'github-issue-comment:3' }),
      ],
      historicalReviews: [],
      threads: [],
      reviewDecision: null,
      requests: [],
      checks: { kind: 'failing', failingCount: 1 },
    });

    expect(view.findings.map((finding) => finding.id)).toEqual([
      'github-issue-comment:1',
      'github-issue-comment:2',
      'github/checks',
      'github/mergeability',
      // A comment GitHub returned without a creation time keeps its row and
      // sorts last rather than being dropped or dated.
      'github-issue-comment:3',
    ]);
  });

  it('does not fabricate truncation for an unshortened GraphQL comment', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [comment({ id: 'github-issue-comment:9' })],
      historicalReviews: [],
      threads: [],
      reviewDecision: null,
      requests: [],
      checks: null,
    });

    expect(view.findings[0]).toMatchObject({ truncated: false });
  });

  it('keeps review bodies and line-anchored conversations distinct from issue comments', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [],
      historicalReviews: [{
        id: 'PRR_1',
        author: 'reviewer',
        body: 'Please split this.',
        state: 'CHANGES_REQUESTED',
        submittedAtMs: OBSERVED_AT_MS - 20,
        url: 'https://github.com/o/r/pull/1#pullrequestreview-1',
      }],
      threads: [{
        id: 'PRRT_1',
        isResolved: false,
        path: 'src/pump.ts',
        line: 42,
        replies: [{
          id: 'PRRC_1',
          author: 'octocat',
          body: 'This branch drops the tail.',
          createdAtMs: OBSERVED_AT_MS - 10,
          url: 'https://github.com/o/r/pull/1#discussion_r1',
        }],
        previousRepliesCursor: null,
      }],
      reviewDecision: null,
      requests: [],
      checks: null,
    });

    expect(view.findings).toEqual([
      expect.objectContaining({
        resource: 'review',
        id: 'PRR_1',
        body: 'Please split this.',
      }),
      expect.objectContaining({
        resource: 'thread',
        id: 'PRRT_1',
        path: 'src/pump.ts',
        line: 42,
        isResolved: false,
        replies: [expect.objectContaining({ id: 'PRRC_1' })],
      }),
    ]);
  });
});
