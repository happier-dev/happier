import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import type { TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { act } from 'react-test-renderer';

import {
  collectRenderedTestIds,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamGroupFixture,
  teamMembershipFixture,
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

// Whether a side pane fits is a device fact (phone or panes off); each case chooses the layout it describes.
const detailsPane = vi.hoisted(() => ({ available: false }));
vi.mock('@/components/appShell/panes/details/detailsPaneAvailability', () => ({
  useDetailsPaneAvailable: () => detailsPane.available,
}));

// Keep the actual tab lifecycles and render native virtualized rows without a measured viewport.
vi.mock('@legendapp/list/react-native', async () => {
  const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
  return createLegendListModuleMock({ renderItemLimit: 8 });
});

vi.mock('@react-navigation/native', async () => {
  const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
  return createReactNavigationNativeMock();
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
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
/** The overview opens shared kinds in the app's details pane, so it mounts inside the app's pane provider. */
function InPanes(props: React.ComponentProps<typeof TeamOverviewScreen>) {
  return <AppPaneProvider><TeamOverviewScreen {...props} /></AppPaneProvider>;
}
const { t } = await import('@/text');
const { publishHomeAccountChange } =
  await import('@/sync/runtime/orchestration/homeAccountChange');

const SUMMARY = bindHomeDomainActionHttpRequestV1(
  TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
  { v: 1, teamId: 'team-1' },
);

async function addHome(
  kinds: readonly TeamSharedResourceSummaryRowV1[],
  serverIdentityId?: string,
): Promise<string> {
  const serverId = await harness.addHome({
    name: 'Home A',
    serverUrl: serverIdentityId ? `https://${serverIdentityId.replaceAll('_', '-')}.example` : 'https://shared-resources.example',
    accountId: 'account-ada',
    teamsEnabled: true,
    ...(serverIdentityId ? { serverIdentityId } : {}),
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
  detailsPane.available = false;
});
afterEach(() => {
  standardCleanup();
});

describe('Team overview: Shared with this Team', () => {
  it('commits the Team header and observed shared rows on the first return from Team Settings', async () => {
    const serverId = await addHome([{ kind: 'machines', status: 'available', count: 2 }]);
    const { TeamSettingsScreen } = await import('./TeamSettingsScreen');
    const overview = () => <InPanes serverId={serverId} teamId="team-1" />;
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

  it('opens each Team tab once, reopens Overview without a read, and refreshes it on a Team wake', async () => {
    const serverId = await addHome([{ kind: 'machines', status: 'available', count: 2 }]);
    const { TeamMembersScreen } = await import('./members/TeamMembersScreen');
    const { TeamGroupsScreen } = await import('./groups/TeamGroupsScreen');
    const { NavigationContext, useNavigation } = await import('@react-navigation/native');
    function NativeRoute({ children }: React.PropsWithChildren) {
      return <NavigationContext.Provider value={useNavigation()}>{children}</NavigationContext.Provider>;
    }
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({
      capabilities: teamCapabilitiesFixture({ viewRoster: true, manageMembers: true, manageGroups: true }),
    }) });
    const roster = '/v1/teams/members/list';
    const groups = '/v1/teams/groups/list';
    harness.answer(serverId, roster, { body: { items: [teamMembershipFixture()], nextCursor: null } });
    harness.answer(serverId, groups, { body: { items: [teamGroupFixture()], nextCursor: null } });
    const overview = <InPanes serverId={serverId} teamId="team-1" />;
    const screen = await renderScreen(overview, { wrapper: NativeRoute });
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-shared:machines'));
    await screen.update(<TeamMembersScreen serverId={serverId} teamId="team-1" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-members-row:membership-1'));
    await screen.update(<TeamGroupsScreen serverId={serverId} teamId="team-1" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-groups-row:group-1'));
    const requestsBeforeReturn = harness.requests.length;
    await screen.update(overview);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-shared:machines'));
    expect(harness.requests.slice(requestsBeforeReturn)).toEqual([]);
    for (const path of ['/v1/teams/get', roster, groups, SUMMARY.path]) {
      expect(harness.requestsFor(path)).toHaveLength(1);
    }
    harness.answer(serverId, SUMMARY.path, {
      body: { teamId: 'team-1', kinds: [{ kind: 'sessions', status: 'available', count: 3 }] },
    });
    await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-shared:sessions'));
    expect(ids(screen)).not.toContain('team-overview-shared:machines');
    expect(harness.requestsFor(SUMMARY.path)).toHaveLength(2);
    expect(harness.requestsFor(roster)).toHaveLength(1);
    expect(harness.requestsFor(groups)).toHaveLength(1);
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
      <InPanes serverId={serverId} teamId="team-1" />,
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

  it('opens a kind list beside the overview where a pane fits, named with its count, and keeps shipped pages pushed', async () => {
    detailsPane.available = true;
    const serverId = await addHome([
      { kind: 'machines', status: 'available', count: 2 },
      { kind: 'projectSources', status: 'available', count: 3 },
      { kind: 'sessions', status: 'available', count: 23 },
    ]);
    const screen = await renderScreen(
      <InPanes serverId={serverId} teamId="team-1" />,
    );
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-shared:machines'));

    screen.pressByTestId('team-overview-shared:machines');
    await vi.waitFor(() => expect(ids(screen)).toContain('team-shared-kind-list'));
    // The overview stays; the list stands beside it instead of replacing it.
    expect(routerPush).not.toHaveBeenCalled();
    expect(ids(screen)).toContain('team-overview-identity');
    expect(screen.findByTestId('team-overview-shared-pane.header.title')?.props.children)
      .toBe(t('teams.overview.shared.kinds.machines'));
    expect(screen.getTextContent()).toContain(t('teams.overview.summary.credentialsShared', { count: 2 }));

    // Machines share from each Machine's own Share menu, so their list offers no "Share a …"; Sources start at the
    // existing Sources page.
    expect(ids(screen)).not.toContain('team-overview-shared-pane-share');
    screen.pressByTestId('team-overview-shared:projectSources');
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-shared-pane-share'));
    screen.pressByTestId('team-overview-shared-pane-share');
    expect(routerPush).toHaveBeenLastCalledWith('/projects/sources');

    // Sessions keep their shipped Team page.
    screen.pressByTestId('team-overview-shared:sessions');
    expect(routerPush).toHaveBeenLastCalledWith(`/teams/team-1/sessions?serverId=${encodeURIComponent(serverId)}`);
    await screen.unmount();
  });

  it.each([
    { code: 'team_authentication_required', status: 403, message: 'session.access.authenticationRequired', signIn: true },
    { code: 'team_authentication_unavailable', status: 503, message: 'teams.credentials.externalApi.authenticationUnavailable', signIn: false },
  ] as const)('presents a shared Preset refusal $code once across the overview and pane', async ({ code, status, message, signIn }) => {
    detailsPane.available = true;
    const serverId = await addHome([{ kind: 'machinePresets', status: 'available', count: 1 }], `srv_shared_overview_${status}`);
    const overview = () => <InPanes serverId={serverId} teamId="team-1" />;
    const row = 'team-overview-shared:machinePresets';
    const previous = await renderScreen(overview());
    await vi.waitFor(() => expect(ids(previous)).toContain(row));
    await previous.unmount();

    let answerSummary!: () => void;
    harness.answer(serverId, SUMMARY.path, {
      body: { teamId: 'team-1', kinds: [{ kind: 'machinePresets', status: 'unavailable', count: null, reason: code }] },
      respondAfter: new Promise<void>((resolve) => { answerSummary = resolve; }),
    });
    await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
    const presetPath = '/v1/machines/presets/list';
    harness.answer(serverId, presetPath, { status, body: { kind: 'refused', code } });
    const screen = await renderScreen(overview());
    await vi.waitFor(() => expect(ids(screen)).toContain(row));
    await screen.pressByTestIdAsync(row);
    await vi.waitFor(() => expect(harness.requestsFor(presetPath)).toHaveLength(1));
    await vi.waitFor(() => expect(ids(screen)).toContain('team-shared-kind-failed'));

    await act(async () => { answerSummary(); });
    await vi.waitFor(() => {
      expect(ids(screen)).not.toContain('team-shared-kind-empty');
      expect(screen.findByTestId(row)?.props.accessibilityLabel).toContain(t(message));
    });
    expect(screen.getTextContent().split(t(message))).toHaveLength(2);
    expect(ids(screen)).not.toContain('team-shared-kind-failed-retry');
    expect(ids(screen).includes(`${row}-sign-in`)).toBe(signIn);
    expect(ids(screen)).not.toContain('team-shared-kind-failed-sign-in');
  });

  it.each([
    ['team_authentication_required', 'teams.credentials.errors.teamAuthenticationRequired', true],
    ['team_authentication_policy_unavailable', 'teams.credentials.errors.teamAuthenticationPolicyUnavailable', false],
  ] as const)('shows the credential summary refusal %s with its sign-in recovery', async (reason, message, signIn) => {
    const serverId = await addHome([
      {
        kind: 'credentials',
        status: 'unavailable',
        count: null,
        reason,
      },
      { kind: 'projectSources', status: 'available', count: 3 },
    ]);
    const screen = await renderScreen(
      <InPanes serverId={serverId} teamId="team-1" />,
    );
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t(message)));
    expect(ids(screen)).not.toContain('team-overview-shared-empty');
    expect(screen.findByTestId('team-overview-shared:credentials')?.props.accessibilityLabel).toContain(t(message));
    expect(ids(screen)).not.toContain('team-overview-shared-retry:credentials');
    expect(ids(screen)).not.toContain('team-overview-shared:credentials-retry');
    const action = 'team-overview-shared:credentials-sign-in';
    expect(ids(screen).includes(action)).toBe(signIn);
    if (signIn) {
      await screen.pressByTestIdAsync(action);
      const destination = new URL(String(routerPush.mock.lastCall?.[0]), 'https://happier.test');
      expect(destination.pathname).toBe('/teams/team-1/sign-in');
      expect(destination.searchParams.get('serverId')).toBe(serverId);
    }
    expect(harness.requestsFor(SUMMARY.path)).toHaveLength(1);
  });

  it('invites sharing when nothing has been shared with the Team', async () => {
    const serverId = await addHome([
      { kind: 'sessions', status: 'available', count: 0 },
      { kind: 'credentials', status: 'available', count: 0 },
    ]);
    const screen = await renderScreen(
      <InPanes serverId={serverId} teamId="team-1" />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain('team-overview-shared-empty'),
    );
    expect(
      ids(screen).filter((id) => id.startsWith('team-overview-shared:')),
    ).toEqual([]);
  });

  it('draws the Team section from the Team at once and holds the never-seen shared section at the empty card\'s shape', async () => {
    const serverId = await addHome([]);
    let answerSummary!: () => void;
    harness.answer(serverId, SUMMARY.path, {
      body: { teamId: 'team-1', kinds: [] },
      respondAfter: new Promise<void>((resolve) => { answerSummary = resolve; }),
    });
    const screen = await renderScreen(<InPanes serverId={serverId} teamId="team-1" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-identity'));
    // The Team's own rows come from the Team: they never wait on the summary.
    expect(ids(screen)).toEqual(expect.arrayContaining(['team-overview-members', 'team-overview-groups']));
    // Never seen: the section stands in the empty card's own row, unseen, so the card it becomes is the same box.
    const reserve = screen.tree.root.findByProps({ testID: 'team-overview-shared-reserve' });
    const heldRow = reserve.findByProps({ testID: 'team-overview-shared-empty' });
    expect(heldRow.props.title).toBe(t('teams.overview.shared.emptyTitle', { team: teamSummaryFixture().name }));
    expect(heldRow.props.subtitle).toBe(t('teams.overview.shared.emptyBody'));
    expect(reserve.props.accessibilityElementsHidden).toBe(true);

    await act(async () => { answerSummary(); });
    await vi.waitFor(() => expect(ids(screen)).not.toContain('team-overview-shared-reserve'));
    expect(ids(screen)).toContain('team-overview-shared-empty');
  });

  it('holds the Team identity while the Team is read, and lets the shared rows arrive above nothing on screen', async () => {
    const serverId = await addHome([
      { kind: 'machines', status: 'available', count: 2 },
      { kind: 'sessions', status: 'available', count: 5 },
    ]);
    let answerTeam!: () => void;
    let answerSummary!: () => void;
    harness.answer(serverId, '/v1/teams/get', {
      body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
      respondAfter: new Promise<void>((resolve) => { answerTeam = resolve; }),
    });
    harness.answer(serverId, SUMMARY.path, {
      body: { teamId: 'team-1', kinds: [{ kind: 'machines', status: 'available', count: 2 }, { kind: 'sessions', status: 'available', count: 5 }] },
      respondAfter: new Promise<void>((resolve) => { answerSummary = resolve; }),
    });
    const screen = await renderScreen(<InPanes serverId={serverId} teamId="team-1" />);
    const reserved = () => ids(screen).filter((id) => /-skeleton:\d+$/.test(id));

    // The Team is not known yet: its identity holds the header, and no section below it is guessed.
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-identity-loading'));
    expect(ids(screen)).not.toContain('team-page-header');
    expect(reserved()).toEqual([]);

    // The Team answered: the shared section holds its never-seen shape, and the Team section is drawn under it.
    await act(async () => { answerTeam(); });
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-identity'));
    expect(reserved()).toEqual(['team-overview-shared-loading-skeleton:0']);
    expect(ids(screen)).toContain('team-overview-shared-reserve');
    expect(ids(screen)).toContain('team-overview-members');

    await act(async () => { answerSummary(); });
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-shared:sessions'));
    expect(ids(screen)).toContain('team-overview-members');
    expect(reserved()).toEqual([]);
  });

  it('paints the held header whole from the Teams directory row the rail already holds', async () => {
    const serverId = await addHome([]);
    const { applyTeamsDirectoryPage } = await import('@/sync/store/teams/teamsSnapshots');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { teamDirectoryQueryKeyV1 } = await import('@happier-dev/protocol/teams');
    applyTeamsDirectoryPage({
      scope: createServerAccountScope(serverId, 'account-ada')!,
      queryKey: teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' }),
      items: [teamSummaryFixture({ name: 'Northwind Platform', viewerRole: 'owner' })],
      observedAt: 1,
    });
    harness.answer(serverId, '/v1/teams/get', {
      body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
      respondAfter: new Promise<void>(() => {}),
    });
    const screen = await renderScreen(<InPanes serverId={serverId} teamId="team-1" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-role'));
    // The row the rail draws is the Team's identity: no title bar, the name, its role and its Home at once.
    expect(ids(screen)).not.toContain('team-overview-identity-loading');
    expect(JSON.stringify(screen.tree.toJSON())).toContain('Northwind Platform');
    expect(ids(screen)).toContain('team-overview-home');
    expect(ids(screen)).toContain('team-loading');
  });

  it('holds a role-wide fact before the Home when no directory row is known, so the Home stands still', async () => {
    const serverId = await addHome([]);
    harness.answer(serverId, '/v1/teams/get', {
      body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
      respondAfter: new Promise<void>(() => {}),
    });
    const screen = await renderScreen(<InPanes serverId={serverId} teamId="team-1" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-identity-loading'));
    const order = ids(screen);
    expect(order).toContain('team-overview-role');
    expect(order.indexOf('team-overview-role')).toBeLessThan(order.indexOf('team-overview-home'));
  });

  it('keeps a member\'s Leave Team under the sections, drawn with them while the summary is read', async () => {
    const serverId = await addHome([]);
    let answerSummary!: () => void;
    harness.answer(serverId, '/v1/teams/get', {
      body: teamSummaryFixture({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({ leave: true }) }),
    });
    harness.answer(serverId, SUMMARY.path, {
      body: { teamId: 'team-1', kinds: [] },
      respondAfter: new Promise<void>((resolve) => { answerSummary = resolve; }),
    });
    const screen = await renderScreen(<InPanes serverId={serverId} teamId="team-1" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-identity'));
    const order = ids(screen);
    expect(order).toContain('team-overview-leave');
    expect(order.indexOf('team-overview-shared-reserve')).toBeLessThan(order.indexOf('team-overview-leave'));
    await act(async () => { answerSummary(); });
    await vi.waitFor(() => expect(ids(screen)).toContain('team-overview-shared-empty'));
    expect(ids(screen)).toContain('team-overview-leave');
  });

  it('keeps the last-known invitation to share while a refresh runs', async () => {
    const serverId = await addHome([
      { kind: 'sessions', status: 'available', count: 0 },
    ]);
    const screen = await renderScreen(
      <InPanes serverId={serverId} teamId="team-1" />,
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
