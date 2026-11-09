import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

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
        useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { TeamsDirectoryScreen } = await import('./TeamsDirectoryScreen');

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const TEAMS_LIST_PATH = '/v1/teams/list';

function archivedRead(input: unknown): boolean {
    return typeof input === 'object' && input !== null && (input as { archived?: unknown }).archived === 'archived';
}

async function renderDirectory() {
    return renderScreen(<TeamsDirectoryScreen />);
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
    routerPush.mockReset();
});

afterEach(() => standardCleanup());

/**
 * Opening the archive declares demand for its separate directory sequence. The active list never
 * reads that sequence just to decide whether to offer the control.
 */
describe('TeamsDirectoryScreen archived Teams', () => {
    it('reads no archived Teams until requested, then distinguishes a settled empty archive', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-1' })], nextCursor: null },
            select: input => archivedRead(input) ? { body: { items: [], nextCursor: null } } : undefined,
        });

        const screen = await renderDirectory();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:team-1`);
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-toggle-archived');
        });
        const reads = () => harness.requestsFor(TEAMS_LIST_PATH).filter(request => archivedRead(request.input)).length;
        expect(reads()).toBe(0);
        await screen.pressByTestIdAsync('teams-directory-toggle-archived');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('teams-directory-archived-empty'));
        expect(reads()).toBe(1);
    });

    it('opens the archive on demand and retains its rows across hiding and reopening', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-1' })], nextCursor: null },
            select: (input) => archivedRead(input)
                ? { body: { items: [teamSummaryFixture({ id: 'old', archivedAt: 1_700_000_000_000 })], nextCursor: null } }
                : undefined,
        });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('teams-directory-toggle-archived'));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(`teams-row:${home}:old`);
        expect(harness.requestsFor(TEAMS_LIST_PATH).filter(request => archivedRead(request.input))).toHaveLength(0);
        await screen.pressByTestIdAsync('teams-directory-toggle-archived');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:old`));
        expect(harness.requestsFor(TEAMS_LIST_PATH).filter(request => archivedRead(request.input))).toHaveLength(1);
        await screen.pressByTestIdAsync('teams-directory-toggle-archived');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(`teams-row:${home}:old`);
        await screen.pressByTestIdAsync('teams-directory-toggle-archived');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:old`));
    });

    it('names a Home that could not answer the archived read rather than reporting an empty archive', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-1' })], nextCursor: null },
            select: (input) => archivedRead(input) ? { status: 503 } : undefined,
        });

        const screen = await renderDirectory();
        // An archive that could not be read is not known to be empty, so the control stays.
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('teams-directory-toggle-archived'));
        await screen.pressByTestIdAsync('teams-directory-toggle-archived');

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .toContain(`teams-archived-home-unavailable:${home}`);
            // The archive is not claimed to be empty while the Home never said so.
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .not.toContain('teams-directory-archived-empty');
        });
    });

    it('lists a Team archived from this device exactly once after the archived sequence returns it', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        // The active sequence's own answer still carries the Team it has just
        // been told is archived; the archived sequence returns the same Team.
        harness.answer(home, TEAMS_LIST_PATH, {
            body: {
                items: [teamSummaryFixture({ id: 'team-1', archivedAt: 1_700_000_000_000 })],
                nextCursor: null,
            },
        });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('teams-directory-toggle-archived'));

        await screen.pressByTestIdAsync('teams-directory-toggle-archived');

        await vi.waitFor(() => {
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids.filter((id) => id === `teams-row:${home}:team-1`)).toHaveLength(1);
        });
    });
});
