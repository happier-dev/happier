import * as React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { t } from '@/text';
import { ApprovalReviewFacts } from './ApprovalReviewFacts';

// Navigation and authenticated HTTP are the boundaries; the Review detail reader and reviewer projection stay real.
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({})
      .module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const reviewId = 'fix-review';
const review = {
  reviewId,
  projectSourceId: null,
  workflowId: 'fix-workflow',
  workflowRunId: 'fix-run',
  subjectKind: 'repository',
  sourceKind: 'workflow',
  state: 'partial',
  currentRoundOrdinal: 1,
  startedAt: 1,
  finishedAt: 3,
  createdAt: 1,
  updatedAt: 3,
  counts: { total: 2, needsDecision: 0 },
};
const needsYou = {
  reviewId,
  roundOrdinal: 1,
  reason: 'review_needs_you',
  needsYou: false,
  requestedVerdict: false,
  pendingDecisions: false,
  canSubmitVerdict: false,
};
let serverId = '';

function answerReview(state: string) {
  homes.answer(serverId, 'POST /v1/reviews/get', {
    body: {
      review: { ...review, state },
      human: {
        reviewId,
        roundOrdinal: 1,
        requests: [],
        verdicts: [],
        needsYou,
      },
    },
  });
}

function storeRound() {
  homes.artifacts(serverId).replaceStoredRow(
    createPlainArtifactHttpFixture(
      {
        id: reviewId,
        title: 'Security sweep',
        isDecrypted: true,
        header: { kind: 'review.v1', v: 1, reviewId, title: 'Security sweep' },
        body: JSON.stringify({
          v: 1,
          rounds: [
            {
              ordinal: 1,
              state: 'partial',
              startedAt: 1,
              finishedAt: 3,
              reviewerIds: ['first', 'second', 'third'],
              runs: [],
              reviewerOutcomes: [
                {
                  reviewerId: 'first',
                  displayName: 'Claude',
                  outcome: 'completed',
                },
                {
                  reviewerId: 'second',
                  displayName: 'Codex',
                  outcome: 'completed',
                },
                {
                  reviewerId: 'third',
                  displayName: 'Gemini',
                  outcome: 'failed',
                  reason: { run: 'launch_failed' },
                },
              ],
            },
          ],
        }),
        ownerAccountId: 'alice',
        access: 'owner',
        storageMode: 'plain',
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 3,
      },
      'alice',
    ),
  );
}

beforeEach(async () => {
  await homes.reset();
  serverId = await homes.addHome({
    name: 'Fixes',
    serverUrl: 'https://fix-coverage.test',
    accountId: 'alice',
    currentAccount: true,
  });
  publishAppliedActiveServerSnapshot({
    serverId,
    serverUrl: 'https://fix-coverage.test',
    generation: 1,
  });
  storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
});

function facts() {
  return (
    <ApprovalReviewFacts
      actionId="review.apply"
      actionArgs={{ sessionId: 'session-1', reviewId }}
      preview={null}
      serverId={serverId}
      testID="approval"
    />
  );
}

const partialLine = () => [
  t('reviewWalkthrough.detail.reviewersFinishedOf', { count: 2, total: 3 }),
  t('reviewWalkthrough.detail.reviewersDidntFinish', {
    names: 'Gemini',
    count: 1,
  }),
];

// R12 M13: a Fix approved away from the Review card still says which reviewers its findings come from.
it('names the reviewers that did not finish when coverage is partial', async () => {
  answerReview('partial');
  storeRound();
  const screen = await renderScreen(facts());
  try {
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('approval.review-coverage')).not.toBeNull(),
    );
    for (const part of partialLine())
      expect(screen.getTextContent()).toContain(part);
  } finally {
    await screen.unmount();
  }
});

it('says coverage could not be read when the partial Review body cannot be opened', async () => {
  answerReview('partial');
  const screen = await renderScreen(facts());
  try {
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain(
        t('reviewWalkthrough.detail.reviewerCoverageUnavailable'),
      ),
    );
    expect(screen.getTextContent()).not.toContain(partialLine()[0]);
  } finally {
    await screen.unmount();
  }
});

it('adds no line when every reviewer finished', async () => {
  answerReview('completed');
  storeRound();
  const screen = await renderScreen(facts());
  try {
    await waitForHomeGovernance(() =>
      expect(homes.requestsFor('/v1/reviews/get').length).toBeGreaterThan(0),
    );
    expect(screen.findHostByTestId('approval.review-coverage')).toBeNull();
    expect(screen.getTextContent()).not.toContain(
      t('reviewWalkthrough.detail.reviewerCoverageUnavailable'),
    );
  } finally {
    await screen.unmount();
  }
});
