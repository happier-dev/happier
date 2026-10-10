import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamGroupFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const virtualizedBoundary = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
    mountLimit: Number.POSITIVE_INFINITY,
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, unknown>) => {
        virtualizedBoundary.props = props;
        const data = ((props.data as readonly unknown[] | undefined) ?? []).slice(0, virtualizedBoundary.mountLimit);
        const renderItem = props.renderItem as (info: { item: unknown; index: number }) => React.ReactNode;
        return React.createElement(
            'VirtualizedList',
            props,
            props.ListHeaderComponent as React.ReactNode,
            ...data.map((item, index) => renderItem({ item, index })),
        );
    },
}));

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const GROUPS_LIST_PATH = '/v1/teams/groups/list';

async function renderGroups(serverId: string) {
    const { TeamGroupsScreen } = await import('./TeamGroupsScreen');
    return renderScreen(<TeamGroupsScreen serverId={serverId} teamId="team-1" />);
}

async function addManagedHome(): Promise<string> {
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
    it('renders a large Group directory as stable chunks in the canonical virtualized list', async () => {
        virtualizedBoundary.mountLimit = 2;
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: {
                items: Array.from({ length: 25 }, (_, index) => teamGroupFixture({
                    id: `group-${index}`,
                    name: `Group ${index}`,
                })),
                nextCursor: null,
            },
        });

        const screen = await renderGroups(serverId);
        await waitForTestId(screen, 'team-groups-row:group-0');

        expect(virtualizedBoundary.props?.testID).toBe('team-groups-virtualized-list');
        expect(virtualizedBoundary.props?.maintainVisibleContentPosition).toBe(true);
        const data = virtualizedBoundary.props?.data as readonly unknown[];
        expect(data.length).toBeLessThan(25);
        const keyExtractor = virtualizedBoundary.props?.keyExtractor as (item: unknown) => string;
        expect(data.map(keyExtractor)).toEqual(expect.arrayContaining([
            'active:group-0',
            'active:group-12',
            'active:group-24',
        ]));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-groups-row:group-24');
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
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-groups-toggle-archived');
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
        expect(screen.getTextContent()).toContain('teams.errors.forbidden');
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
