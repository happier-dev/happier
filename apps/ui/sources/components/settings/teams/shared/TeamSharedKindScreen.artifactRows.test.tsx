import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';

import {
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
installSettingsViewCommonModuleMocks({
  storage: 'real',
  router: async () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
    useNavigation: () => ({ setOptions: vi.fn() }),
    useLocalSearchParams: () => ({}),
  }),
});

// The Home (its HTTP routes) is the boundary; the Team list, the Artifact and Review list owners stay real.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
const { resetTeamsSnapshotsForTests } =
  await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamActionClientForTests } =
  await import('@/sync/ops/teams/teamActionClient');
const { TeamSharedKindScreen } = await import('./TeamSharedKindScreen');
const { t } = await import('@/text');
const { formatShortRelativeTimeAt } = await import('@/utils/time/formatShortRelativeTime');

const NOW = Date.UTC(2026, 10, 21, 12);

async function addHome(): Promise<string> {
  const serverId = await harness.addHome({
    name: 'Home A',
    serverUrl: 'https://shared-rows.example',
    accountId: 'account-ada',
    currentAccount: true,
    teamsEnabled: true,
  });
  await harness.selectHomes([serverId]);
  harness.answer(serverId, '/v1/teams/get', {
    body: teamSummaryFixture({
      capabilities: teamCapabilitiesFixture({ viewRoster: true }),
    }),
  });
  return serverId;
}

function answerArtifacts(
  serverId: string,
  header: Record<string, unknown>,
  id: string,
) {
  harness.answer(serverId, '/v1/artifacts', {
    body: {
      items: [
        createPlainArtifactHttpFixture(
          {
            id,
            title: null,
            header: { ...header, title: null },
            rawHeader: header,
            isDecrypted: true,
            headerVersion: 1,
            bodyVersion: 1,
            seq: 1,
            createdAt: NOW - 2 * 60 * 60 * 1000,
            updatedAt: NOW,
          },
          'account-ada',
        ),
      ],
      hasUnclassified: false,
      coverage: { status: 'complete', unclassifiedCount: 0 },
    },
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  resetTeamsSnapshotsForTests();
  resetTeamActionClientForTests();
  await harness.reset();
  await harness.selectHomes([]);
});
afterEach(() => {
  standardCleanup();
  vi.useRealTimers();
});

describe('Team shared Artifact rows', () => {
  it('names a shared workflow by its authored title', async () => {
    const serverId = await addHome();
    answerArtifacts(
      serverId,
      {
        kind: 'workflow-definition.v1',
        definitionId: 'wf-1',
        revision: 1,
        metadata: { title: 'Repository correctness Hunt' },
      },
      'wf-1',
    );
    const screen = await renderScreen(
      <TeamSharedKindScreen
        serverId={serverId}
        teamId="team-1"
        kind="workflows"
      />,
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('Repository correctness Hunt'),
    );
    expect(screen.getTextContent()).not.toContain(
      t('teams.overview.shared.untitled'),
    );
  });

  it('reads a shared Review row as the Reviews collection does: its fact and its age', async () => {
    const serverId = await addHome();
    const reviewId = 'review-1';
    answerArtifacts(
      serverId,
      {
        kind: REVIEW_ARTIFACT_KIND_V1,
        v: 1,
        reviewId,
        title: 'Relay handshake',
      },
      reviewId,
    );
    harness.answer(serverId, 'POST /v1/reviews/list', {
      body: {
        items: [
          {
            reviewId,
            projectSourceId: null,
            workflowId: null,
            subjectKind: 'repository',
            sourceKind: 'direct',
            state: 'completed',
            currentRoundOrdinal: 1,
            startedAt: 1,
            finishedAt: 2,
            createdAt: NOW - 2 * 60 * 60 * 1000,
            updatedAt: NOW,
            counts: { total: 3, needsDecision: 2 },
            needsYou: {
              reviewId,
              roundOrdinal: 1,
              reason: 'review_needs_you',
              needsYou: true,
              requestedVerdict: false,
              pendingDecisions: true,
              canSubmitVerdict: false,
            },
          },
        ],
        cursor: null,
      },
    });
    const screen = await renderScreen(
      <TeamSharedKindScreen
        serverId={serverId}
        teamId="team-1"
        kind="reviews"
      />,
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('Relay handshake'),
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain(
        t('reviewWalkthrough.detail.glanceToDecide', { count: 2 }),
      ),
    );
    expect(screen.getTextContent()).toContain(formatShortRelativeTimeAt(NOW - 2 * 60 * 60 * 1000, NOW));
    expect(
      harness.requestsFor('/v1/reviews/list').map((request) => request.input),
    ).toContainEqual(expect.objectContaining({ sharedWithTeamId: 'team-1' }));
  });
});
