import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewFindingsV2 } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { changeTextTestInstance, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainV2SessionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit }
  from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

it('clarifies each current native appearance with its own run and local finding identity while View access keeps questions read-only', async () => {
  const sessionId = 'retained-session';
  const reviewId = 'native-clarification';
  const finding = { id: 'original-local', title: 'Persisted finding', summary: 'Preserve the producing reviewer.',
    category: 'correctness' as const, severity: 'high' as const };
  const root = buildReviewCommentFixture({ id: 'native-root', accountId: 'alice', reviewId, findingId: finding.id, finding,
    findingIdentity: 'a'.repeat(64), sessionId, runId: 'old-run', roundOrdinal: 1,
    appearances: [{ roundOrdinal: 1, reviewerId: 'first', runId: 'old-run', sessionId },
      { roundOrdinal: 2, reviewerId: 'first', runId: 'first-current', sessionId },
      { roundOrdinal: 2, reviewerId: 'second', runId: 'second-current', sessionId }] });
  const payloadFor = (runId: string): ReviewFindingsV2 => ({
    runRef: { runId, callId: `${runId}-call`, backendId: 'claude', retentionPolicy: 'resumable' },
    summary: 'Finding', overviewMarkdown: 'Finding', generatedAtMs: 1,
    questions: [{ id: `${runId}-question`, text: `${runId} retained question`, status: 'open' }], assumptions: [],
    findings: [{ ...finding, id: `${runId}-local`, comment: { id: root.id, reviewId, serverRevision: 1, state: 'open' } }],
  });
  const runFor = (runId: string) => ExecutionRunPublicStateSchema.parse({ runId, callId: `${runId}-call`,
    sidechainId: `${runId}-side`, intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'streaming',
    status: 'succeeded', startedAtMs: 1 });
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://native-clarification.test', sessionId,
    settings: { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'execution.run.action': ['ui'] } } },
    rpc: request => {
      if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
        const { runId } = request.payload as { runId: string };
        return { run: runFor(runId), reviewFindings: payloadFor(runId) };
      }
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) return { ok: true };
      return undefined;
    },
    request: createSessionReadBatchFetchBoundary(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/reviews/comments') return Response.json({ items: [storePlainReviewCommentFixture(root)], cursor: null });
      if (path === `/v2/sessions/${sessionId}`) return Response.json({ session: createPlainV2SessionRecordFixture({
        id: sessionId, metadata: { path: '/repo', host: 'test', machineId: 'm1' },
      }) });
      return Response.json({}, { status: 404 });
    }),
  });
  const artifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'QA native clarification',
    isDecrypted: true, header: { kind: 'review.v1', v: 1, reviewId, title: 'QA native clarification' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
      reviewerIds: ['first'], runs: [{ kind: 'execution', machineId: 'm1', sessionId, runId: 'old-run' }] },
    { ordinal: 2, state: 'completed', startedAt: 3, finishedAt: 4, reviewerIds: ['first', 'second'],
      runs: ['first-current', 'second-current'].map(runId => ({ kind: 'execution', machineId: 'm1', sessionId, runId })) }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1,
    seq: 1, createdAt: 1, updatedAt: 1 } satisfies DecryptedArtifact;
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} focusThreadId={root.id} />);
  try {
    await vi.waitFor(() => expect(screen.findByTestId(`review-finding-body:${root.id}`)).not.toBeNull());
    await vi.waitFor(() => expect(fixture!.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(2));
    // The same real reader must successfully expose retained structured results before the missing row affordance is RED.
    await vi.waitFor(() => {
      expect(screen.getTextContent()).toContain('first-current retained question');
      expect(screen.getTextContent()).toContain('second-current retained question');
    });
    const composer = screen.findByTestId(`review-finding-ask-field:${root.id}`);
    expect(composer, 'A current retained appearance must expose the existing clarification composer').not.toBeNull();
    const input = composer!.findAll(node => node.props.testID === 'new-session-composer-input' && typeof node.props.onChangeText === 'function')[0]!;
    await act(async () => changeTextTestInstance(input, 'Why is this still a defect?'));
    const send = composer!.findAll(node => node.props.testID === 'new-session-composer-send' && typeof node.props.onPress === 'function')[0]!;
    await act(async () => { await send.props.onPress(); });
    await vi.waitFor(() => expect(fixture!.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION)
      .map(request => ({ targetId: request.targetId, payload: request.payload }))).toEqual([
      { targetId: sessionId, payload: { runId: 'first-current', actionId: 'review.follow_up',
        input: { findingIds: ['first-current-local'], messageMarkdown: 'Why is this still a defect?' } } },
      { targetId: sessionId, payload: { runId: 'second-current', actionId: 'review.follow_up',
        input: { findingIds: ['second-current-local'], messageMarkdown: 'Why is this still a defect?' } } },
    ]));
  } finally { await screen.unmount(); }
  const viewArtifact = { ...artifact, ownerAccountId: 'bob', access: 'view' } satisfies DecryptedArtifact;
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(viewArtifact, 'bob'));
  const view = await fixture.render(<ReviewDetailHost artifact={viewArtifact} bodyState="ready" onRetry={() => {}} focusThreadId={root.id} />);
  try {
    await vi.waitFor(() => expect(view.getTextContent()).toContain('first-current retained question'));
    expect(view.findByTestId(`review-finding-body:${root.id}`)).not.toBeNull();
    expect(view.findByTestId(`review-finding-ask-field:${root.id}`), 'View access must not invite a refused follow-up').toBeNull();
  } finally { await view.unmount(); }
});
