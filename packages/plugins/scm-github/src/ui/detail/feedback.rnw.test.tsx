// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';
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
/** The locale `createSurfaceContextFixture` mounts this surface under. */
const SURFACE_LOCALE = 'en-GB';
const HEAD_REVISION = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';

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

/** The five independent reads the Feedback plane composes. */
const answers: {
  comments: JsonValue;
  threads: JsonValue;
  reviews: JsonValue;
  requests: JsonValue;
  checks: JsonValue;
} = {
  comments: { kind: 'comments', rows: [] },
  threads: { kind: 'threads', rows: [] },
  reviews: { kind: 'reviews', rows: [] },
  requests: { kind: 'requests', rows: [] },
  checks: {
    kind: 'checks',
    headRevision: HEAD_REVISION,
    state: 'none',
    rows: [],
    omittedRowCount: 0,
    projectionTruncated: false,
  },
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
        executeAction: async ({ action, input: actionInput }) => {
          const localId = (action as { localId: string }).localId;
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback) {
            const connection = (actionInput as { connection: keyof typeof answers }).connection;
            dispatched.push(`${localId}:${connection}`);
            return answers[connection];
          }
          dispatched.push(localId);
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks) {
            return answers.checks;
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

function resetAnswers(): void {
  answers.comments = { kind: 'comments', rows: [] };
  answers.threads = { kind: 'threads', rows: [] };
  answers.reviews = { kind: 'reviews', rows: [] };
  answers.requests = { kind: 'requests', rows: [] };
  answers.checks = {
    kind: 'checks',
    headRevision: HEAD_REVISION,
    state: 'none',
    rows: [],
    omittedRowCount: 0,
    projectionTruncated: false,
  };
}

afterEach(async () => {
  dispatched.splice(0);
  resetAnswers();
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/**
 * The mounted `Feedback` plane.
 *
 * The projection behind it is proved in `feedback.test.ts`; what only a mount
 * can prove is that a reviewer is actually OFFERED it, that it reads the
 * authoritative reviews and checks rather than the Timeline panel, and that a
 * failed read leaves the other answers usable.
 */
describe('the mounted GitHub Feedback plane', () => {
  it('offers a pull request Feedback, and does not also offer it Comments', async () => {
    const detail = await mountFeedback(launchInput('pull-request'));

    await expect(detail.getByRole('tab', { name: 'Feedback' }))
      .resolves.toMatchObject({ role: 'tab' });
    await expect(detail.queryByRole('tab', { name: 'Comments' })).resolves.toBeUndefined();
  });

  it('offers an issue Comments, and does not offer it Feedback', async () => {
    const detail = await mountFeedback(launchInput('issue'));

    await expect(detail.getByRole('tab', { name: 'Comments' }))
      .resolves.toMatchObject({ role: 'tab' });
    await expect(detail.queryByRole('tab', { name: 'Feedback' })).resolves.toBeUndefined();

    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Comments' }));
    });
    expect(dispatched).toEqual([
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
    ]);
  });

  it('shows current review, request, check and conversation facts from independent reads, not the Timeline', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [{
        id: 'github-issue-comment:11',
        author: 'hubber',
        body: 'This normalizer is duplicated.',
        createdAtMs: OBSERVED_AT_MS - 20_000,
      }],
    };
    answers.reviews = {
      kind: 'reviews',
      reviewDecision: 'changes-requested',
      rows: [{
        id: 'PRR_1',
        author: 'octocat',
        body: 'Needs a smaller owner.',
        state: 'CHANGES_REQUESTED',
        submittedAtMs: OBSERVED_AT_MS - 10_000,
      }],
    };
    answers.requests = {
      kind: 'requests',
      rows: [{ kind: 'team', subject: 'Client Platform' }],
    };
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_1',
        isResolved: false,
        path: 'src/pump.ts',
        line: 42,
        replies: [{ id: 'PRRC_1', author: 'line-reviewer', body: 'The tail is dropped.' }],
      }],
    };
    answers.checks = {
      kind: 'checks',
      headRevision: HEAD_REVISION,
      state: 'resolved',
      rowState: { kind: 'failing', failingCount: 1 },
      rows: [],
      failingCount: 1,
      runningCount: 0,
      passingCount: 0,
      omittedRowCount: 0,
      projectionTruncated: false,
    };

    const detail = await mountFeedback(launchInput('pull-request', [{
      id: 'github/review-decision',
      importance: 'primary',
      value: { kind: 'status', value: 'Approved', tone: 'success' },
    }, {
      id: 'github/checks',
      importance: 'primary',
      value: { kind: 'status', value: 'All passing', tone: 'success' },
    }]));
    await openFeedback(detail);

    await expect(detail.getByText('Review: Changes requested'))
      .resolves.toEqual({ content: 'Review: Changes requested' });
    await expect(detail.getByText('Reviewed')).resolves.toEqual({ content: 'Reviewed' });
    await expect(detail.getByText('Needs a smaller owner.'))
      .resolves.toEqual({ content: 'Needs a smaller owner.' });
    // The reviewer row carries GitHub's own review state AND the instant that
    // review was submitted at. `submitted_at` is the only instant a review has —
    // it has no `created_at` — so a row that showed the state alone would drop
    // the one fact that says whether the sign-off predates the head on screen.
    const submittedAt = formatTriageTimestampV1(
      SURFACE_LOCALE,
      OBSERVED_AT_MS - 10_000,
      'relative',
      Date.now(),
    );
    await expect(detail.getByText(`Changes requested \u00b7 ${submittedAt}`))
      .resolves.toEqual({ content: `Changes requested \u00b7 ${submittedAt}` });
    await expect(detail.getByText('Review requested from'))
      .resolves.toEqual({ content: 'Review requested from' });
    await expect(detail.getByText('Client Platform'))
      .resolves.toEqual({ content: 'Client Platform' });
    await expect(detail.getByText('src/pump.ts:42'))
      .resolves.toEqual({ content: 'src/pump.ts:42' });
    await expect(detail.getByText('The tail is dropped.'))
      .resolves.toEqual({ content: 'The tail is dropped.' });
    await expect(detail.getByText('1 failing')).resolves.toEqual({ content: '1 failing' });
    await expect(detail.getByText('hubber')).resolves.toEqual({ content: 'hubber' });

    expect([...dispatched].sort()).toEqual([
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:requests`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:reviews`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:threads`,
    ].sort());
  });

  it('keeps answered comments and checks when the reviews read cannot be made', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [{
        id: 'github-issue-comment:11',
        author: 'hubber',
        body: 'This normalizer is duplicated.',
        createdAtMs: OBSERVED_AT_MS - 20_000,
      }],
    };
    answers.reviews = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    answers.checks = {
      kind: 'checks',
      headRevision: HEAD_REVISION,
      state: 'resolved',
      rowState: { kind: 'failing', failingCount: 1 },
      rows: [],
      failingCount: 1,
      runningCount: 0,
      passingCount: 0,
      omittedRowCount: 0,
      projectionTruncated: false,
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText('hubber')).resolves.toEqual({ content: 'hubber' });
    await expect(detail.getByText('1 failing')).resolves.toEqual({ content: '1 failing' });
    await expect(detail.getByText('Part of this feedback could not be read'))
      .resolves.toEqual({ content: 'Part of this feedback could not be read' });
  });

  it('keeps review people when the checks read cannot be made', async () => {
    answers.reviews = {
      kind: 'reviews',
      reviewDecision: 'approved',
      rows: [{ id: 'PRR_1', author: 'octocat', body: '', state: 'APPROVED' }],
    };
    answers.checks = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText('Review: Approved'))
      .resolves.toEqual({ content: 'Review: Approved' });
    await expect(detail.getByText('Part of this feedback could not be read'))
      .resolves.toEqual({ content: 'Part of this feedback could not be read' });
  });

  it('says nothing about approval when the current reviews read reports no decision', async () => {
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText(
      'GitHub\'s current reviews read did not report a review decision, so nothing here says'
        + ' whether it is approved.',
    )).resolves.toMatchObject({ content: expect.any(String) });
    await expect(detail.queryByText('Approved')).resolves.toBeUndefined();
    await expect(detail.queryByText('Reviewed')).resolves.toBeUndefined();
    await expect(detail.queryByText('Review requested from')).resolves.toBeUndefined();
  });

  it('does not retain an old review decision when an explicit re-read fails', async () => {
    answers.reviews = {
      kind: 'reviews',
      reviewDecision: 'approved',
      rows: [{ id: 'PRR_1', author: 'octocat', body: '', state: 'APPROVED' }],
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);
    await expect(detail.getByText('Review: Approved'))
      .resolves.toEqual({ content: 'Review: Approved' });

    answers.reviews = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Re-read this feedback from GitHub' }));
    });

    await expect(detail.queryByText('Review: Approved')).resolves.toBeUndefined();
    await expect(detail.getByText(
      'GitHub\'s current reviews read did not report a review decision, so nothing here says'
        + ' whether it is approved.',
    )).resolves.toMatchObject({ content: expect.any(String) });
  });

  it('re-reads each feedback connection and checks through their existing reader owners', async () => {
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Re-read this feedback from GitHub' }));
    });

    expect([...dispatched].sort()).toEqual([
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks,
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:requests`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:requests`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:reviews`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:reviews`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:threads`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:threads`,
    ].sort());
  });
});
