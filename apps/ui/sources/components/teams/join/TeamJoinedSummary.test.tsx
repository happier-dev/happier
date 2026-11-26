import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  renderScreen,
  standardCleanup,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

// Only Home HTTP is scripted; the Team binding, summary and Joined owners run as in production.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { TeamJoinedCard } = await import('./TeamJoinedCard');
const { TeamJoinedSummaryForTeam } = await import('./TeamJoinedSummary');
const { t } = await import('@/text');

beforeEach(async () => {
  await homes.reset();
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

const TEAM_ID = 'joined-cold-team';
const summaryPath = bindHomeDomainActionHttpRequestV1(
  TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
  { v: 1, teamId: TEAM_ID },
).path;

async function joinedHome(name: string) {
  onTestFinished(await installRealActionExecutorModuleLoader());
  const serverId = await homes.addHome({
    name: 'Joined Home',
    serverUrl: `https://${name}.example.test`,
    serverIdentityId: `srv_${name}`,
    accountId: 'member',
    currentAccount: true,
    teamsEnabled: true,
  });
  const scope = {
    serverId: resolveServerProfileScopeIdForIdentifier(serverId),
    accountId: 'member',
  };
  storage.getState().activateProfileScope(scope);
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  homes.answer(serverId, '/v1/projects/sources', {
    body: {
      ok: true,
      sources: [],
      coverage: { complete: true, nextCursor: null },
    },
  });
  return { serverId, scope };
}

/** The live Joined composition: the summary binds its Team while the name and both ways on stay the card's own. */
async function renderJoined(
  scope: Readonly<{ serverId: string; accountId: string }>,
) {
  const onOpenTeam = vi.fn();
  const onSetup = vi.fn();
  const screen = await renderScreen(
    <TeamJoinedCard
      testID="joined"
      result={{ outcome: 'already_member', teamId: TEAM_ID }}
      teamName="Product Reliability"
      accountScope={scope}
      onOpenTeam={onOpenTeam}
      setupContinuation={{
        label: 'Set up for Product Reliability',
        onContinue: onSetup,
      }}
      summary={
        <TeamJoinedSummaryForTeam
          testID="joined-resources"
          scope={scope}
          teamId={TEAM_ID}
        />
      }
    />,
  );
  return { screen, onOpenTeam, onSetup };
}

function expectWaysOnKept(screen: Awaited<ReturnType<typeof renderScreen>>) {
  expect(screen.findByTestId('joined-action')).not.toBeNull();
  expect(screen.findByTestId('joined-open-team')).not.toBeNull();
}

it('says a cold refused summary read in its own place, keeps both ways on, and holds that place through Retry', async () => {
  const { serverId, scope } = await joinedHome('joined-cold-summary');
  homes.answer(serverId, '/v1/teams/get', {
    body: teamSummaryFixture({
      id: TEAM_ID,
      policy: teamPolicyFixture({ managedDefaults: null }),
    }),
  });
  homes.answer(serverId, summaryPath, {
    status: 503,
    body: { error: 'service_unavailable' },
  });
  const { screen, onOpenTeam } = await renderJoined(scope);
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('joined-resources-failed'),
        screen.getTextContent(),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain(t('teams.join.summary.title'));
    expectWaysOnKept(screen);

    let release!: () => void;
    const respondAfter = new Promise<void>((resolve) => {
      release = resolve;
    });
    homes.answer(serverId, summaryPath, {
      respondAfter,
      body: {
        teamId: TEAM_ID,
        kinds: [{ kind: 'sessions', status: 'available', count: 2 }],
      },
    });
    const reads = homes.requestsFor(summaryPath).length;
    await screen.pressByTestIdAsync('joined-resources-failed-retry');
    await waitForHomeGovernance(() =>
      expect(homes.requestsFor(summaryPath)).toHaveLength(reads + 1),
    );
    // The retried read is still out: the failure keeps its place rather than leaving a gap.
    expect(screen.findByTestId('joined-resources-failed')).not.toBeNull();
    release();
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain(
        t('teams.join.summary.sessions', { count: 2 }),
      ),
    );
    expect(screen.findByTestId('joined-resources-failed')).toBeNull();

    await screen.pressByTestIdAsync('joined-open-team');
    await waitForHomeGovernance(() =>
      expect(onOpenTeam).toHaveBeenCalledOnce(),
    );
  } finally {
    await screen.unmount();
  }
});

it('says a cold refused Team read with the owner’s settled answer and keeps both ways on', async () => {
  const { serverId, scope } = await joinedHome('joined-cold-team');
  homes.answer(serverId, '/v1/teams/get', {
    status: 403,
    body: { error: 'forbidden' },
  });
  const { screen } = await renderJoined(scope);
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('joined-resources-failed'),
        screen.getTextContent(),
      ).not.toBeNull(),
    );
    // A settled refusal is not offered a Retry that would ask the same question again.
    expect(screen.findByTestId('joined-resources-failed-retry')).toBeNull();
    expect(homes.requestsFor(summaryPath)).toHaveLength(0);
    expectWaysOnKept(screen);
  } finally {
    await screen.unmount();
  }
});

it('says the setup belongs to the Account that joined when another one is active, without reading for it', async () => {
  const { scope } = await joinedHome('joined-other-account');
  const joinedScope = { ...scope, accountId: 'joined-elsewhere' };
  const { screen } = await renderJoined(joinedScope);
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('joined-resources-other-account'),
        screen.getTextContent(),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain(
      t('teams.join.setupPage.otherAccount'),
    );
    expect(homes.requestsFor('/v1/teams/get')).toHaveLength(0);
    expect(homes.requestsFor(summaryPath)).toHaveLength(0);
    expectWaysOnKept(screen);
  } finally {
    await screen.unmount();
  }
});
