import { describe, expect, it } from 'vitest';

import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubTimelineRows,
} from '../../triage/detail/projection.js';

import { projectGithubFeedback } from './feedback.js';

/**
 * The `Feedback` plane against the bytes GitHub actually sends.
 *
 * `feedback.test.ts` beside this file checks the projection's own rules from
 * hand-built rows, which is the right shape for those rules and the wrong shape
 * for this question: a hand-built `reviewed` row can carry any field the caller
 * decides to put on it, so every one of those tests passes whether or not the
 * boundary projector ever produces such a row. That is why this file starts one
 * step earlier, at the raw `GET /repos/{owner}/{repo}/issues/{number}/timeline`
 * page, and runs it through the real projector before the plane sees it.
 *
 * The distinction is not academic on this collection. GitHub's timeline is a
 * union of differently shaped events, and `reviewed` is the arm that does not
 * follow the others: it carries `user` and `submitted_at` where every ordinary
 * event carries `actor` and `created_at` — the same review object the
 * `pulls/{number}/reviews` resource returns, with an `event` added. Anything
 * that reads the ordinary spelling reads nothing at all from it, and reads it
 * silently: the row still projects, keeps its id, its kind and its state, and
 * only the reviewer's name and the moment they signed off go missing.
 *
 * What that costs is the whole reason the tab exists. `Reviewed` becomes a list
 * of anonymous entries, and — because a submitted review is how this plane knows
 * a request was answered — everyone who has already approved stays listed as
 * still being waited on.
 */

/** The exact `reviewed` event shape, per GitHub's published `timeline-reviewed-event`. */
function githubTimelineReviewedEvent(input: Readonly<{
  id: number;
  login: string;
  state: string;
  submittedAt: string;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    event: 'reviewed',
    id: input.id,
    node_id: `PRR_kwDOsynthetic${input.id}`,
    // NOT `actor`. This resource names the reviewer `user`, as the reviews
    // collection it is drawn from does.
    user: Object.freeze({ login: input.login, id: 583_231, type: 'User' }),
    body: 'Looks good to me.',
    state: input.state,
    html_url:
      `https://github.com/octo-org/example-app/pull/1284#pullrequestreview-${input.id}`,
    pull_request_url: 'https://api.github.com/repos/octo-org/example-app/pulls/1284',
    _links: Object.freeze({
      html: Object.freeze({ href: 'https://github.com/octo-org/example-app/pull/1284' }),
      pull_request: Object.freeze({
        href: 'https://api.github.com/repos/octo-org/example-app/pulls/1284',
      }),
    }),
    // NOT `created_at`. A review is stamped when it was submitted.
    submitted_at: input.submittedAt,
    commit_id: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    author_association: 'MEMBER',
  });
}

/** The exact `review_requested` event shape, which DOES carry `actor`/`created_at`. */
function githubTimelineReviewRequestedEvent(input: Readonly<{
  id: number;
  createdAt: string;
  requestedReviewer?: string;
  requestedTeam?: string;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: input.id,
    node_id: `RRE_kwDOsynthetic${input.id}`,
    url: `https://api.github.com/repos/octo-org/example-app/issues/events/${input.id}`,
    actor: Object.freeze({ login: 'hubot', id: 1, type: 'User' }),
    event: 'review_requested',
    commit_id: null,
    commit_url: null,
    created_at: input.createdAt,
    performed_via_github_app: null,
    review_requester: Object.freeze({ login: 'hubot', id: 1, type: 'User' }),
    ...(input.requestedReviewer === undefined
      ? {}
      : {
        requested_reviewer: Object.freeze({
          login: input.requestedReviewer,
          id: 583_231,
          type: 'User',
        }),
      }),
    ...(input.requestedTeam === undefined
      ? {}
      : {
        requested_team: Object.freeze({
          id: 771,
          node_id: 'T_kwDOsynthetic',
          name: input.requestedTeam,
          slug: 'client-platform',
        }),
      }),
  });
}

const REQUESTED_AT = '2026-08-12T10:00:00Z';
const SUBMITTED_AT = '2026-08-12T11:00:00Z';
const OBSERVED_AT_MS = Date.parse('2026-08-12T12:00:00Z');

/** One real timeline page: a user asked, a team asked, and the user answered. */
function projectRealTimelinePage() {
  return projectGithubTimelineRows([
    githubTimelineReviewRequestedEvent({
      id: 1_300,
      createdAt: REQUESTED_AT,
      requestedReviewer: 'octocat',
    }),
    githubTimelineReviewRequestedEvent({
      id: 1_302,
      createdAt: REQUESTED_AT,
      requestedTeam: 'Client Platform',
    }),
    githubTimelineReviewedEvent({
      id: 1_301,
      login: 'octocat',
      state: 'approved',
      submittedAt: SUBMITTED_AT,
    }),
  ], GITHUB_DETAIL_BOUNDS_V1);
}

describe('the GitHub feedback plane against real timeline payloads', () => {
  it('carries the reviewer and the moment they signed off across the boundary', () => {
    const page = projectRealTimelinePage();
    const reviewed = page.rows.find((row) => row.kind === 'reviewed');

    // Read from `user`/`submitted_at`, which is where this event carries them.
    // Reading the ordinary `actor`/`created_at` spelling here loses both without
    // losing the row, which is what makes the loss invisible downstream.
    expect(reviewed).toMatchObject({
      kind: 'reviewed',
      rawKind: 'reviewed',
      actor: 'octocat',
      summary: 'approved',
      atMs: Date.parse(SUBMITTED_AT),
    });
  });

  it('names who signed off and stops waiting on the request they answered', () => {
    const view = projectGithubFeedback({
      facts: [],
      observedAtMs: OBSERVED_AT_MS,
      comments: [],
      timeline: projectRealTimelinePage().rows,
    });

    // The headline the tab exists to answer. An anonymous entry here is not a
    // degraded answer to "has anyone approved this" — it is no answer at all.
    expect(view.people.reviewed).toEqual([{
      id: 'github-timeline-event:1301',
      login: 'octocat',
      state: 'approved',
      atMs: Date.parse(SUBMITTED_AT),
      webUrl: 'https://github.com/octo-org/example-app/pull/1284#pullrequestreview-1301',
    }]);

    // GitHub emits a removal event only for a request somebody WITHDREW, so a
    // request its reviewer answered is only ever closed by the review itself.
    // The team request nobody answered is still outstanding, which is what keeps
    // this from passing on an empty list.
    expect(view.people.requested).toEqual([{
      id: 'github-timeline-event:1302',
      subject: 'Client Platform',
      atMs: Date.parse(REQUESTED_AT),
      webUrl: null,
    }]);
  });
});
