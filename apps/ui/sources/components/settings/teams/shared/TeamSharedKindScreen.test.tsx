import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachinePoolPrivateViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';

import {
  collectRenderedTestIds,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({
  storage: 'real',
  router: async () => ({
    useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
    useNavigation: () => ({ setOptions: vi.fn() }),
    useLocalSearchParams: () => ({}),
  }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetTeamsSnapshotsForTests } =
  await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } =
  await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } =
  await import('@/sync/ops/teams/teamActionClient');
const { TeamSharedKindScreen } = await import('./TeamSharedKindScreen');

const POOLS = machinePoolActionEndpointPathV1('machines.pools.list');
const POOL_ID = '00000000-0000-4000-8000-000000000002';

function sharedPool(name: string): MachinePoolPrivateViewV1 {
  return {
    sharedWithTeamScope: 'group',
    pool: {
      id: POOL_ID,
      description: null,
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      members: [],
      audience: { kind: 'team', teamId: 'team-1' },
      name: {
        kind: 'available',
        label: { content: { t: 'plain', v: name }, recipientEnvelope: null },
      },
    },
    availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
  };
}

async function addHome(
  pools: readonly MachinePoolPrivateViewV1[],
): Promise<string> {
  const serverId = await harness.addHome({
    name: 'Home A',
    serverUrl: 'https://shared-kind.example',
    accountId: 'account-ada',
    teamsEnabled: true,
    machinePoolsEnabled: true,
  });
  await harness.selectHomes([serverId]);
  harness.answer(serverId, '/v1/teams/get', {
    body: teamSummaryFixture({
      capabilities: teamCapabilitiesFixture({ viewRoster: true }),
    }),
  });
  harness.answer(serverId, POOLS, { body: { pools } });
  return serverId;
}

const ids = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  collectRenderedTestIds(screen.tree.toJSON());

beforeEach(async () => {
  resetTeamsSnapshotsForTests();
  resetTeamsDirectoryEngineForTests();
  resetTeamActionClientForTests();
  await harness.reset();
  await harness.selectHomes([]);
  routerPush.mockReset();
});
afterEach(() => {
  standardCleanup();
});

describe('Team shared kind list', () => {
  it('lists the kind through its own Team-filtered list Action and opens each record at its owner', async () => {
    const serverId = await addHome([sharedPool('Build farm')]);
    const screen = await renderScreen(
      <TeamSharedKindScreen
        serverId={serverId}
        teamId="team-1"
        kind="machinePools"
      />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain(`team-shared-kind-row:${POOL_ID}`),
    );
    expect(harness.requestsFor(POOLS).map((request) => request.input)).toEqual([
      { sharedWithTeamId: 'team-1' },
    ]);
    screen.pressByTestId(`team-shared-kind-row:${POOL_ID}`);
    expect(routerPush).toHaveBeenLastCalledWith(
      expect.stringContaining(`/pools/${POOL_ID}?serverId=`),
    );
  });

  it('says once when nothing of the kind is shared', async () => {
    const serverId = await addHome([]);
    const screen = await renderScreen(
      <TeamSharedKindScreen
        serverId={serverId}
        teamId="team-1"
        kind="machinePools"
      />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain('team-shared-kind-empty'),
    );
    expect(
      ids(screen).filter((id) => id.startsWith('team-shared-kind-row:')),
    ).toEqual([]);
  });
});
