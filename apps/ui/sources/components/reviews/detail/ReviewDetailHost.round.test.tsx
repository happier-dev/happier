import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionRunGetRequestSchema, ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import settledRound from '@/dev/testkit/fixtures/settledReviewRound.json';
import historicalRound from '@/dev/testkit/fixtures/historicalReviewRound.json';
import twoStepRound from '@/dev/testkit/fixtures/twoStepPartialReviewRound.json';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
  createSessionFilesViewFixture,
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';

// The round section (U8 R3 B2, lab `detail-rounds`): who reviewed, each by name with how it ended.
installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture:
  | Awaited<ReturnType<typeof createSessionFilesViewFixture>>
  | undefined;
afterEach(async () => {
  standardCleanup();
  await fixture?.dispose();
  fixture = undefined;
});

it('keeps captured historical Review A names with no individual state or timing and retains its aggregate notice', async () => {
  fixture = await createSessionFilesViewFixture({
    serverUrl: 'https://review-round-reviewers.test',
    request: async (url) =>
      new URL(String(url)).pathname === '/v1/reviews/comments'
        ? Response.json({ items: [], cursor: null })
        : Response.json({}, { status: 404 }),
  });
  const artifact: DecryptedArtifact = {
    id: 'review-round-reviewers',
    sourceServerId: fixture.scope.serverId,
    title: 'Retry reconnect with backoff',
    isDecrypted: true,
    header: {
      kind: 'review.v1',
      v: 1,
      reviewId: 'review-round-reviewers',
      title: 'Retry reconnect with backoff',
    },
    body: JSON.stringify(historicalRound),
    ownerAccountId: 'alice',
    access: 'owner',
    storageMode: 'plain',
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  fixture.artifacts.replaceStoredRow(
    createPlainArtifactHttpFixture(artifact, 'alice'),
  );
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { t } = await import('@/text');
  const screen = await fixture.render(
    <ReviewDetailHost
      artifact={artifact}
      bodyState="ready"
      onRetry={() => {}}
    />,
  );
  const textOf = (testID: string) =>
    screen
      .findByTestId(testID)
      ?.findAll((node) => typeof node.type === 'string')
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === 'string')
      .join(' ') ?? '';
  try {
    await vi.waitFor(() => expect(screen.findHostByTestId('review-detail:partial')).not.toBeNull());
    expect(textOf('review-detail:participant:step-1-reviewer-1')).toContain('Claude');
    // A one-reviewer Partial round names its reviewer even with no individual result (U8 R5 P8).
    expect(textOf('review-detail:partial')).toContain(t('reviewWalkthrough.detail.reviewersDidntFinish', { names: 'Claude', count: 1 }));
    // The round card says the same outcome as the notice and Runs (U8 R6 P11).
    expect(textOf('review-detail:participant:step-1-reviewer-1')).toContain(t('reviewWalkthrough.detail.reviewerDidntFinish'));
    const { ReviewDetailView } = await import('./ReviewDetailView');
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('runs'));
    // Its only reviewer is the one that didn't finish (U8 R5 P8), on Runs as in the notice.
    expect(textOf('review-detail:run:step-1-reviewer-1')).toContain('Claude');
    expect(textOf('review-detail:run:step-1-reviewer-1')).toContain(t('reviewWalkthrough.detail.reviewerDidntFinish'));
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('activity'));
    expect(screen.findHostByTestId('review-activity:reviewer:1:step-1-reviewer-1')).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it('uses the same persisted reviewer results on the round, Runs, notice and Activity despite running execution markers', async () => {
  // Stored output captured from the real P02 round start/settlement producer; no internal reader is mocked.
  const reviewId = 'sealed-review';
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://sealed-review.test', request: async url =>
    new URL(String(url)).pathname === '/v1/reviews/comments' ? Response.json({ items: [], cursor: null }) : Response.json({}, { status: 404 }),
    rpc: request => {
      if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { run: ExecutionRunPublicStateSchema.parse({
        runId: ExecutionRunGetRequestSchema.parse(request.payload).runId, callId: 'call', sidechainId: 'side', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 5000 }) };
      return undefined;
    } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Addition', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Addition' }, body: JSON.stringify(settledRound),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const { formatElapsedDuration } = await import('@/components/machines/durationWords');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  const textOf = (id: string) => screen.findByTestId(id)?.findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children).filter((child): child is string => typeof child === 'string').join(' ') ?? '';
  try {
    await vi.waitFor(() => expect(textOf('review-detail:participant:first')).toContain(t('reviewWalkthrough.detail.reviewerDidntFinish')));
    expect(textOf('review-detail:participant:second')).toContain(t('reviewWalkthrough.collection.stateCompleted'));
    expect(textOf('review-detail:partial')).toContain('Claude reviewer');
    expect(textOf('review-detail:partial')).not.toContain('Codex reviewer');
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('runs'));
    expect(textOf('review-detail:run:claude')).toContain('Claude reviewer');
    expect(textOf('review-detail:run:claude')).toContain(t('reviewWalkthrough.detail.reviewerDidntFinish'));
    expect(textOf('review-detail:run:claude')).toContain(formatElapsedDuration(7000));
    expect(textOf('review-detail:run:claude')).not.toContain(t('reviewWalkthrough.collection.stateRunning'));
    expect(textOf('review-detail:run:codex')).toContain(t('reviewWalkthrough.collection.stateCompleted'));
    expect(textOf('review-detail:run:codex')).toContain(formatElapsedDuration(3000));
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('activity'));
    expect(textOf('review-activity:reviewer:1:first')).toContain('Claude reviewer');
    expect(textOf('review-activity:reviewer:1:second')).toContain('Codex reviewer');
  } finally { await screen.unmount(); }
});

it('names two same-Agent reviewers by step everywhere, counts Runs by its rows and offers Retry both (captured Review 5bee0f3e)', async () => {
  const reviewId = '5bee0f3e-394c-463f-b1f8-ed1f0142d611';
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://two-step-partial.test', request: async url =>
    new URL(String(url)).pathname === '/v1/reviews/comments' ? Response.json({ items: [], cursor: null }) : Response.json({}, { status: 404 }) });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Code review', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Code review' }, body: JSON.stringify(twoStepRound),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  const textOf = (id: string) => screen.findByTestId(id)?.findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children).filter((child): child is string => typeof child === 'string').join(' ') ?? '';
  const first = t('reviewWalkthrough.detail.reviewerInStep', { name: 'Claude', step: 1 });
  const second = t('reviewWalkthrough.detail.reviewerInStep', { name: 'Claude', step: 2 });
  try {
    await vi.waitFor(() => expect(textOf('review-detail:participant:step-1-reviewer-1')).toContain(first));
    expect(textOf('review-detail:participant:step-2-reviewer-1')).toContain(second);
    expect(textOf('review-detail:participant:step-1-reviewer-1')).toContain(t('reviewWalkthrough.detail.reviewerDidntFinish'));
    // The notice names who didn't finish (never "Both") and offers to retry them together.
    expect(textOf('review-detail:partial')).toContain(first);
    expect(textOf('review-detail:partial')).toContain(second);
    expect(textOf('review-detail:partial')).toContain(t('reviewWalkthrough.detail.retryUnfinished', { count: 2 }));
    const view = screen.findByType(ReviewDetailView);
    expect(view.props.tabs.find((tab: { id: string }) => tab.id === 'runs')?.count).toBe(2);
    await act(async () => view.props.onSelectTab('runs'));
    expect(textOf('review-detail:runs')).toContain(t('reviewWalkthrough.detail.reviewers'));
    expect(textOf('review-detail:run:run_request_f212387f05a3a279d3258266e81d74c93e70d34ef5024eae0c5fa7d8d566655f')).toContain(first);
    // The Workflow run is the section's way to its run, not a third row.
    expect(screen.findAllByTestId('review-detail:runs:workflow').length).toBeGreaterThan(0);
    expect(screen.findByTestId('review-detail:run:bc6b38d7-13ba-4f73-bf98-771ccff08ed8')).toBeNull();
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('activity'));
    expect(textOf('review-activity:reviewer:1:step-2-reviewer-1')).toContain(second);
  } finally { await screen.unmount(); }
});

it('keeps the step-2 name in round 2 and says why it did not finish (U8 R5 P7, reason)', async () => {
  const reviewId = 'two-round-review';
  const first = twoStepRound.rounds[0]!;
  const second = { ...first, ordinal: 2, startedAt: first.finishedAt + 1, finishedAt: first.finishedAt + 9000,
    reviewerIds: ['step-2-reviewer-1'], reviewerDisplayNames: { 'step-2-reviewer-1': 'claude' },
    runs: [{ kind: 'workflow', runId: '22222222-2222-4222-8222-222222222222' }],
    reviewerOutcomes: [{ reviewerId: 'step-2-reviewer-1', displayName: 'claude', outcome: 'partial', runId: 'run-2',
      startedAt: first.finishedAt + 2, finishedAt: first.finishedAt + 8000, reason: { run: 'launch_failed' } }] };
  // The findings read never answers; the round, notice and Runs speak from the record alone.
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://two-round.test', request: async url =>
    new URL(String(url)).pathname === '/v1/reviews/comments' ? new Promise<Response>(() => {}) : Response.json({}, { status: 404 }) });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Code review', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Code review' }, body: JSON.stringify({ v: 1, rounds: [first, second] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  const textOf = (id: string) => screen.findByTestId(id)?.findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children).filter((child): child is string => typeof child === 'string').join(' ') ?? '';
  const stepTwo = t('reviewWalkthrough.detail.reviewerInStep', { name: 'Claude', step: 2 });
  try {
    await vi.waitFor(() => expect(textOf('review-detail:participant:step-2-reviewer-1')).toContain(stepTwo));
    expect(textOf('review-detail:partial')).toContain(stepTwo);
    expect(textOf('review-detail:partial')).toContain(t('reviewWalkthrough.detail.reasonLaunchFailed'));
    expect(textOf('review-detail:partial')).toContain(t('reviewWalkthrough.detail.retryReviewer', { name: stepTwo }));
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('runs'));
    expect(textOf('review-detail:run:run-2')).toContain(stepTwo);
    expect(textOf('review-detail:run:run-2')).toContain(t('reviewWalkthrough.detail.reasonLaunchFailed'));
  } finally { await screen.unmount(); }
});

it('lets a running Review be stopped through its run, lists its running reviewer with a way to its run, and says nothing was found yet (U8 R6 RN1, RN2)', async () => {
  const reviewId = 'running-review';
  const runId = '33333333-3333-4333-8333-333333333333';
  const startedAt = Date.UTC(2026, 10, 22, 14, 2);
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://running-review.test', request: async url =>
    new URL(String(url)).pathname === '/v1/reviews/comments' ? Response.json({ items: [], cursor: null }) : Response.json({}, { status: 404 }) });
  const { getStorage } = await import('@/sync/domains/state/storage');
  const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
  const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
  // The Review's Workflow run as the run owner holds it (running, Stop available).
  getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: runId, state: 'running' }))]);
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Code review', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Code review' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'running', startedAt, finishedAt: null, reviewerIds: ['step-1-reviewer-1'],
      reviewerDisplayNames: { 'step-1-reviewer-1': 'claude' }, runs: [{ kind: 'workflow', runId }] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  const textOf = (id: string) => screen.findByTestId(id)?.findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children).filter((child): child is string => typeof child === 'string').join(' ') ?? '';
  try {
    await vi.waitFor(() => expect(screen.findByTestId('review-detail:findings-empty')).not.toBeNull());
    expect(textOf('review-detail:findings-empty')).toContain(t('reviewWalkthrough.detail.findingsNoneYet'));
    await vi.waitFor(() => expect(screen.findByType(ReviewDetailView).props.primaryAction?.title).toBe(t('workflows.transcriptCard.stopReviewing')));
    const view = screen.findByType(ReviewDetailView);
    expect(view.props.tabs.find((tab: { id: string }) => tab.id === 'runs')?.count).toBe(1);
    await act(async () => view.props.onSelectTab('runs'));
    expect(textOf('review-detail:run:step-1-reviewer-1')).toContain('Claude');
    expect(textOf('review-detail:run:step-1-reviewer-1')).toContain(t('reviewWalkthrough.collection.stateRunning'));
    expect(screen.findByTestId('review-detail:runs:empty')).toBeNull();
  } finally { await screen.unmount(); }
});
