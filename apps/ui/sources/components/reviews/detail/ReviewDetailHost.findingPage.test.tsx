import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
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

// A phone: the opened finding is pushed as its own page (lab `detail-finding-390`).
installSessionFilesViewBoundaries({
  platformOS: 'web',
  reactNativeOverrides: {
    useWindowDimensions: () => ({
      width: 390,
      height: 844,
      scale: 2,
      fontScale: 1,
    }),
  },
});
await prepareSessionFilesViewTestkit();
let fixture:
  | Awaited<ReturnType<typeof createSessionFilesViewFixture>>
  | undefined;
afterEach(async () => {
  standardCleanup();
  await fixture?.dispose();
  fixture = undefined;
});

it('titles a pushed finding with the finding itself under its severity and place, and pins its decision bar', async () => {
  const reviewId = 'pushed-finding-review';
  const first = buildReviewCommentFixture({
    id: 'first-root',
    threadId: 'first-root',
    reviewId,
    accountId: 'alice',
    state: 'open',
    roundOrdinal: 1,
    findingIdentity: 'a'.repeat(64),
    finding: {
      id: 'first-finding',
      title: 'Settings modal remounts',
      summary: 'Remounts on every tab',
      severity: 'blocker',
      category: 'correctness',
    },
  });
  const opened = buildReviewCommentFixture({
    id: 'opened-root',
    threadId: 'opened-root',
    reviewId,
    accountId: 'alice',
    state: 'open',
    reviewTriageStatus: 'accept',
    roundOrdinal: 1,
    findingIdentity: 'b'.repeat(64),
    finding: {
      id: 'opened-finding',
      title: 'Effect re-subscribes every render',
      summary: 'No dependency list',
      severity: 'high',
      category: 'correctness',
    },
  });
  fixture = await createSessionFilesViewFixture({
    serverUrl: 'https://pushed-finding-review.test',
    request: async (url) => {
      if (new URL(String(url)).pathname === '/v1/reviews/comments')
        return Response.json({
          items: [first, opened].map(storePlainReviewCommentFixture),
          cursor: null,
        });
      return Response.json({}, { status: 404 });
    },
  });
  const artifact: DecryptedArtifact = {
    id: reviewId,
    sourceServerId: fixture.scope.serverId,
    title: 'Pushed finding',
    isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Pushed finding' },
    body: JSON.stringify({
      v: 1,
      rounds: [
        {
          ordinal: 1,
          state: 'completed',
          startedAt: 1,
          finishedAt: 2,
          reviewerIds: [],
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
  const { PageHeader } = await import('@/components/ui/layout/PageHeader');
  const { t } = await import('@/text');
  const screen = await fixture.render(
    <ReviewDetailHost
      artifact={artifact}
      bodyState="ready"
      onRetry={() => {}}
      focusThreadId="opened-root"
    />,
  );
  try {
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('review-detail:finding-page'),
      ).not.toBeNull(),
    );
    const header = screen.findByType(PageHeader);
    // The finding is the page's title; the Review's own title is not repeated over it.
    expect(header.props.title).toBe('Effect re-subscribes every render');
    expect(header.props.kicker).toContain(
      t('reviewWalkthrough.detail.findingPosition', { index: 2, total: 2 }),
    );
    // Its decision waits in the one bottom bar, the persisted decision chosen.
    expect(
      screen.findHostByTestId('review-detail:decision-bar'),
    ).not.toBeNull();
    expect(
      screen.findHostByTestId('review-detail:decision:accept')?.props
        .accessibilityState.checked,
    ).toBe(true);
    expect(
      screen.findHostByTestId('review-detail:decision:reject')?.props
        .accessibilityState.checked,
    ).toBe(false);
  } finally {
    await screen.unmount();
  }
});
