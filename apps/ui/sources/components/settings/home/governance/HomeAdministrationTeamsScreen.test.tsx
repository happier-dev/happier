import * as React from 'react';
import { act } from 'react-test-renderer';
import {
    NO_TEAM_CAPABILITIES_V1,
    resolveTeamAdmissionProjectionV1,
} from '@happier-dev/protocol/teams';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit`
 * barrel. The barrel re-exports `fixtures/agentCatalogFixtures`, whose
 * production projection reaches `@/sync/runtime/orchestration/connectionManager`
 * and, through it, `@/sync/http/client` and the reachability fetch. Evaluating
 * that graph on this file's first import binds the real transports and freezes
 * the applied active Home to the built-in default *before*
 * `installHomeGovernanceBoundaries` can install either boundary, so every Home
 * request leaves the harness and the screen never settles. This is the same
 * rule the harness states for its own late imports.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const virtualizedBoundary = vi.hoisted(() => ({
    props: null as Record<string, any> | null,
    mountLimit: Number.POSITIVE_INFINITY,
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, any>) => {
        virtualizedBoundary.props = props;
        const data = (props.data ?? []).slice(0, virtualizedBoundary.mountLimit);
        return React.createElement(
            'VirtualizedList',
            props,
            props.ListHeaderComponent,
            ...data.map((item: unknown, index: number) => props.renderItem({ item, index })),
            props.ListFooterComponent,
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

const GOVERNANCE_PATH = '/v1/home/governance/get';
const TEAMS_LIST_PATH = '/v1/teams/list';

function teamSummary(teamId: string, name: string, archivedAt: number | null = null) {
    return {
        id: teamId,
        name,
        description: null,
        logo: null,
        archivedAt,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
            authenticationPolicyStatus: 'available',
        },
        // A Home administrator governs Teams they have not joined, so the
        // administered scope legitimately answers with no viewer role.
        viewerRole: null,
        capabilities: NO_TEAM_CAPABILITIES_V1,
        // Built by its own owner, so a change to what a Team may offer fails
        // here instead of being frozen into a local literal.
        admission: resolveTeamAdmissionProjectionV1(),
        // The administered scope withholds roster counts from a non-member administrator.
        counts: null,
    };
}

async function renderHomeTeams(serverId: string) {
    const { HomeAdministrationTeamsScreen } = await import('./HomeAdministrationTeamsScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    return renderScreen(<HomeAdministrationTeamsScreen serverId={serverId} />);
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceSnapshots'
    );
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetHomeGovernanceSnapshotsForTests();
    // The Teams directory keeps its rows across mounts by design, so each case
    // starts from a Home that has answered nothing yet.
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
    virtualizedBoundary.props = null;
    virtualizedBoundary.mountLimit = Number.POSITIVE_INFINITY;
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationTeamsScreen', () => {
    it('keeps a large administered Team directory behind the canonical virtualized window', async () => {
        // The policy row precedes two mounted Team segments; create heads the first segment.
        virtualizedBoundary.mountLimit = 3;
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, TEAMS_LIST_PATH, {
            body: {
                items: Array.from({ length: 120 }, (_, index) => teamSummary(`team-${index}`, `Team ${index}`)),
                nextCursor: null,
            },
        });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()).filter((id) => id.startsWith(`teams-row:${home}:`)))
                .toHaveLength(24);
        });

        expect(virtualizedBoundary.props?.testID).toBe('home-teams-virtualized-list');
        expect(virtualizedBoundary.props?.maintainVisibleContentPosition).toBe(true);
        expect(virtualizedBoundary.props?.data.length).toBeGreaterThan(virtualizedBoundary.mountLimit);
    });

    it('reads the administered scope of its own Home and no other', async () => {
        const homeA = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        const homeB = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            teamsEnabled: true,
        });
        // Both Homes are in the exact set the user is looking at, and both
        // advertise Teams, so narrowing is the only thing that can keep Home B
        // out of this screen's reads.
        await harness.selectHomes([homeA, homeB]);
        harness.answer(homeA, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(homeB, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(homeA, TEAMS_LIST_PATH, {
            body: { items: [teamSummary('team-1', 'Platform')], nextCursor: null },
        });
        harness.answer(homeB, TEAMS_LIST_PATH, {
            body: { items: [teamSummary('team-b', 'Other Home')], nextCursor: null },
        });

        const screen = await renderHomeTeams(homeA);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${homeA}:team-1`);
        });

        const listCalls = harness.requestsFor(TEAMS_LIST_PATH);
        expect(listCalls.length).toBeGreaterThan(0);
        // Governance scope, not the viewer's own membership list.
        expect(listCalls.every((call) => (call.input as { scope?: string }).scope === 'administered')).toBe(true);
        expect(listCalls.every((call) => call.serverId === homeA)).toBe(true);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(`teams-row:${homeB}:team-b`);
    });

    it('opens a Team by its exact Home-qualified address', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummary('team-1', 'Platform')], nextCursor: null },
        });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:team-1`);
        });

        screen.pressByTestId(`teams-row:${home}:team-1`);
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${home}/team-1`);
    });

    it('opens Team creation in an exact Home Administration context', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-create');
        });

        screen.pressByTestId('home-teams-create');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/new?administrationServerId=${encodeURIComponent(home)}`,
        );
    });

    it('keeps the Teams section and its create action when the Home could not list its Teams', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, TEAMS_LIST_PATH, { status: 503, body: { error: 'teams_unavailable' } });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-retry');
        });
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // Creating does not depend on the list the Home failed to send.
        expect(ids).toContain('home-teams-create');
        // The unknown list is stated once, inside the section, never as an empty Home.
        expect(ids.filter((id) => id === 'home-teams-retry')).toHaveLength(1);
        expect(ids).not.toContain('home-teams-empty');
    });

    it('keeps archived administered Teams reachable for restore', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-empty'));
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummary('archived-team', 'Archived', 1_700_000_000_000)], nextCursor: null },
        });
        await screen.pressByTestIdAsync('home-teams-toggle-archived');

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:archived-team`);
        });
        screen.pressByTestId(`teams-row:${home}:archived-team`);
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${home}/archived-team`);
    });

    it('announces archived loading and retries an archived read failure', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-empty'));

        let finishArchivedRead: (() => void) | null = null;
        const archivedResponse = new Promise<void>((resolve) => { finishArchivedRead = resolve; });
        harness.answer(home, TEAMS_LIST_PATH, {
            status: 503,
            body: { error: 'unavailable' },
            respondAfter: archivedResponse,
        });
        await screen.pressByTestIdAsync('home-teams-toggle-archived');

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-archived-loading');
        });
        expect(screen.findByTestId('home-teams-toggle-archived')?.props.accessibilityState?.expanded).toBe(true);

        await act(async () => {
            finishArchivedRead?.();
            await archivedResponse;
        });
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-archived-retry');
        });
        expect(screen.findByTestId('home-teams-archived-retry')?.props.accessibilityLiveRegion).toBe('assertive');

        const before = harness.requestsFor(TEAMS_LIST_PATH).length;
        await screen.pressByTestIdAsync('home-teams-archived-retry');
        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(TEAMS_LIST_PATH).length).toBeGreaterThan(before);
        });
        expect(harness.requestsFor(TEAMS_LIST_PATH).at(-1)?.input).toMatchObject({
            v: 1,
            scope: 'administered',
            archived: 'archived',
            cursor: null,
        });
    });

    it('says the Home has no Teams rather than showing an empty surface', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-empty');
        });
    });

    it('does not ask a Home for Teams it has said it does not have', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: false,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({ teamsEnabled: false }),
        });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-disabled');
        });
        expect(harness.requestsFor(TEAMS_LIST_PATH)).toHaveLength(0);
    });

    it('explains a viewer without Team governance authority and asks for nothing', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({
                capabilities: {
                    ...homeGovernanceProjectionFixture().capabilities,
                    manageAllTeams: false,
                },
            }),
        });

        const screen = await renderHomeTeams(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-teams-forbidden');
        });
        expect(harness.requestsFor(TEAMS_LIST_PATH)).toHaveLength(0);
    });
});
