import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, createHomeGovernanceHarness, installHomeGovernanceBoundaries, renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

let pathname = '/settings/teams';
const router = createExpoRouterMock({ pathname: () => pathname, navigation: { setOptions: vi.fn() } });
installSettingsViewCommonModuleMocks({ router: () => router.module });

// The third-party recycler is the viewport boundary. Internal list, row, search,
// paging, scope and snapshot owners stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: 8,
    }).module;
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const LIST_PATH = '/v1/teams/list';

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetHomeGovernanceEligibilitySnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceEligibilitySnapshots');
    const { resetHomeGovernanceEligibilityEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEligibilityEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetHomeGovernanceEligibilitySnapshotsForTests();
    resetHomeGovernanceEligibilityEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    pathname = '/settings/teams';
});
afterEach(() => standardCleanup());

async function addHome(name: string) {
    const home = await harness.addHome({ name, serverUrl: `https://${name}.example`, accountId: name, teamsEnabled: true });
    harness.answer(home, '/v1/home/governance/eligibility/get', { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
    return home;
}

describe('Team collection loaded-page search', () => {
    it('retains a readable addressed Team outside the member directory without an empty or zero-count claim', async () => {
        const home = await addHome('admin-home');
        await harness.selectHomes([home]);
        const team = teamSummaryFixture({ id: 'design', name: 'Design', viewerRole: null });
        harness.answer(home, LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(home, '/v1/teams/get', { body: team });
        pathname = `/settings/teams/${home}/design/settings`;
        const { TeamsCollectionRail } = await import('./TeamsCollectionRail');
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:design`));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-empty');
        const { CollectionList } = await import('@/components/ui/lists/collection/CollectionList');
        expect(screen.tree.findByType(CollectionList).props.count).toBeNull();
        expect(harness.requestsFor(LIST_PATH).every((request) => (request.input as { scope: string }).scope === 'member')).toBe(true);
    });

    it.each(['rail', 'page'] as const)('keeps %s search partial through page continuation and an unavailable Home', async (surface) => {
        const home = await addHome('home-a');
        const unavailable = await addHome('home-b');
        await harness.selectHomes([home, unavailable]);
        harness.answer(home, LIST_PATH, { body: { items: Array.from({ length: 10 }, (_, i) => teamSummaryFixture({ id: `team-${i}`, name: `Alpha ${i}` })), nextCursor: 'page-two' } });
        harness.answer(unavailable, LIST_PATH, { status: 503 });
        const { TeamsCollectionRail } = await import('./TeamsCollectionRail');
        const { TeamsDirectoryScreen } = await import('../TeamsDirectoryScreen');
        const screen = await renderScreen(surface === 'rail' ? <TeamsCollectionRail /> : <TeamsDirectoryScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('teams-directory-search')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('teams-directory-search', 'Zebra'));
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-search-empty'));
        expect(JSON.stringify(screen.tree.toJSON(), (key, value) => key === 'props' ? undefined : value)).toContain('teams.directory.noLoadedMatches');
        expect(screen.findByTestId('teams-directory-search')?.props.placeholder).toBe('teams.directory.searchLoadedPlaceholder');

        harness.answer(home, LIST_PATH, { body: { items: [teamSummaryFixture({ id: 'zebra', name: 'Zebra' })], nextCursor: null } });
        await screen.pressByTestIdAsync('teams-directory-load-more');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:zebra`));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-search-empty');
        await act(async () => screen.changeTextByTestId('teams-directory-search', 'Absent'));
        expect(JSON.stringify(screen.tree.toJSON(), (key, value) => key === 'props' ? undefined : value)).toContain('teams.directory.noLoadedMatches');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-home-unavailable:${unavailable}`);
        expect(harness.requestsFor(LIST_PATH).every((request) => !Object.hasOwn(request.input as object, 'query'))).toBe(true);

        harness.answer(unavailable, LIST_PATH, { body: { items: [], nextCursor: null } });
        await screen.pressByTestIdAsync(surface === 'rail' ? 'teams-home-unavailable-retry' : 'teams-directory-retry');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(`teams-home-unavailable:${unavailable}`));
        const completeText = JSON.stringify(screen.tree.toJSON(), (key, value) => key === 'props' ? undefined : value);
        expect(completeText).toContain('teams.directory.noMatches');
        expect(completeText).not.toContain('teams.directory.noLoadedMatches');
    });

    it('lets the recycler bound mounted Team rows and retains selection when the route changes', async () => {
        const home = await addHome('large-home');
        await harness.selectHomes([home]);
        harness.answer(home, LIST_PATH, { body: { items: Array.from({ length: 1000 }, (_, i) => teamSummaryFixture({ id: `team-${i}`, name: `Team ${i}` })), nextCursor: null } });
        pathname = `/settings/teams/${home}/team-0`;
        const { TeamsCollectionRail } = await import('./TeamsCollectionRail');
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:team-0`));
        const rowIds = () => collectRenderedTestIds(screen.tree.toJSON()).filter((id) => id.startsWith('teams-row:'));
        expect(rowIds().length).toBeLessThan(100);
        const list = screen.tree.findByType('LegendList');
        expect(list.props.data.length).toBeGreaterThanOrEqual(1000);
        // Item owns visual selection; button rows deliberately omit the invalid
        // aria-selected attribute on web. Inspect the mounted Item boundary.
        const selected = (id: string) => screen.tree.findAllByTestId(`teams-row:${home}:${id}`)
            .some((node) => node.props.selected === true);
        expect(selected('team-0')).toBe(true);
        pathname = `/settings/teams/${home}/team-1`;
        await act(async () => screen.changeTextByTestId('teams-directory-search', 'Team'));
        expect(screen.tree.findByType('LegendList')).toBe(list);
        expect(selected('team-1')).toBe(true);
        expect(selected('team-0')).toBe(false);
    });

    it('says an empty collection once, on its page: the rail beside it adds no second empty state (DR-19)', async () => {
        const home = await addHome('empty-home');
        await harness.selectHomes([home]);
        harness.answer(home, LIST_PATH, { body: { items: [], nextCursor: null } });
        const { TeamsCollectionRail } = await import('./TeamsCollectionRail');
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(harness.requestsFor(LIST_PATH).length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-loading'));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-empty');
    });
});
