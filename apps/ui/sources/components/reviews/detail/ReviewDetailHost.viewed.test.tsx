import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import type { ScmComparisonCaptureOutput } from '@happier-dev/protocol/scm/diffSummary';
import type { ReviewRoundComparisonCaptureV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
  createSessionFilesViewFixture,
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture:
  | Awaited<ReturnType<typeof createSessionFilesViewFixture>>
  | undefined;
let viewedLease: ReturnType<typeof import('@/sync/ops/scmDiffSummary/fileViewedSources').acquireScmFileViewedSource> | undefined;
afterEach(async () => {
  viewedLease?.release();
  viewedLease = undefined;
  standardCleanup();
  await fixture?.dispose();
  fixture = undefined;
});

const PATHS = [
  'src/reconnectPolicy.ts',
  'src/jitter.ts',
  'docs/sync.md',
] as const;
const VIEWED_ACTIONS = {
  read: { action: { pluginId: 'example.forge', localId: 'read-viewed' } },
  set: { action: { pluginId: 'example.forge', localId: 'set-viewed' } },
};
const COMPARISON_ID = 'e'.repeat(64);
const SOURCE = {
  kind: 'pullRequest',
  locator: {
    providerId: 'example.forge',
    repository: 'example/repo',
    number: 2481,
    fileViewedActions: VIEWED_ACTIONS,
  },
} as const;

function reviewArtifact(serverId: string): DecryptedArtifact {
  const capture = {
    target: { kind: 'machine', machineId: 'm1' },
    input: { cwd: '/repo', comparisonId: COMPARISON_ID, source: SOURCE },
  } satisfies ReviewRoundComparisonCaptureV1;
  const rounds = [
    {
      ordinal: 1,
      state: 'completed',
      startedAt: 1,
      finishedAt: 2,
      reviewerIds: [
        'step-1-reviewer-1',
        'step-1-reviewer-2',
        'step-1-reviewer-3',
      ],
      runs: [],
      comparisonCapture: capture,
      reviewerQuality: [
        {
          reviewerId: 'step-1-reviewer-1',
          score: 4,
          rationale: 'Clean backoff with a cap and a give-up path.',
        },
        {
          reviewerId: 'step-1-reviewer-2',
          score: 2,
          rationale: 'The jitter clamp is untested.',
        },
        {
          reviewerId: 'step-1-reviewer-3',
          score: 3,
          rationale: 'Sound backoff; one retry can pass 2 s.',
        },
      ],
    },
  ];
  return {
    id: 'review-quality-viewed',
    sourceServerId: serverId,
    title: 'Retry reconnect with backoff',
    isDecrypted: true,
    header: {
      kind: 'review.v1',
      v: 1,
      reviewId: 'review-quality-viewed',
      title: 'Retry reconnect with backoff',
    },
    body: JSON.stringify({ v: 1, rounds }),
    ownerAccountId: 'alice',
    access: 'owner',
    storageMode: 'plain',
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function renderReview(
  settings?: Readonly<{ reviewQualityAggregation: 'lowest' | 'median' }>,
  viewedStates: readonly string[] = ['unviewed', 'viewed', 'viewed'],
) {
  const serverUrl = 'https://review-viewed.test';
  const viewed = new Map<string, string>(PATHS.map((path, index) => [path, viewedStates[index]!]));
  const comparison = ScmComparisonSchema.parse({
    id: COMPARISON_ID,
    source: SOURCE,
    repository: { rootPath: '/repo' },
    endpoints: { after: 'head' },
    freshness: 'current',
    inventory: {
      state: 'complete',
      reasons: [],
      files: PATHS.map((path) => ({
        path,
        changeKind: 'modified',
        binary: false,
        generated: false,
        lockfile: false,
        evidence: {
          state: 'available',
          unifiedDiff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
        },
        occurrences: [{ id: `${path}:1`, alias: `${path}:1`, path, position: 0,
          before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
      })),
    },
  });
  fixture = await createSessionFilesViewFixture({
    serverUrl,
    rootPath: '/repo',
    settings,
    rpc: (request) =>
      request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE
        ? ({
            success: true,
            comparison,
            metadata: { source: SOURCE, sourceKey: 'pr-2481' },
          } satisfies ScmComparisonCaptureOutput)
        : undefined,
  });
  // The forge's own Viewed marks: the pull request's Actions are the boundary. The Review joins the one shared
  // source keyed by those Actions and the Account, as every PR Files surface does.
  const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
  const { acquireScmFileViewedSource } = await import('@/sync/ops/scmDiffSummary/fileViewedSources');
  const binding = await resolveServerCredentialAccountScope(fixture.scope.serverId);
  if (binding.kind !== 'bound') throw new Error('The fixture Account must bind');
  viewedLease = acquireScmFileViewedSource({ actions: VIEWED_ACTIONS,
    scopeKey: JSON.stringify([binding.scope, binding.credentialKey]), isCurrent: () => true,
    execute: async (invocation) => invocation.action.localId === 'read-viewed'
      ? { kind: 'ready', headOid: 'head', files: PATHS.map((path) => ({ path, state: viewed.get(path) })) }
      : { kind: 'ready', path: (invocation.input as { path: string }).path, state: 'viewed' } });
  viewedLease.setActive(true);
  await viewedLease.source.refresh();
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  return await fixture.render(
    <ReviewDetailHost
      artifact={reviewArtifact(fixture.scope.serverId)}
      bodyState="ready"
      onRetry={() => {}}
    />,
  );
}


it("hides viewed files through the Review's Hide viewed and says what it hid until Show brings them back", async () => {
  const screen = await renderReview();
  const { DiffFilesListView } =
    await import('@/components/ui/code/diff/DiffFilesListView');
  const { WorkspaceScmReviewBody } =
    await import('@/components/projects/scm/WorkspaceScmReviewBody');
  const { ScmComparisonHeaderToggle } = await import('@/components/sessions/files/comparison/ScmComparisonBar');
  const hideViewedValue = () => screen.findAllByType(ScmComparisonHeaderToggle)
    .find((toggle) => toggle.props.testID === 'review-changes:hide-viewed')?.props.value;
  const listed = () =>
    screen
      .findAllByType(DiffFilesListView)[0]
      ?.props.files.map((file: { key: string }) => file.key) ?? [];
  try {
    await screen.pressByTestIdAsync('review-detail:tab:changes');
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const states = () => screen.findAllByType(SurfaceStateCard).map((card) => card.props.title).join('; ');
    await vi.waitFor(() => expect(screen.findAllByType(WorkspaceScmReviewBody), states()).toHaveLength(1), { timeout: 10_000 });
    // The native viewport boundary is measured by layout in the running app.
    await act(async () => {
      screen
        .findAllByType(WorkspaceScmReviewBody)[0]
        ?.findAll((node) => typeof node.props.onLayout === 'function')[0]
        ?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } });
    });
    await vi.waitFor(() => expect(listed(), states()).toEqual([...PATHS]), { timeout: 10_000 });
    await vi.waitFor(() =>
      expect(screen.findByTestId('scm-file-viewed-fact'), states()).not.toBeNull(),
    { timeout: 10_000 });
    expect(
      hideViewedValue(),
    ).toBe(false);
    await screen.pressByTestIdAsync('review-changes:hide-viewed');
    await vi.waitFor(() => expect(listed()).toEqual([PATHS[0]]));
    expect(
      hideViewedValue(),
    ).toBe(true);
    expect(
      screen.findAllByTestId('scm-review-viewed-hidden').length,
    ).toBeGreaterThan(0);
    await screen.pressByTestIdAsync('scm-review-viewed-show');
    await vi.waitFor(() => expect(listed()).toEqual([...PATHS]));
    expect(
      hideViewedValue(),
    ).toBe(false);
  } finally {
    await screen.unmount();
  }
});

it('says what Hide viewed hid when it hid every file, instead of an empty list', async () => {
  const screen = await renderReview(undefined, ['viewed', 'viewed', 'viewed']);
  const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
  const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
  const listed = () => screen.findAllByType(DiffFilesListView)[0]?.props.files.map((file: { key: string }) => file.key) ?? [];
  try {
    await screen.pressByTestIdAsync('review-detail:tab:changes');
    await vi.waitFor(() => expect(screen.findAllByType(WorkspaceScmReviewBody)).toHaveLength(1), { timeout: 10_000 });
    await act(async () => {
      screen.findAllByType(WorkspaceScmReviewBody)[0]?.findAll((node) => typeof node.props.onLayout === 'function')[0]
        ?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scm-file-viewed-fact')).not.toBeNull(), { timeout: 10_000 });
    await screen.pressByTestIdAsync('review-changes:hide-viewed');
    await vi.waitFor(() => expect(listed()).toEqual([]));
    expect(screen.findAllByTestId('scm-review-viewed-hidden').length).toBeGreaterThan(0);
    expect(screen.findByTestId('changed-files-review-empty')).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it('draws no empty second line for a reviewers group with nobody to name', async () => {
  const screen = await renderReview();
  const { Item } = await import('@/components/ui/lists/Item');
  try {
    await vi.waitFor(() => expect(screen.findAllByType(Item)
      .some((item) => item.props.testID === 'review-detail:group:reviewers')).toBe(true));
    const reviewers = screen.findAllByType(Item).find((item) => item.props.testID === 'review-detail:group:reviewers');
    // Reviewer ids carry no labels yet, so the group has no participants and no bottom line.
    expect(reviewers?.props.bottomElement).toBeUndefined();
  } finally {
    await screen.unmount();
  }
});
