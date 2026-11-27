import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { TEAM_GROUPS_PAGE_LIMIT_DEFAULT_V1 } from '@happier-dev/protocol/teams';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamCapabilitiesFixture, teamGroupFixture, teamSummaryFixture } from '@/dev/testkit';
import { expectHomePageReadCosts } from '@/dev/testkit/harness/expectHomePageReadCosts';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const virtualizedBoundary = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
    mountLimit: Number.POSITIVE_INFINITY,
}));

// Native recycling is the boundary; keep the app's list normalization and adapters real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({
        get renderItemLimit() { return virtualizedBoundary.mountLimit; },
        onCommit: props => { virtualizedBoundary.props = props; },
    });
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    // The Actions policy a person sets lives in the real store.
    storage: 'real',
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load the real screen after its boundaries are installed, outside any case's deadline.
const { TeamGroupsScreen } = await import('./TeamGroupsScreen');
const { Item } = await import('@/components/ui/lists/Item');

const TEAM_GET_PATH = '/v1/teams/get';
const GROUPS_LIST_PATH = '/v1/teams/groups/list';

async function renderGroups(serverId: string) {
    return renderScreen(<TeamGroupsScreen serverId={serverId} teamId="team-1" />);
}

async function addManagedHome(archivedGroups = 1, groups = 1): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageGroups: true }),
            counts: { members: 1, suspendedMembers: 0, groups, archivedGroups, waitingInvitations: 0 },
        }),
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderGroups>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
    virtualizedBoundary.props = null;
    virtualizedBoundary.mountLimit = Number.POSITIVE_INFINITY;
});

afterEach(() => {
    standardCleanup();
});

describe('TeamGroupsScreen', () => {
    it('reads one Team and the active Groups sequence on cold open and zero on return', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: null },
        });
        const page = <TeamGroupsScreen serverId={serverId} teamId="team-1" />;
        const reads = { [TEAM_GET_PATH]: 1, [GROUPS_LIST_PATH]: 1 };
        await expectHomePageReadCosts({
            home: harness, mount: () => renderGroups(serverId), leave: <></>, returnTo: page,
            settled: screen => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-groups-row:group-1'),
            cold: reads, returning: { [TEAM_GET_PATH]: 0, [GROUPS_LIST_PATH]: 0 },
        });
    });

    it('offers the archived sequence only when the Team summary reports archived Groups', async () => {
        const serverId = await addManagedHome(0);
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: null },
        });
        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-row:group-1');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-groups-toggle-archived');
    });

    it.each([
        { groups: 2, reserved: 2 },
        { groups: 0, reserved: 0 },
        { groups: null, reserved: 0 },
    ])('reserves as many Group rows as the Team summary counts ($groups) while they are read', async ({ groups, reserved }) => {
        const serverId = await addManagedHome(0);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({
                capabilities: teamCapabilitiesFixture({ manageGroups: true }),
                counts: { members: 1, suspendedMembers: 0, groups, archivedGroups: 0, waitingInvitations: 0 },
            }),
        });
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [], nextCursor: null },
            respondAfter: new Promise<void>(() => {}),
        });
        const screen = await renderGroups(serverId);
        await vi.waitFor(() => expect(harness.requestsFor(GROUPS_LIST_PATH).length).toBeGreaterThan(0));
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.filter((id) => /^team-groups-loading-skeleton:\d+$/.test(id))).toHaveLength(reserved);
        // A Team that has no Groups says so at once, instead of reserving rows that never arrive.
        if (groups === 0) expect(ids).toContain('team-groups-empty');
        else expect(ids).not.toContain('team-groups-empty');
    });

    it('shows the summary count before loading any archived Group rows', async () => {
        const serverId = await addManagedHome(3);
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: null },
        });
        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-toggle-archived');
        expect(screen.getTextContent()).toContain('teams.directory.showArchived · 3');
        expect(harness.requestsFor(GROUPS_LIST_PATH)
            .some((call) => (call.input as { archived?: string }).archived === 'archived')).toBe(false);
    });

    it('bounds a full Groups page and updates only the affected mounted row on a Team change', async () => {
        virtualizedBoundary.mountLimit = 2;
        const serverId = await addManagedHome(1, TEAM_GROUPS_PAGE_LIMIT_DEFAULT_V1);
        const items = Array.from({ length: TEAM_GROUPS_PAGE_LIMIT_DEFAULT_V1 }, (_, index) => teamGroupFixture({
            id: `group-${index}`,
            name: `Group ${String(index).padStart(2, '0')}`,
        }));
        harness.answer(serverId, GROUPS_LIST_PATH, { body: { items, nextCursor: null } });

        const screen = await renderGroups(serverId);
        const mountedRows = () => new Map(screen.findAllByType(Item)
            .filter(node => node.props.testID?.startsWith('team-groups-row:'))
            .map(node => [node.props.testID, node.props] as const));
        const changedId = 'team-groups-row:group-0';
        await vi.waitFor(() => expect(mountedRows().get(changedId)?.title).toBe('Group 00'));

        expect(virtualizedBoundary.props?.['data-testid']).toBe('team-groups-virtualized-list');
        expect(virtualizedBoundary.props?.maintainVisibleContentPosition).toBe(true);
        const baseline = mountedRows();
        expect(baseline.size).toBe(24);
        expect(baseline.has('team-groups-row:group-24')).toBe(false);

        const next = items.map((row, index) => index === 0 ? { ...row, memberCount: 2 } : row);
        harness.answer(serverId, GROUPS_LIST_PATH, { body: { items: next, nextCursor: null } });
        await React.act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await vi.waitFor(() => expect(mountedRows().get(changedId)?.subtitle).toBe('teams.groups.memberCount(count=2)'));
        const updated = mountedRows();
        expect(updated.size).toBe(baseline.size);
        expect([...updated].filter(([id, props]) => props !== baseline.get(id)).map(([id]) => id)).toEqual([changedId]);
        expect(harness.requestsFor(GROUPS_LIST_PATH)).toHaveLength(2);
    });

    it('asks its own Home for active Groups and opens one by its exact address', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: null },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-row:group-1');

        const listCalls = harness.requestsFor(GROUPS_LIST_PATH);
        expect(listCalls.every((call) => call.serverId === serverId)).toBe(true);
        // The archived sequence is a separate query; nothing asks for it until
        // the viewer opens that section.
        expect(listCalls.every((call) => (call.input as { archived?: string }).archived === 'active')).toBe(true);

        screen.pressByTestId('team-groups-row:group-1');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/groups/group-1`);
    });

    it('reads archived Groups only once that section is opened', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: null },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-toggle-archived');
        expect(harness.requestsFor(GROUPS_LIST_PATH)
            .some((call) => (call.input as { archived?: string }).archived === 'archived')).toBe(false);

        screen.pressByTestId('team-groups-toggle-archived');
        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUPS_LIST_PATH)
                .some((call) => (call.input as { archived?: string }).archived === 'archived')).toBe(true);
        });
    });

    it('shows loading and empty states for the independently opened archived sequence', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: null },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-toggle-archived');

        let releaseArchived!: () => void;
        const archivedGate = new Promise<void>((resolve) => {
            releaseArchived = resolve;
        });
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [], nextCursor: null },
            respondAfter: archivedGate,
        });

        screen.pressByTestId('team-groups-toggle-archived');
        await waitForTestId(screen, 'team-groups-archived-loading');

        releaseArchived();
        await waitForTestId(screen, 'team-groups-archived-empty');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-groups-toggle-archived');
        await screen.pressByTestIdAsync('team-groups-toggle-archived');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-groups-archived-empty');
    });

    it('offers search only while the Team has active Groups', async () => {
        const serverId = await addManagedHome(2);
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [], nextCursor: null },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-toggle-archived');

        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: {
                items: [
                    teamGroupFixture({ id: 'group-a', name: 'Platform on-call', archivedAt: 1 }),
                    teamGroupFixture({ id: 'group-b', name: 'Release engineers', archivedAt: 1 }),
                ],
                nextCursor: null,
            },
        });
        await screen.pressByTestIdAsync('team-groups-toggle-archived');
        await waitForTestId(screen, 'team-groups-archived-row:group-b');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-groups-search');
    });

    it('names the source that owns a directory-created Group without hiding its roster', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: {
                items: [teamGroupFixture({
                    id: 'group-okta',
                    name: 'Infrastructure',
                    management: {
                        kind: 'directory_created',
                        bindingId: 'binding-okta',
                        label: 'Okta',
                        owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                    },
                })],
                nextCursor: null,
            },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-row:group-okta');

        expect(screen.getTextContent()).toContain('teams.groups.managedBy(source=Okta)');
    });

    it('keeps read Groups on screen and offers a retry when a later page fails', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: 'cursor-2' },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-load-more');

        harness.answer(serverId, GROUPS_LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        await screen.pressByTestIdAsync('team-groups-load-more');

        await waitForTestId(screen, 'team-groups-retry');
        // Continuity: the page already read stays rendered through the failure.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-groups-row:group-1');
    });

    it('does not offer retry after the Home authoritatively refuses the Groups read', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, { status: 403, body: { error: 'forbidden' } });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-unavailable');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-groups-retry');
        expect(screen.getTextContent()).toContain('errors.permissionDenied');
    });

    it.each([
        ['invalid_team_cursor', 400, 'teams.errors.listCursorExpired', 'reload'],
        ['team_authentication_required', 403, 'session.access.authenticationRequired', 'sign-in'],
        ['team_authentication_unavailable', 503, 'teams.credentials.externalApi.authenticationUnavailable', null],
    ] as const)('shows %s once and offers the Groups recovery that can work', async (code, status, label, recovery) => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, { body: { items: [teamGroupFixture()], nextCursor: 'cursor-2' } });
        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-load-more');

        harness.answer(serverId, GROUPS_LIST_PATH, { status, body: { error: code } });
        await screen.pressByTestIdAsync('team-groups-load-more');
        await waitForTestId(screen, 'team-groups-unavailable');

        expect(screen.getTextContent().split(label)).toHaveLength(2);
        expect(screen.findByTestId('team-groups-retry')).toBeNull();
        expect(screen.findByTestId('team-groups-load-more')).toBeNull();
        if (recovery === 'reload') {
            harness.answer(serverId, GROUPS_LIST_PATH, { body: { items: [teamGroupFixture()], nextCursor: null } });
            await screen.pressByTestIdAsync('team-groups-reload');
            await vi.waitFor(() => expect(screen.findByTestId('team-groups-unavailable')).toBeNull());
            expect(harness.requestsFor(GROUPS_LIST_PATH).at(-1)?.input).not.toHaveProperty('cursor');
        } else if (recovery === 'sign-in') {
            await screen.pressByTestIdAsync('team-groups-sign-in');
            expect(routerPush).toHaveBeenCalledWith(expect.stringContaining(`/teams/team-1/sign-in?serverId=${encodeURIComponent(serverId)}`));
        } else {
            expect(screen.findByTestId('team-groups-reload')).toBeNull();
            expect(screen.findByTestId('team-groups-sign-in')).toBeNull();
        }
    });

    it('says the Groups read is turned off in Settings and leads there, with no retry', async () => {
        const serverId = await addManagedHome();
        const { storage } = await import('@/sync/domains/state/storage');
        const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
        const previous = storage.getState().settings.actionsSettingsV1;
        const disabled = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'teams.groups.list': { enabled: false } } });
        storage.getState().applySettingsLocal({ actionsSettingsV1: disabled });
        harness.answer(serverId, '/v2/account/settings', { body: {
            version: 1, content: { t: 'plain', v: { actionsSettingsV1: disabled } },
        } });
        try {
            const screen = await renderGroups(serverId);
            await waitForTestId(screen, 'team-groups-unavailable');

            expect(screen.getTextContent()).toContain('actionConfirmations.turnedOffReadMessage');
            expect(screen.getTextContent()).not.toContain('teams.errors.loadFailed');
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-groups-retry');
            await screen.pressByTestIdAsync('team-groups-open-actions-settings');
            expect(routerPush).toHaveBeenCalledWith('/settings/actions');
            expect(harness.requestsFor(GROUPS_LIST_PATH)).toHaveLength(0);
        } finally {
            storage.getState().applySettingsLocal({ actionsSettingsV1: previous });
        }
    });

    it('reads Groups for a plain viewer and offers no create control', async () => {
        // The Home authorizes this list on `viewTeam`; `manageGroups` gates only
        // the writes, so a member sees the Groups and is offered nothing.
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({
                viewerRole: 'member',
                capabilities: teamCapabilitiesFixture({}),
            }),
        });
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture()], nextCursor: null },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-row:group-1');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-groups-forbidden');
        expect(ids).not.toContain('team-groups-create');
    });

    it('explains a viewer the Home would not answer, and reads no Groups', async () => {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({
                viewerRole: null,
                // A non-member Home administrator: the Team is visible, its roster and Groups are not (DR-20).
            capabilities: teamCapabilitiesFixture({ viewRoster: false, manageSettings: true }),
            }),
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-forbidden');

        expect(harness.requestsFor(GROUPS_LIST_PATH)).toHaveLength(0);
    });
});
