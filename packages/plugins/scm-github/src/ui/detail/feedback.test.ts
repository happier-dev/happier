import type { TriageRowFactV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type {
  GithubProjectedCommentRowV1,
  GithubProjectedTimelineRowV1,
} from '../../triage/detail/projection.js';

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
  }) as TriageRowFactV1;
}

function event(
  overrides: Partial<GithubProjectedTimelineRowV1>
    & Pick<GithubProjectedTimelineRowV1, 'id' | 'kind'>,
): GithubProjectedTimelineRowV1 {
  return Object.freeze({
    rawKind: overrides.kind,
    ...overrides,
  }) as GithubProjectedTimelineRowV1;
}

function comment(
  overrides: Partial<GithubProjectedCommentRowV1> & Pick<GithubProjectedCommentRowV1, 'id'>,
): GithubProjectedCommentRowV1 {
  return Object.freeze({ body: 'a comment', ...overrides }) as GithubProjectedCommentRowV1;
}

describe('the GitHub feedback projection', () => {
  it('assembles the conversation and the adverse observed state into one ordered feed', () => {
    // The reviewer's question is "what is being said about this pull request, and
    // what is wrong with it" — one feed, not four screens.
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [
        statusFact('github/review-decision', 'Changes requested', 'danger'),
        statusFact('github/checks', '3 failing', 'danger'),
        statusFact('github/mergeability', 'Conflicts', 'danger'),
      ],
      timeline: [],
      comments: [
        comment({
          id: 'github-issue-comment:11',
          author: 'octocat',
          body: 'This normalizer is duplicated.',
          atMs: OBSERVED_AT_MS - 20_000,
          webUrl: 'https://github.com/octo-org/example-app/pull/1284#issuecomment-11',
        }),
      ],
    });

    expect(view.review).toEqual({
      kind: 'decided',
      label: 'Changes requested',
      tone: 'danger',
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

  it('makes a finding of nothing the source did not publish as adverse', () => {
    // The untouched case, pinned: a green pull request must produce an EMPTY
    // finding feed. A rule that turned every state fact into a finding would put
    // "All passing" into the list of things wrong with this pull request, and a
    // test that only ever fed it failing states would never notice.
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [
        statusFact('github/checks', 'All passing', 'success'),
        statusFact('github/mergeability', 'Computing', 'info'),
        statusFact('github/review-decision', 'Approved', 'success'),
      ],
      timeline: [],
      comments: [],
    });

    expect(view.findings).toEqual([]);
    expect(view.review).toEqual({ kind: 'decided', label: 'Approved', tone: 'success' });
  });

  it('leaves a blocked merge as context rather than reporting a conflict GitHub never reported', () => {
    // `Blocked` is a warning, not a conflict. Folding it into the conflict arm
    // would tell a reviewer the branches disagree when GitHub said a rule does.
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [statusFact('github/mergeability', 'Blocked', 'warning')],
      timeline: [],
      comments: [],
    });

    expect(view.findings).toEqual([]);
  });

  it('reports the review decision as unresolved when the observation carried none', () => {
    // REST cannot prove GitHub's `REVIEW_REQUIRED` arm, so an absent decision is
    // UNRESOLVED. Rendering it as "not approved" would state a fact about a
    // branch-protection rule this build never read.
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [statusFact('github/checks', 'All passing', 'success')],
      timeline: [],
      comments: [],
    });

    expect(view.review).toEqual({ kind: 'unresolved' });
  });

  it('orders the feed by time and tie-breaks on resource then id', () => {
    // Two independently ordered GitHub resources interleaved by arrival order
    // would be presented as chronological while being wrong.
    const view = projectGithubFeedback({
      observedAtMs: 500,
      facts: [
        statusFact('github/mergeability', 'Conflicts', 'danger'),
        statusFact('github/checks', '1 failing', 'danger'),
      ],
      timeline: [],
      comments: [
        comment({ id: 'github-issue-comment:2', atMs: 500 }),
        comment({ id: 'github-issue-comment:1', atMs: 100 }),
        comment({ id: 'github-issue-comment:3' }),
      ],
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

  it('carries a shortened comment body through as shortened', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      timeline: [],
      comments: [comment({ id: 'github-issue-comment:9', truncated: true })],
    });

    expect(view.findings[0]).toMatchObject({ truncated: true });
  });
});

describe('the GitHub feedback review people', () => {
  it('separates who has reviewed from who is still being waited on', () => {
    // A reviewer list built from requests loses everybody who already reviewed;
    // one built from reviews hides a still-outstanding team request. They answer
    // different questions and are never unioned into one list of "reviewers".
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [],
      timeline: [
        event({
          id: 'github-timeline-event:1',
          kind: 'reviewRequested',
          summary: 'octocat',
          atMs: 100,
        }),
        event({
          id: 'github-timeline-event:2',
          kind: 'reviewRequested',
          summary: 'platform-team',
          atMs: 200,
        }),
        event({
          id: 'github-timeline-event:3',
          kind: 'reviewed',
          actor: 'octocat',
          summary: 'approved',
          atMs: 300,
          webUrl: 'https://github.com/octo-org/example-app/pull/1284#pullrequestreview-3',
        }),
      ],
    });

    expect(view.people.reviewed).toEqual([{
      id: 'github-timeline-event:3',
      login: 'octocat',
      state: 'approved',
      atMs: 300,
      webUrl: 'https://github.com/octo-org/example-app/pull/1284#pullrequestreview-3',
    }]);
    // The request octocat answered is fulfilled and is no longer outstanding;
    // the team nobody answered still is.
    expect(view.people.requested).toEqual([{
      id: 'github-timeline-event:2',
      subject: 'platform-team',
      atMs: 200,
      webUrl: null,
    }]);
  });

  it('drops a request GitHub recorded as withdrawn', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [],
      timeline: [
        event({ id: 'e1', kind: 'reviewRequested', summary: 'octocat', atMs: 100 }),
        event({ id: 'e2', kind: 'reviewRequestRemoved', summary: 'octocat', atMs: 200 }),
      ],
    });

    expect(view.people.requested).toEqual([]);
    expect(view.people.reviewed).toEqual([]);
  });

  it('keeps a reviewer once, at their latest review, rather than once per pass', () => {
    // A reviewer who asked for changes and then approved is APPROVED. Listing
    // both rows would leave a reviewer permanently blocking a pull request they
    // already signed off.
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [],
      timeline: [
        event({
          id: 'e1',
          kind: 'reviewed',
          actor: 'octocat',
          summary: 'changes_requested',
          atMs: 100,
        }),
        event({ id: 'e2', kind: 'reviewed', actor: 'octocat', summary: 'approved', atMs: 200 }),
      ],
    });

    expect(view.people.reviewed).toEqual([
      { id: 'e2', login: 'octocat', state: 'approved', atMs: 200, webUrl: null },
    ]);
  });

  it('states a review it cannot attribute rather than merging it into another reviewer', () => {
    // Two reviews GitHub returned without an actor are two reviews, not one
    // person named `null` who reviewed twice.
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [],
      timeline: [
        event({ id: 'e1', kind: 'reviewed', summary: 'commented', atMs: 100 }),
        event({ id: 'e2', kind: 'reviewed', summary: 'approved', atMs: 200 }),
      ],
    });

    expect(view.people.reviewed.map((reviewer) => reviewer.id)).toEqual(['e1', 'e2']);
    expect(view.people.reviewed.every((reviewer) => reviewer.login === null)).toBe(true);
  });

  it('reads review people from the events read and from no read of its own', () => {
    // The untouched case, pinned: with no timeline threaded in, the plane says
    // nobody rather than reaching for a read. A projection that fetched would
    // spend GitHub's rate budget from inside a pure function.
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [statusFact('github/review-decision', 'Approved', 'success')],
      comments: [],
      timeline: [],
    });

    expect(view.people).toEqual({ reviewed: [], requested: [] });
    expect(view.review).toEqual({ kind: 'decided', label: 'Approved', tone: 'success' });
  });

  it('ignores the events that are not about review at all', () => {
    const view = projectGithubFeedback({
      observedAtMs: OBSERVED_AT_MS,
      facts: [],
      comments: [],
      timeline: [
        event({ id: 'e1', kind: 'labeled', summary: 'bug', atMs: 100 }),
        event({ id: 'e2', kind: 'committed', actor: 'octocat', atMs: 200 }),
        event({ id: 'e3', kind: 'reviewRequested', atMs: 300 }),
      ],
    });

    // `e3` named nobody, so there is nobody to wait on; naming it would invent a
    // reviewer this build never read.
    expect(view.people).toEqual({ reviewed: [], requested: [] });
  });
});
