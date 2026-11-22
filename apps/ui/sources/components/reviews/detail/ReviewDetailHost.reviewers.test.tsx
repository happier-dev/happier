import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

it('filters captured excerpts by reviewer in the opened round without reading comments again, preserving the choice through Walkthrough', async () => {
  const reviewId = 'reviewer-filter-review';
  const comments = [
    { id: 'claude-finding', engineId: 'claude', roundOrdinal: 2 },
    { id: 'codex-finding', engineId: 'codex', roundOrdinal: 2 },
    { id: 'previous-finding', engineId: 'claude', roundOrdinal: 1 },
    { id: 'previous-codex-finding', engineId: 'codex', roundOrdinal: 1 },
    { id: 'opaque-finding', engineId: 'step-opaque-engine', roundOrdinal: 2 },
  ].map((input, index) => buildReviewCommentFixture({ ...input, reviewId, accountId: 'alice', threadId: input.id,
    findingIdentity: String(index + 1).repeat(64),
    finding: { id: input.id, title: input.id, summary: 'Check reconnect behavior', severity: 'high', category: 'correctness' },
    snapshot: { kind: 'text', beforeContext: [], selectedLines: ['retry();'], afterContext: [], capturedAt: 1,
      selectedLinesHash: 'selected', contextWindowHash: 'context', fileLength: 1, source: 'workingTree',
      isUncommitted: false, isUntracked: false, truncated: false, hasBidiControls: false, likelyMinified: false } }));
  let commentReads = 0;
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://reviewer-filter.test', request: async url => {
    if (new URL(String(url)).pathname === '/v1/reviews/comments') {
      commentReads += 1;
      return Response.json({ items: comments.map(storePlainReviewCommentFixture), cursor: null });
    }
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Reconnect safely', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Reconnect safely' },
    body: JSON.stringify({ v: 1, rounds: [1, 2].map(ordinal => ({ ordinal, state: 'completed', startedAt: 1, finishedAt: 2,
      reviewerIds: ['claude-reviewer', 'codex-reviewer'], reviewerDisplayNames: { 'claude-reviewer': 'Claude', 'codex-reviewer': 'Codex' }, runs: [] })) }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { ReviewChangesHost } = await import('../ReviewChangesHost');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  try {
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectTab('changes'));
    await vi.waitFor(() => expect(screen.findHostByTestId('review-changes-excerpt:codex-finding')).not.toBeNull());
    expect(screen.findHostByTestId('review-changes:reviewer:step-opaque-engine')?.props.accessibilityLabel)
      .toBe(t('reviewWalkthrough.detail.reviewerRun', { count: 3 }));
    const readsBeforeSelection = commentReads;
    await screen.pressByTestIdAsync('review-changes:reviewer:claude');
    expect(screen.findHostByTestId('review-changes-excerpt:claude-finding')).not.toBeNull();
    expect(screen.findHostByTestId('review-changes-excerpt:codex-finding')).toBeNull();
    expect(screen.findHostByTestId('review-changes-excerpt:previous-finding')).toBeNull();
    await act(async () => screen.findByType(ReviewChangesHost).props.onSelectView('walkthrough'));
    expect(screen.findHostByTestId('review-changes:reviewer:claude')?.props.accessibilityState.checked).toBe(true);
    expect(screen.findHostByTestId('review-changes-excerpt:codex-finding')).toBeNull();
    await screen.pressByTestIdAsync('review-changes:reviewer:all');
    expect(screen.findHostByTestId('review-changes-excerpt:codex-finding')).not.toBeNull();
    expect(commentReads).toBe(readsBeforeSelection);
    await screen.pressByTestIdAsync('review-changes:reviewer:codex');
    await act(async () => screen.findByType(ReviewDetailView).props.onSelectRound(1));
    expect(screen.findHostByTestId('review-changes-excerpt:previous-finding')).not.toBeNull();
    expect(screen.findHostByTestId('review-changes:reviewer:all')?.props.accessibilityState.checked).toBe(true);
  } finally { await screen.unmount(); }
});
