// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';

import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: 'github-forge',
});

const OBSERVED_AT_MS = 1_760_000_700_000;

function launchInput(
  kindId: 'pull-request' | 'issue',
  facts: readonly JsonValue[] = [],
): JsonValue {
  return {
    v: 1,
    instance: {
      v: 1,
      instance: {
        source: SOURCE_CONTRIBUTION,
        sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
      },
      binding: {
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        account: {
          service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' },
          accountId: 'account-1',
        },
      },
      localInstanceKey: 'github.com',
      configuration: { v: 1, token: 'github-configuration-token-v1' },
    },
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId,
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      observedAtMs: OBSERVED_AT_MS,
      locator: {
        v: 1,
        webUrl: 'https://github.com/octo-org/example-app/pull/1284',
        displayPath: 'octo-org/example-app#1284',
        routingToken: 'octo-org/example-app',
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'octo-org/example-app',
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts,
      },
      viewer: { involvement: ['reviewRequested'] },
    },
    linkedSessions: [],
  } as JsonValue;
}

/**
 * The two reads the plane composes, answered independently.
 *
 * Every case below sets both, because the point of the plane is that it opens
 * NO read of its own: whatever it shows has to come from one of these two.
 */
const answers: {
  comments: JsonValue;
  timeline: JsonValue;
} = {
  comments: { kind: 'comments', rows: [], omittedRowCount: 0, projectionTruncated: false },
  timeline: { kind: 'timeline', rows: [], omittedRowCount: 0, projectionTruncated: false },
};

const dispatched: string[] = [];
const mounted: PluginUiTestkit[] = [];

async function mountFeedback(input: JsonValue): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: GITHUB_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'github-triage-detail',
        generation: 'github-triage-feedback-mount',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: input,
      handlers: {
        executeAction: async ({ action }) => {
          const localId = (action as { localId: string }).localId;
          dispatched.push(localId);
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listComments) {
            return answers.comments;
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline) {
            return answers.timeline;
          }
          throw new Error(`unexpected action ${localId}`);
        },
      },
    }) as PluginUiTestkit;
  });
  mounted.push(fixture);
  return fixture;
}

async function openFeedback(detail: PluginUiTestkit): Promise<void> {
  await act(async () => {
    await detail.press(await detail.getByRole('tab', { name: 'Feedback' }));
  });
}

afterEach(async () => {
  dispatched.splice(0);
  answers.comments = {
    kind: 'comments', rows: [], omittedRowCount: 0, projectionTruncated: false,
  };
  answers.timeline = {
    kind: 'timeline', rows: [], omittedRowCount: 0, projectionTruncated: false,
  };
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/**
 * The mounted `Feedback` plane.
 *
 * The projection behind it is proved in `feedback.test.ts`; what only a mount
 * can prove is that a reviewer is actually OFFERED it, that what they see comes
 * from the reads this surface already owns rather than a third one, and that a
 * half-answered plane keeps the half that answered.
 */
describe('the mounted GitHub Feedback plane', () => {
  it('offers a pull request Feedback, and does not also offer it Comments', async () => {
    // Two tabs over one conversation would read the same GitHub resource twice
    // and split the answer across two places a reviewer has to check.
    const detail = await mountFeedback(launchInput('pull-request'));

    await expect(detail.getByRole('tab', { name: 'Feedback' }))
      .resolves.toMatchObject({ role: 'tab' });
    await expect(detail.queryByRole('tab', { name: 'Comments' })).resolves.toBeUndefined();
  });

  it('offers an issue Comments, and does not offer it Feedback', async () => {
    // An issue has no reviews, checks or merge conflicts to unify, so Feedback
    // there would be a heading over a single stream.
    const detail = await mountFeedback(launchInput('issue'));

    await expect(detail.getByRole('tab', { name: 'Comments' }))
      .resolves.toMatchObject({ role: 'tab' });
    await expect(detail.queryByRole('tab', { name: 'Feedback' })).resolves.toBeUndefined();
  });

  it('shows the sign-off, the outstanding request and the remark, from two reads', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [{
        id: 'github-issue-comment:11',
        author: 'hubber',
        body: 'This normalizer is duplicated.',
        atMs: OBSERVED_AT_MS - 20_000,
      }],
      omittedRowCount: 0,
      projectionTruncated: false,
    };
    answers.timeline = {
      kind: 'timeline',
      rows: [
        {
          id: 'github-timeline-event:1',
          kind: 'reviewRequested',
          rawKind: 'review_requested',
          summary: 'octocat',
          atMs: OBSERVED_AT_MS - 90_000,
        },
        {
          id: 'github-timeline-event:2',
          kind: 'reviewRequested',
          rawKind: 'review_requested',
          summary: 'platform-team',
          atMs: OBSERVED_AT_MS - 80_000,
        },
        // GitHub returned this review without an instant, which is why its state
        // renders on its own rather than beside a time.
        {
          id: 'github-timeline-event:3',
          kind: 'reviewed',
          rawKind: 'reviewed',
          actor: 'octocat',
          summary: 'approved',
        },
      ],
      omittedRowCount: 0,
      projectionTruncated: false,
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    // Who signed off, in GitHub's own state word, said in this product's words.
    await expect(detail.getByText('Reviewed')).resolves.toEqual({ content: 'Reviewed' });
    await expect(detail.getByText('octocat')).resolves.toEqual({ content: 'octocat' });
    await expect(detail.getByText('Approved')).resolves.toEqual({ content: 'Approved' });
    // Who is still being waited on, kept as a separate group: octocat answered
    // their request, and the team's request nobody answered survives.
    await expect(detail.getByText('Review requested from'))
      .resolves.toEqual({ content: 'Review requested from' });
    await expect(detail.getByText('platform-team'))
      .resolves.toEqual({ content: 'platform-team' });
    // And what was actually said.
    await expect(detail.getByText('hubber')).resolves.toEqual({ content: 'hubber' });

    // Exactly the two reads this surface already owns, and no third route.
    expect([...dispatched].sort()).toEqual([
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listComments,
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline,
    ].sort());
  });

  it('keeps the comments that answered when the review history could not be read', async () => {
    // Blanking the plane because one connection failed throws away the half
    // that answered the reviewer's question.
    answers.comments = {
      kind: 'comments',
      rows: [{
        id: 'github-issue-comment:11',
        author: 'hubber',
        body: 'This normalizer is duplicated.',
        atMs: OBSERVED_AT_MS - 20_000,
      }],
      omittedRowCount: 0,
      projectionTruncated: false,
    };
    answers.timeline = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText('hubber')).resolves.toEqual({ content: 'hubber' });
    // The banner names the connection that failed, so the reader knows WHICH
    // half of the picture is missing.
    await expect(detail.getByText('Part of this feedback could not be read'))
      .resolves.toEqual({ content: 'Part of this feedback could not be read' });
    await expect(detail.getByText(
      'GitHub could not complete the review history, so it is missing from what is shown'
        + ' here. (github_forbidden)',
    )).resolves.toMatchObject({ content: expect.any(String) });
  });

  it('says nothing about approval that GitHub never reported', async () => {
    // The untouched case, pinned. With no review decision on the observation and
    // no review in the events read, the plane must say the question was not
    // answered rather than present silence as "not approved".
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText(
      'GitHub did not report a review decision for this observation, so nothing here says'
        + ' whether it is approved.',
    )).resolves.toMatchObject({ content: expect.any(String) });
    await expect(detail.queryByText('Approved')).resolves.toBeUndefined();
    await expect(detail.queryByText('Reviewed')).resolves.toBeUndefined();
    await expect(detail.queryByText('Review requested from')).resolves.toBeUndefined();
  });

  it('stops saying the question is unanswered once the observation answers it', async () => {
    // The decided arm's text is asserted at the projection; what a mount adds is
    // that the plane STOPS disclaiming. An implementation that always rendered
    // the unresolved sentence would look right in the case above and be wrong
    // here, on every approved pull request a reviewer opens.
    const detail = await mountFeedback(launchInput('pull-request', [{
      id: 'github/review-decision',
      importance: 'primary',
      value: { kind: 'status', value: 'Changes requested', tone: 'danger' },
    }]));
    await openFeedback(detail);

    await expect(detail.queryByText(
      'GitHub did not report a review decision for this observation, so nothing here says'
        + ' whether it is approved.',
    )).resolves.toBeUndefined();
  });
});
