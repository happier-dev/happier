import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  buildReviewCommentFixture,
  storePlainReviewCommentFixture,
} from '@/dev/testkit/fixtures/reviewComments';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { t } from '@/text';
import { WorkflowRunReview } from './WorkflowRunReview';

const effects = vi.hoisted(() => ({ push: vi.fn() }));
// Navigation and authenticated HTTP are the boundaries; the Review list, comments, history and summary owners stay real.
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      router: { push: effects.push },
    }).module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const reviewId = 'hunt-review';
const workflowId = 'hunt-workflow';
const identity = 'a'.repeat(64);
const review = {
  reviewId,
  projectSourceId: null,
  workflowId,
  workflowRunId: 'hunt-run',
  subjectKind: 'repository',
  sourceKind: 'workflow',
  state: 'running',
  currentRoundOrdinal: 1,
  startedAt: 1,
  finishedAt: null,
  createdAt: 1,
  updatedAt: 2,
  counts: { total: 1, needsDecision: 1 },
};
let serverId = '';
let listRequests: unknown[] = [];

beforeEach(async () => {
  await homes.reset();
  listRequests = [];
  serverId = await homes.addHome({
    name: 'Hunts',
    serverUrl: 'https://hunts-run.test',
    accountId: 'alice',
    currentAccount: true,
  });
  publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://hunts-run.test', generation: 1 });
  storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
  homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture({
    id: reviewId, title: 'Security sweep', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Security sweep' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'running', startedAt: 1, finishedAt: null, reviewerIds: ['first'], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
  }, 'alice'));
  homes.answer(serverId, 'POST /v1/reviews/list', {
    select: (input) => {
      const body = (input ?? {}) as { workflowRunId?: string };
      listRequests.push(body);
      return {
        body: {
          items:
            body.workflowRunId === 'hunt-run'
              ? [
                  {
                    ...review,
                    needsYou: {
                      reviewId,
                      roundOrdinal: 1,
                      reason: 'review_needs_you',
                      needsYou: false,
                      requestedVerdict: false,
                      pendingDecisions: false,
                      canSubmitVerdict: false,
                    },
                  },
                ]
              : [],
          cursor: null,
        },
      };
    },
  });
  homes.answer(serverId, 'POST /v1/reviews/get', {
    body: {
      review,
      human: {
        reviewId,
        roundOrdinal: 1,
        requests: [],
        verdicts: [],
        needsYou: {
          reviewId,
          roundOrdinal: 1,
          reason: 'review_needs_you',
          needsYou: false,
          requestedVerdict: false,
          pendingDecisions: false,
          canSubmitVerdict: false,
        },
      },
    },
  });
  homes.answer(serverId, 'GET /v1/reviews/comments', {
    body: {
      items: [
        storePlainReviewCommentFixture(
          buildReviewCommentFixture({
            id: 'token-log',
            reviewId,
            accountId: 'alice',
            findingIdentity: identity,
            findingId: 'token-log',
            engineId: 'claude',
            finding: {
              id: 'token-log',
              title: 'Session token written to the daemon log',
              summary: 'Logged on reconnect.',
              severity: 'high',
              category: 'security',
            },
          }),
        ),
      ],
      cursor: null,
    },
  });
  homes.answer(serverId, 'POST /v1/reviews/history/list', {
    body: {
      previousReviewId: 'earlier',
      items: [
        {
          findingIdentity: identity,
          priorReviewCount: 2,
          priorRunCount: 2,
          firstObservedAt: 1,
          inCurrentReview: true,
          inPreviousReview: true,
          currentAppearances: [],
          previousAppearances: [],
          newSincePrevious: false,
          openReviewCount: 0,
        },
      ],
    },
  });
});
afterEach(async () => {
  await homes.reset();
  effects.push.mockClear();
});

it('shows the Review its run produced, with findings so far and how many earlier runs saw each', async () => {
  const screen = await renderScreen(
    <WorkflowRunReview
      runId="hunt-run"
      scope={{ serverId, accountId: 'alice' }}
      enabled
      testID="run-review"
    />,
  );
  try {
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain(
        'Session token written to the daemon log',
      ),
    );
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain(
        t('reviewWalkthrough.detail.historyEarlierRuns', { count: 2 }),
      ),
    );
    expect(listRequests).toContainEqual(
      expect.objectContaining({ workflowRunId: 'hunt-run' }),
    );
    await screen.pressByTestIdAsync('review-summary:open');
    expect(effects.push).toHaveBeenCalledWith(
      expect.stringContaining(reviewId),
    );
  } finally {
    await screen.unmount();
  }
});

it('shows nothing for a run that produced no Review of its own', async () => {
  const screen = await renderScreen(
    <WorkflowRunReview
      runId="another-round-run"
      scope={{ serverId, accountId: 'alice' }}
      enabled
      testID="run-review"
    />,
  );
  try {
    await waitForHomeGovernance(() =>
      expect(listRequests).toContainEqual(
        expect.objectContaining({ workflowRunId: 'another-round-run' }),
      ),
    );
    expect(screen.findHostByTestId('run-review')).toBeNull();
    expect(homes.requestsFor('/v1/reviews/get')).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});
