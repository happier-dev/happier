import * as React from 'react';
import { act } from 'react-test-renderer';
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
import { WorkflowRunReview, useWorkflowRunResultReview } from './WorkflowRunReview';
import { WorkflowRunFold } from '@/components/sessions/transcript/turns/WorkflowRunFold';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

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

it.each([
  ['ACP_CATALOG_UNAVAILABLE', 'settings.acpCatalogUnavailable'],
  ['agent_isolation_unavailable', 'errors.agentIsolationUnavailable'],
] as const)('shows %s on its failed Review card', async (failureCode, messageKey) => {
  homes.answer(serverId, 'POST /v1/reviews/get', { body: {
    review: { ...review, state: 'failed', finishedAt: 3, counts: { total: 0, needsDecision: 0 } },
    human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [],
      needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
        requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } },
  } });
  homes.answer(serverId, 'GET /v1/reviews/comments', { body: { items: [], cursor: null } });
  const screen = await renderScreen(<WorkflowRunReview runId="hunt-run" scope={{ serverId, accountId: 'alice' }}
    enabled workflowFailureCode={failureCode} />);
  try {
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t(messageKey)));
  } finally { await screen.unmount(); }
});

it('keeps reviewer outcomes on the Round card without repeating them beside the Workflow findings', async () => {
  homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture({
    id: reviewId, title: 'Security sweep', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Security sweep' },
    body: JSON.stringify({ v: 1, rounds: [{
      ordinal: 1, state: 'partial', startedAt: 1, finishedAt: 3, reviewerIds: ['first', 'second'], runs: [],
      reviewerOutcomes: [
        { reviewerId: 'first', displayName: 'First reviewer', outcome: 'completed' },
        { reviewerId: 'second', displayName: 'Unavailable reviewer', outcome: 'failed',
          reason: { run: 'launch_failed', errorCode: 'connected_service_run_materialization_blocked' } },
      ],
    }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 3,
  }, 'alice'));
  homes.answer(serverId, 'POST /v1/reviews/get', { body: {
    review: { ...review, state: 'partial', finishedAt: 3 },
    human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [],
      needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
        requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } },
  } });
  const screen = await renderScreen(<WorkflowRunReview runId="hunt-run" scope={{ serverId, accountId: 'alice' }} enabled />);
  try {
    await waitForHomeGovernance(() => {
      expect(screen.getTextContent()).toContain('Session token written to the daemon log');
      expect(screen.getTextContent()).not.toContain(t('reviewWalkthrough.detail.reviewersDidntFinish', { names: 'Unavailable reviewer', count: 1 }));
    });
  } finally { await screen.unmount(); }
});

it('finds a Review by its workflowRunId when a contributed PR action produced it', async () => {
  function Result() {
    const result = useWorkflowRunResultReview({ runId: 'hunt-run', scope: { serverId, accountId: 'alice' },
      result: { reviewId }, finalOutputInvocationId: undefined, enabled: true });
    return <span>{result?.reviewId ?? 'missing'}</span>;
  }
  const screen = await renderScreen(<Result />);
  try {
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(reviewId));
  } finally { await screen.unmount(); }
});

it('keeps this Workflow round outcomes after a later retry', async () => {
  homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture({
    id: reviewId, title: 'Code review', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Code review' },
    body: JSON.stringify({ v: 1, rounds: [
      { ordinal: 1, state: 'partial', startedAt: 1, finishedAt: 3,
        reviewerIds: ['step-1-reviewer-1', 'step-1-reviewer-2'], runs: [{ kind: 'workflow', runId: 'hunt-run' }],
        reviewerOutcomes: [
          { reviewerId: 'step-1-reviewer-1', outcome: 'partial' },
          { reviewerId: 'step-1-reviewer-2', outcome: 'failed', reason: { run: 'failed', errorCode: 'provider_model_not_found' } },
        ] },
      { ordinal: 2, state: 'completed', startedAt: 4, finishedAt: 5,
        reviewerIds: ['step-1-reviewer-2'], runs: [{ kind: 'workflow', runId: 'retry-run' }],
        reviewerOutcomes: [{ reviewerId: 'step-1-reviewer-2', outcome: 'completed' }] },
    ] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 5,
  }, 'alice'));
  homes.answer(serverId, 'POST /v1/reviews/get', { body: {
    review: { ...review, subjectKind: 'comparison', state: 'completed', currentRoundOrdinal: 2, finishedAt: 5 },
    human: { reviewId, roundOrdinal: 2, requests: [], verdicts: [],
      needsYou: { reviewId, roundOrdinal: 2, reason: 'review_needs_you', needsYou: false,
        requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } },
  } });
  function Result() {
    const result = useWorkflowRunResultReview({ runId: 'hunt-run', scope: { serverId, accountId: 'alice' },
      result: { reviewId }, finalOutputInvocationId: undefined, enabled: true });
    return <span>{JSON.stringify(result)}</span>;
  }
  const screen = await renderScreen(<Result />);
  try {
    await waitForHomeGovernance(() => {
      const result = JSON.parse(screen.getTextContent());
      expect(result).toMatchObject({ reviewId, reviewers: [
        { reviewerId: 'step-1-reviewer-1', outcome: 'partial' },
        { reviewerId: 'step-1-reviewer-2', outcome: 'failed' },
      ] });
    });
  } finally { await screen.unmount(); }
});

it('opens a zero-turn habit fold as its linked Review summary, retaining the way into its Run', async () => {
  const navigate = vi.fn();
  const source = { ...createTestSessionTranscriptSource({ serverId, navigate }), kind: 'app' as const };
  const screen = await renderWithSessionTranscriptSource(
    <WorkflowRunFold turnId="habit-turn" run={{ runId: 'hunt-run', turnCount: 0 }} serverId={serverId}>
      {null}
    </WorkflowRunFold>, source,
  );
  try {
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Session token written to the daemon log'));
    await screen.pressByTestIdAsync('review-summary:open');
    expect(effects.push).toHaveBeenCalledWith(expect.stringContaining(reviewId));
    await screen.pressByTestIdAsync('workflow-run-review:open-run');
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('hunt-run'));
    await screen.update(<WorkflowRunFold turnId="habit-turn" run={{ runId: 'another-round-run', turnCount: 0 }} serverId={serverId}>
      {null}
    </WorkflowRunFold>);
    await waitForHomeGovernance(() => expect(listRequests).toContainEqual(expect.objectContaining({ workflowRunId: 'another-round-run' })));
    expect(screen.findHostByTestId('review-summary:open')).toBeNull();
    expect(screen.getTextContent()).toContain(t('workflows.run.open'));
  } finally { await screen.unmount(); }
});

it('keeps a read-only transcript fold from looking up a private Review through the active Account', async () => {
  const screen = await renderWithSessionTranscriptSource(
    <WorkflowRunFold turnId="public-turn" run={{ runId: 'hunt-run', turnCount: 0 }} serverId={serverId}>
      {null}
    </WorkflowRunFold>, createTestSessionTranscriptSource({ serverId, navigate: effects.push }),
  );
  try {
    expect(screen.getTextContent()).toContain(t('workflows.run.open'));
    expect(screen.findHostByTestId('review-summary:open')).toBeNull();
    expect(listRequests).toEqual([]);
  } finally { await screen.unmount(); }
});

function publishRunningReviewAndConverge(runId: string, state: 'running' | 'interrupted' | 'failed' = 'running'): void {
  const definition = createWorkflowDefinitionFixture();
  publishOpenedWorkflowRunDetail(WorkflowRunGetResultV1Schema.parse({
    run: createWorkflowRunSummaryFixture({ id: runId, state, origin: { kind: 'direct' } }),
    definition, authoredDefinition: definition, callerAccess: { canEdit: true }, checkpoint: null,
    acceptedContext: {
      startedBy: 'user', source: { kind: 'catalog', ref: 'builtin:review-and-converge', version: 1 }, inputs: {},
      machineId: 'machine-1', executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {},
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' },
    },
  }), { serverId, accountId: 'alice' });
}

it.each(['running', 'failed'] as const)(
  'shows Findings from a %s linked Review on the Review & converge card without a second failure sentence',
  async (reviewState) => {
  if (reviewState === 'failed') {
    const failed = { ...review, state: 'failed', finishedAt: 3, counts: { total: 1, needsDecision: 0 } };
    const needsYou = { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
      requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false };
    homes.answer(serverId, 'POST /v1/reviews/list', { body: { items: [{ ...failed, needsYou }], cursor: null } });
    homes.answer(serverId, 'POST /v1/reviews/get', { body: { review: failed,
      human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou } } });
  }
  publishRunningReviewAndConverge('hunt-run');
  const source = { ...createTestSessionTranscriptSource({ serverId, navigate: vi.fn() }), kind: 'app' as const };
  let commits = 0;
  const fold = (
    <React.Profiler id="fold" onRender={() => { commits += 1; }}>
      <WorkflowRunFold turnId="review-turn" run={{ runId: 'hunt-run', turnCount: 0 }} serverId={serverId}>
        {null}
      </WorkflowRunFold>
    </React.Profiler>
  );
  const screen = await renderWithSessionTranscriptSource(fold, source);
  try {
    expect(screen.findHostByTestId('workflow-review-round:hunt-run')).not.toBeNull();
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Session token written to the daemon log'));
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain(t('reviewWalkthrough.detail.historyEarlierRuns', { count: 2 })));
    // Another Run's update does not reach this card: it reads only its own Run and its own linked Review.
    if (reviewState === 'failed') {
      await waitForHomeGovernance(() => expect(screen.getTextContent())
        .toContain(t('reviewWalkthrough.detail.findingsCount', { count: 1 })));
    }
    expect(screen.getTextContent()).not.toContain(t('reviewWalkthrough.detail.glanceFailed'));
    const settled = commits;
    publishRunningReviewAndConverge('unrelated-run');
    await screen.update(fold);
    expect(commits).toBe(settled);
  } finally { await screen.unmount(); }
});

it.each(['interrupted', 'failed'] as const)('waits for the %s Run facts before showing its transcript card', async (state) => {
  const runId = `staged-${state}-run`;
  const exactRead = Promise.withResolvers<void>();
  homes.answer(serverId, 'POST /v3/automations/runs/workflow-storage', {
    select: (input) => ({
      status: 404, body: { error: 'not_found' },
      ...((input as { operation?: string })?.operation === 'get' ? { respondAfter: exactRead.promise } : {}),
    }),
  });
  const failed = { ...review, workflowRunId: runId, state: 'failed', finishedAt: 3, counts: { total: 0, needsDecision: 0 } };
  const needsYou = { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
    requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false };
  homes.answer(serverId, 'POST /v1/reviews/list', { body: { items: [{ ...failed, needsYou }], cursor: null } });
  homes.answer(serverId, 'POST /v1/reviews/get', { body: { review: failed,
    human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou } } });
  homes.answer(serverId, 'GET /v1/reviews/comments', { body: { items: [], cursor: null } });
  const source = { ...createTestSessionTranscriptSource({ serverId, navigate: vi.fn() }), kind: 'app' as const };
  const screen = await renderWithSessionTranscriptSource(
    <WorkflowRunFold turnId="review-turn" run={{ runId, turnCount: 0 }} serverId={serverId}>{null}</WorkflowRunFold>, source);
  const assertLoading = () => {
    expect(screen.getTextContent()).toContain(t('common.loading'));
    expect(screen.findHostByTestId(`workflow-review-round:${runId}`)).toBeNull();
    expect(screen.findByTestId(`workflow-run-fold-open:${runId}`)).toBeNull();
    expect(screen.getTextContent()).not.toContain(t('reviewWalkthrough.detail.glanceFailed'));
  };
  try {
    assertLoading();
    await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
      createWorkflowRunSummaryFixture({ id: runId, state, origin: { kind: 'direct' } }),
    )]));
    assertLoading();
    await act(async () => publishRunningReviewAndConverge(runId, state));
    const open = state === 'interrupted' ? `workflow-review-round:${runId}-open` : `workflow-run-fold-open:${runId}`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(open)).not.toBeNull());
    await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/reviews/list').length).toBeGreaterThan(0));
    expect(screen.findByTestId(open)).not.toBeNull();
    expect(screen.findByTestId('review-summary:open')).toBeNull();
    expect(screen.getTextContent()).not.toContain(t('reviewWalkthrough.detail.glanceFailed'));
  } finally {
    await screen.unmount();
    exactRead.resolve();
  }
});
