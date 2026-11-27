import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionActorV1';
import {
  createSessionFilesViewFixture,
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import {
  buildReviewCommentFixture,
  storePlainReviewCommentFixture,
} from '@/dev/testkit/fixtures/reviewComments';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';

// The Review page's quiet states (U8 R3 B3–B5): what it says with no score, no findings, and a finding it can't show.
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

async function renderReview(
  params: Readonly<{
    reviewId: string;
    state: 'completed' | 'partial';
    comments: readonly ReviewCommentV1[];
    requestedBy?: ActionActorV1;
    metadataResponse?: () => Response;
  }>,
) {
  fixture = await createSessionFilesViewFixture({
    serverUrl: `https://${params.reviewId}.test`,
    request: async (url) => {
      if (new URL(String(url)).pathname === '/v1/session-access/principals/resolve')
        return Response.json({ v: 1, principals: [{ kind: 'account',
          accountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1', name: 'QA TH B',
          firstName: null, lastName: null, username: 'qa-th-b-1025', avatarUrl: null }] });
      if (new URL(String(url)).pathname === '/v1/reviews/get' && params.metadataResponse)
        return params.metadataResponse();
      if (new URL(String(url)).pathname === '/v1/reviews/comments')
        return Response.json({
          items: params.comments.map(storePlainReviewCommentFixture),
          cursor: null,
        });
      return Response.json({}, { status: 404 });
    },
  });
  const artifact: DecryptedArtifact = {
    id: params.reviewId,
    sourceServerId: fixture.scope.serverId,
    title: 'Code review',
    isDecrypted: true,
    header: {
      kind: 'review.v1',
      v: 1,
      reviewId: params.reviewId,
      title: 'Code review',
      ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
    },
    body: JSON.stringify({
      v: 1,
      rounds: [
        {
          ordinal: 1,
          state: params.state,
          startedAt: 1,
          finishedAt: 2,
          reviewerIds: ['step-1-reviewer-1'],
          runs: [],
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
    updatedAt: 1,
  };
  fixture.artifacts.replaceStoredRow(
    createPlainArtifactHttpFixture(artifact, 'alice'),
  );
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  return await fixture.render(
    <ReviewDetailHost
      artifact={artifact}
      bodyState="ready"
      onRetry={() => {}}
    />,
  );
}

it('names the admitted requester on a Review whose Machine belongs to another person', async () => {
  const screen = await renderReview({ reviewId: 'shared-machine-requester', state: 'completed', comments: [],
    requestedBy: { actorKind: 'person', accountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1' } });
  try {
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Requested by QA TH B'));
    expect(screen.getTextContent()).not.toContain('Requested by alice');
  } finally { await screen.unmount(); }
});

it('shows the requester as unknown for a Review recorded without one', async () => {
  const screen = await renderReview({ reviewId: 'historical-review-requester', state: 'completed', comments: [] });
  try {
    expect(screen.getTextContent()).toContain('Requested by Unknown');
  } finally { await screen.unmount(); }
});

it('keeps the opened Review visible and retries its typed metadata read failure', async () => {
  const reviewId = 'metadata-failed-review';
  let failed = false;
  const screen = await renderReview({ reviewId, state: 'completed', comments: [], metadataResponse: () => failed
    ? Response.json({ error: 'database_transaction_conflict_exhausted', statusCode: 503 }, { status: 503 })
    : Response.json({
      review: { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
        state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
        counts: { total: 0, needsDecision: 0 } },
      human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou: { reviewId, roundOrdinal: 1,
        reason: 'review_needs_you', needsYou: false, requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } },
    }),
  });
  try {
    const { getReviewDetailSnapshot, reviewDetailKey } = await import('@/sync/store/domains/reviews/detail');
    const key = reviewDetailKey({ serverId: fixture!.scope.serverId, accountId: 'alice' }, reviewId);
    await vi.waitFor(() => expect(getReviewDetailSnapshot(key).status).toBe('ready'));
    failed = true;
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } = await import('@happier-dev/protocol/artifacts/artifactKindV1');
    publishHomeAccountChange(fixture!.scope.serverId, [reviewId], { changeKinds: ['artifact'],
      artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
    await vi.waitFor(() => expect(getReviewDetailSnapshot(key).error?.code).toBe('database_transaction_conflict_exhausted'));
    await vi.waitFor(() => expect(screen.findByTestId('review-detail:metadata-failure-action')).not.toBeNull());
    await screen.pressByTestIdAsync('review-detail:metadata-failure-details-toggle');
    expect(screen.getTextContent()).toContain('database_transaction_conflict_exhausted');
    expect(screen.getTextContent()).toContain('Code review');
    failed = false;
    await screen.pressByTestIdAsync('review-detail:metadata-failure-action');
    await vi.waitFor(() => expect(screen.findByTestId('review-detail:metadata-failure')).toBeNull());
    expect(getReviewDetailSnapshot(key).status).toBe('ready');
    expect(screen.getTextContent()).toContain('Code review');
  } finally { await screen.unmount(); }
});

it('shows zero scored coverage for a partial round and one line when it found nothing (UI refinements 1125)', async () => {
  const screen = await renderReview({
    reviewId: 'nothing-to-fix',
    state: 'partial',
    comments: [],
  });
  const { t } = await import('@/text');
  try {
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('review-detail:findings-empty'),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain(
      t('reviewWalkthrough.detail.findingsEmpty'),
    );
    // A partial round keeps its coverage line even when no reviewer scored.
    expect(screen.findHostByTestId('review-detail:quality')).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});

it('names a finding it cannot show by its place and says why, with its own words and the way to see it', async () => {
  const detailless = buildReviewCommentFixture({
    id: 'detailless-root',
    threadId: 'detailless-root',
    reviewId: 'detailless-review',
    accountId: 'alice',
    state: 'open',
    roundOrdinal: 1,
    findingIdentity: 'd'.repeat(64),
    anchor: { kind: 'line', filePath: 'qa-reviews.ts', line: 3 },
    body: 'Total subtracts each price',
  });
  const screen = await renderReview({
    reviewId: 'detailless-review',
    state: 'completed',
    comments: [detailless, buildReviewCommentFixture({
      id: 'redacted-root', reviewId: 'detailless-review', accountId: 'alice', roundOrdinal: 1,
      findingIdentity: 'f'.repeat(64), flags: { redacted: true }, body: 'Withheld sensitive finding body',
    })],
  });
  const { t } = await import('@/text');
  try {
    const testID = 'review-detail:unavailable-finding:detailless-root';
    await vi.waitFor(() =>
      expect(screen.findHostByTestId(testID)).not.toBeNull(),
    );
    const text = screen.getTextContent();
    expect(text).toContain(
      t('reviewWalkthrough.detail.findingNoDetailsAt', {
        location: 'qa-reviews.ts:3',
      }),
    );
    expect(text).toContain('Total subtracts each price');
    expect(text).not.toContain(
      t('files.reviewComments.durable.contentUnavailable'),
    );
    expect(screen.findHostByTestId('review-detail:unavailable-finding:redacted-root')).not.toBeNull();
    expect(text).toContain(t('reviewWalkthrough.detail.findingRedacted'));
    expect(text).not.toContain('Withheld sensitive finding body');
    expect(screen.findByTestId('review-detail:unavailable-finding:redacted-root:action')).toBeNull();
    await screen.pressByTestIdAsync(`${testID}:action`);
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('review-detail:panel:changes'),
      ).not.toBeNull(),
    );
  } finally {
    await screen.unmount();
  }
});

it('says which commit fixed a resolved finding on its row (lab detail-fixed: "Fixed in a5c09e2")', async () => {
  const fixed = buildReviewCommentFixture({
    id: 'fixed-root',
    threadId: 'fixed-root',
    reviewId: 'fixed-in-review',
    accountId: 'alice',
    state: 'resolved',
    reviewTriageStatus: 'accept',
    roundOrdinal: 1,
    findingIdentity: 'e'.repeat(64),
    finding: { id: 'fixed-finding', title: 'Unsaved draft is lost when the modal closes', summary: 'The draft is cleared on close',
      severity: 'blocker', category: 'correctness' },
    transitions: [{ transitionId: 'resolve', fromState: 'open', toState: 'resolved', transitionedAt: 2,
      transitionedBy: { kind: 'user', userId: 'alice' }, serverRevision: 2,
      evidence: [{ kind: 'commit', sha: 'a5c09e2b7f0d4c1e9a8b6c5d4e3f2a1b0c9d8e7f' }] }],
  });
  const screen = await renderReview({ reviewId: 'fixed-in-review', state: 'completed', comments: [fixed] });
  const { t } = await import('@/text');
  try {
    await vi.waitFor(() => expect(screen.findHostByTestId('review-finding-decision:fixed-root')).not.toBeNull());
    expect(screen.getTextContent()).toContain(t('reviewWalkthrough.detail.fixedIn', { sha: 'a5c09e2' }));
  } finally {
    await screen.unmount();
  }
});
