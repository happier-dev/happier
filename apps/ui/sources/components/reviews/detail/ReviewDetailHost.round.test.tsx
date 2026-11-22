import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
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

it('names each reviewer of a settled partial round with only the outcome the round proves, not the round state again', async () => {
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
    body: JSON.stringify({
      v: 1,
      rounds: [
        {
          ordinal: 1,
          state: 'partial',
          startedAt: 1,
          finishedAt: 2,
          reviewerIds: ['step-1-reviewer-1', 'step-1-reviewer-2'],
          reviewerDisplayNames: { 'step-1-reviewer-1': 'Codex' },
          reviewerQuality: [
            {
              reviewerId: 'step-1-reviewer-1',
              displayName: 'Codex',
              score: 4,
              rationale: 'Clean.',
            },
          ],
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
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('review-detail:participant:step-1-reviewer-1'),
      ).not.toBeNull(),
    );
    expect(textOf('review-detail:participant:step-1-reviewer-1')).toContain(
      'Codex',
    );
    expect(textOf('review-detail:participant:step-1-reviewer-1')).toContain(
      t('reviewWalkthrough.collection.stateCompleted'),
    );
    // A reviewer the partial round does not vouch for is named by its place, never its positional id, and given no
    // invented state: the round's record does not yet say which reviewer fell short.
    expect(textOf('review-detail:participant:step-1-reviewer-2').trim()).toBe(
      t('reviewWalkthrough.detail.reviewerRun', { count: 2 }),
    );
    // The section says who; the notice line already says the round was partial.
    expect(textOf('review-detail:group:reviewers')).not.toContain(
      t('reviewWalkthrough.collection.statePartial'),
    );
  } finally {
    await screen.unmount();
  }
});
