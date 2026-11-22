import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionRunGetRequestSchema, ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import settledRound from '@/dev/testkit/fixtures/settledReviewRound.json';
import historicalRound from '@/dev/testkit/fixtures/historicalReviewRound.json';
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
    expect(textOf('review-detail:participant:step-1-reviewer-1').trim()).toBe('Claude');
    expect(textOf('review-detail:partial')).toContain(t('reviewWalkthrough.detail.qualityPartial'));
    const { ReviewDetailView } = await import('./ReviewDetailView');
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('runs'));
    expect(textOf('review-detail:run:step-1-reviewer-1').trim()).toBe('Claude');
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
    await vi.waitFor(() => expect(textOf('review-detail:participant:first')).toContain(t('reviewWalkthrough.collection.statePartial')));
    expect(textOf('review-detail:participant:second')).toContain(t('reviewWalkthrough.collection.stateCompleted'));
    expect(textOf('review-detail:partial')).toContain('Claude reviewer');
    expect(textOf('review-detail:partial')).not.toContain('Codex reviewer');
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('runs'));
    expect(textOf('review-detail:run:claude')).toContain('Claude reviewer');
    expect(textOf('review-detail:run:claude')).toContain(t('reviewWalkthrough.collection.statePartial'));
    expect(textOf('review-detail:run:claude')).toContain(formatElapsedDuration(7000));
    expect(textOf('review-detail:run:claude')).not.toContain(t('reviewWalkthrough.collection.stateRunning'));
    expect(textOf('review-detail:run:codex')).toContain(t('reviewWalkthrough.collection.stateCompleted'));
    expect(textOf('review-detail:run:codex')).toContain(formatElapsedDuration(3000));
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('activity'));
    expect(textOf('review-activity:reviewer:1:first')).toContain('Claude reviewer');
    expect(textOf('review-activity:reviewer:1:second')).toContain('Codex reviewer');
  } finally { await screen.unmount(); }
});
