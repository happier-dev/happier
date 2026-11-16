import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const indexView = vi.hoisted(() => ({ current: 'list' as 'list' | 'land' }));

// The split geometry is measured from the window; tests choose which side of it they are on.
vi.mock('@happier-dev/plugin-ui/presentation', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useHappierCollectionIndexView: () => indexView.current,
}));
vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, unknown>) => {
        const data = (props.data as readonly unknown[] | undefined) ?? [];
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
        useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Import the real screen at collection, after the boundaries: a cold import inside a test body can outlast it.
const { TeamsDirectoryScreen } = await import('./TeamsDirectoryScreen');

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const TEAMS_LIST_PATH = '/v1/teams/list';

async function renderDirectory() {
    return renderScreen(<TeamsDirectoryScreen />);
}

async function memberHome(teamCount: number) {
    const home = await harness.addHome({
        name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
    });
    await harness.selectHomes([home]);
    harness.answer(home, ELIGIBILITY_PATH, {
        body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false, teamCreationPolicy: 'managed_only', administratorNames: [], showTeams: true },
    });
    harness.answer(home, TEAMS_LIST_PATH, {
        body: {
            items: Array.from({ length: teamCount }, (_, i) => teamSummaryFixture({ id: `team-${i}`, name: `Team ${i}` })),
            nextCursor: null,
        },
    });
    return home;
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetHomeGovernanceEligibilitySnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots'
    );
    const { resetHomeGovernanceEligibilityEngineForTests } = await import(
        '@/sync/engine/home/governance/homeGovernanceEligibilityEngine'
    );
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetHomeGovernanceEligibilitySnapshotsForTests();
    resetHomeGovernanceEligibilityEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    indexView.current = 'list';
});

afterEach(() => standardCleanup());

describe('TeamsDirectoryScreen craft', () => {
    it('offers no search over an empty Teams list', async () => {
        await memberHome(0);
        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-empty'));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-search');
    });

    it('offers the search once the list no longer fits at a glance, as the rail does', async () => {
        const home = await memberHome(9);
        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:team-8`));
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-search');
    });

    it('beside the rail, leaves the one loading line to the rail instead of a second loading card', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        const pending: { answer: () => void } = { answer: () => undefined };
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [], nextCursor: null },
            respondAfter: new Promise<void>((resolve) => { pending.answer = resolve; }),
        });
        indexView.current = 'land';

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(harness.requestsFor(TEAMS_LIST_PATH).length).toBeGreaterThan(0));
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('teams-directory-header');
        expect(ids).not.toContain('teams-directory-loading');
        pending.answer();
    });

    it('beside the rail, never calls a Home that failed to answer "No Teams yet"', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, TEAMS_LIST_PATH, { status: 503 });
        indexView.current = 'land';

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-home-unavailable:${home}`));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-empty');
    });
});
