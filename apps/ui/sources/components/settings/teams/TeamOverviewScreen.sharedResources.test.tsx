import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import type { TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { act } from 'react-test-renderer';

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

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

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
const { TeamOverviewScreen } = await import('./TeamOverviewScreen');
const { publishHomeAccountChange } =
  await import('@/sync/runtime/orchestration/homeAccountChange');

const SUMMARY = bindHomeDomainActionHttpRequestV1(
  TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
  { v: 1, teamId: 'team-1' },
);

async function addHome(
  kinds: readonly TeamSharedResourceSummaryRowV1[],
): Promise<string> {
  const serverId = await harness.addHome({
    name: 'Home A',
    serverUrl: 'https://shared-resources.example',
    accountId: 'account-ada',
    teamsEnabled: true,
  });
  await harness.selectHomes([serverId]);
  harness.answer(serverId, '/v1/teams/get', {
    body: teamSummaryFixture({
      capabilities: teamCapabilitiesFixture({ manageMembers: true }),
    }),
  });
  harness.answer(serverId, SUMMARY.path, { body: { teamId: 'team-1', kinds } });
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

describe('Team overview: Shared with this Team', () => {
  it('commits the Team header and observed shared rows on the first return from Team Settings', async () => {
    const serverId = await addHome([{ kind: 'machines', status: 'available', count: 2 }]);
    const { TeamSettingsScreen } = await import('./TeamSettingsScreen');
    const overview = () => <TeamOverviewScreen serverId={serverId} teamId="team-1" />;
    const screen = await renderScreen(overview());
    const sharedRow = 'team-overview-shared:machines';
    await vi.waitFor(() => expect(ids(screen)).toContain(sharedRow));

    await screen.update(<TeamSettingsScreen serverId={serverId} teamId="team-1" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-settings-name-fact'));

    const committedIds: string[][] = [];
    await screen.update(<React.Profiler id="teams-return" onRender={() => committedIds.push(ids(screen))}>
      {overview()}
    </React.Profiler>);
    expect(committedIds[0]).toEqual(expect.arrayContaining(['team-overview-identity', sharedRow]));
    expect(committedIds.flat()).not.toContain('team-loading');
    await screen.unmount();
  });

  it('lists each shared kind once with its count, opens each kind list, and reads no resource pages', async () => {
    const serverId = await addHome([
      { kind: 'credentials', status: 'available', count: 4 },
      { kind: 'machines', status: 'available', count: 2 },
      { kind: 'sessions', status: 'available', count: 23 },
      { kind: 'savedSecrets', status: 'available', count: 0 },
    ]);
    const screen = await renderScreen(
      <TeamOverviewScreen serverId={serverId} teamId="team-1" />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain('team-overview-shared:sessions'),
    );

    const listed = ids(screen).filter((id) =>
      id.startsWith('team-overview-shared:'),
    );
    // Lab order (people first, credentials last); a kind nobody shared is not listed.
    expect(listed).toEqual([
      'team-overview-shared:sessions',
      'team-overview-shared:machines',
      'team-overview-shared:credentials',
    ]);
    // The retired inventories are gone: nothing is listed twice.
    expect(
      ids(screen).filter(
        (id) =>
          id.startsWith('team-overview-session') ||
          id.startsWith('team-overview-workflow') ||
          id === 'team-overview-credentials',
      ),
    ).toEqual([]);

    screen.pressByTestId('team-overview-shared:sessions');
    expect(routerPush).toHaveBeenLastCalledWith(
      `/teams/team-1/sessions?serverId=${encodeURIComponent(serverId)}`,
    );
    screen.pressByTestId('team-overview-shared:credentials');
    expect(routerPush).toHaveBeenLastCalledWith(
      `/settings/teams/${serverId}/team-1/credentials`,
    );
    // Every other kind opens its own Team-filtered list.
    screen.pressByTestId('team-overview-shared:machines');
    expect(routerPush).toHaveBeenLastCalledWith(`/settings/teams/${serverId}/team-1/shared?kind=machines`);

    expect(harness.requestsFor(SUMMARY.path)).toHaveLength(1);
    expect(
      harness.requests.filter(
        (row) =>
          row.path.includes('/projects/sources') ||
          row.path.includes('/artifacts') ||
          row.path.includes('/machines') ||
          row.path.includes('/credential-resources'),
      ),
    ).toEqual([]);
  });

  it('says a kind could not be counted rather than showing zero, and Retry asks again', async () => {
    const serverId = await addHome([
      {
        kind: 'machines',
        status: 'unavailable',
        count: null,
        reason: 'team_authentication_required',
      },
      { kind: 'projectSources', status: 'available', count: 3 },
    ]);
    const screen = await renderScreen(
      <TeamOverviewScreen serverId={serverId} teamId="team-1" />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain('team-overview-shared-retry:machines'),
    );
    expect(ids(screen)).not.toContain('team-overview-shared-empty');

    screen.pressByTestId('team-overview-shared-retry:machines');
    await vi.waitFor(() =>
      expect(harness.requestsFor(SUMMARY.path)).toHaveLength(2),
    );
  });

  it('invites sharing when nothing has been shared with the Team', async () => {
    const serverId = await addHome([
      { kind: 'sessions', status: 'available', count: 0 },
      { kind: 'credentials', status: 'available', count: 0 },
    ]);
    const screen = await renderScreen(
      <TeamOverviewScreen serverId={serverId} teamId="team-1" />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain('team-overview-shared-empty'),
    );
    expect(
      ids(screen).filter((id) => id.startsWith('team-overview-shared:')),
    ).toEqual([]);
  });

  it('keeps the last-known invitation to share while a refresh runs', async () => {
    const serverId = await addHome([
      { kind: 'sessions', status: 'available', count: 0 },
    ]);
    const screen = await renderScreen(
      <TeamOverviewScreen serverId={serverId} teamId="team-1" />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain('team-overview-shared-empty'),
    );
    harness.answer(serverId, SUMMARY.path, {
      body: { teamId: 'team-1', kinds: [] },
      respondAfter: new Promise<void>(() => {}),
    });
    await act(async () => {
      publishHomeAccountChange(serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]);
    });
    await vi.waitFor(() =>
      expect(harness.requestsFor(SUMMARY.path)).toHaveLength(2),
    );
    // A refresh never blanks the section under its title (TH-VISUAL-ACCEPT-15).
    expect(ids(screen)).toContain('team-overview-shared-empty');
  });
});
