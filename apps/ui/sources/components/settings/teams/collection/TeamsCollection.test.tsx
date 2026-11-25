import * as React from 'react';

import { expectHomePageReadCosts } from '@/dev/testkit/harness/expectHomePageReadCosts';
import { TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1, TeamsListInputV1Schema } from '@happier-dev/protocol/teams';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

let pathname = '/settings/teams';
const router = createExpoRouterMock({ pathname: () => pathname, navigation: { setOptions: vi.fn() } });
installSettingsViewCommonModuleMocks({ router: () => router.module, storage: 'real' });

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
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Cold module transformation belongs to collection, outside the lifecycle/count contract.
const { resetTeamsSnapshotsForTests, applyTeamsDirectoryPage, getTeamsDirectorySnapshot } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetHomeGovernanceEligibilitySnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceEligibilitySnapshots');
const { resetHomeGovernanceEligibilityEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEligibilityEngine');
const { TeamsCollectionRail } = await import('./TeamsCollectionRail');
const { TeamRow } = await import('../TeamRow');
const { teamDirectoryQueryKeyV1 } = await import('@happier-dev/protocol/teams');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const LIST_PATH = '/v1/teams/list';

beforeEach(async () => {
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

describe('Team collection draft row', () => {
    it('leaves out the New Team draft for someone no Home lets create one', async () => {
        const refused = await addHome('managed-home');
        await harness.selectHomes([refused]);
        harness.answer(refused, LIST_PATH, { body: { items: [teamSummaryFixture()], nextCursor: null } });
        pathname = '/settings/teams/new';
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(harness.requestsFor('/v1/home/governance/eligibility/get').length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-loading'));
        // The create page says why creation is refused; the rail does not add a draft that cannot exist.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-collection-draft');
    });

    it('keeps the New Team draft for someone a Home lets create one', async () => {
        const home = await addHome('open-home');
        await harness.selectHomes([home]);
        harness.answer(home, '/v1/home/governance/eligibility/get', { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        harness.answer(home, LIST_PATH, { body: { items: [teamSummaryFixture()], nextCursor: null } });
        pathname = '/settings/teams/new';
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-collection-draft'));
    });
});

describe('Team collection first read', () => {
    it('guesses no Team rows while the directory is read: one quiet line waits where they will arrive', async () => {
        const home = await addHome('held-home');
        await harness.selectHomes([home]);
        harness.answer(home, LIST_PATH, { body: { items: [], nextCursor: null }, respondAfter: new Promise<void>(() => {}) });
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-loading'));
        // How many Teams there are is the directory's answer: nothing on screen claims a count.
        expect(collectRenderedTestIds(screen.tree.toJSON()).filter((id) => /-skeleton:\d+$/.test(id))).toEqual([]);
        // The archived toggle belongs under the rows: it arrives with them, never under the waiting line.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-toggle-archived');
    });

    it('holds the waiting line, not a one-Team list, while a routed Team is read before its directory', async () => {
        const home = await addHome('routed-home');
        await harness.selectHomes([home]);
        const release = Promise.withResolvers<void>();
        harness.answer(home, LIST_PATH, { body: { items: [
            teamSummaryFixture({ id: 'northwind', name: 'Northwind' }),
            teamSummaryFixture({ id: 'willow', name: 'Willow' }),
        ], nextCursor: null }, respondAfter: release.promise });
        harness.answer(home, '/v1/teams/get', { body: teamSummaryFixture({ id: 'willow', name: 'Willow' }) });
        pathname = `/settings/teams/${home}/willow`;
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(harness.requestsFor('/v1/teams/get').length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-loading'));
        // The routed Team alone is not the set: no partial list, and nothing that belongs under the rows.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(`teams-row:${home}:willow`);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-toggle-archived');
        release.resolve();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:northwind`));
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:willow`);
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-toggle-archived');
    });
});

it('places the second Team and Show archived at the mounted row offsets on the first recycler layout', async () => {
    const home = await addHome('rail-geometry-home');
    await harness.selectHomes([home]);
    harness.answer(home, LIST_PATH, { body: { items: [
        teamSummaryFixture({ id: 'alpha', name: 'Alpha', viewerRole: 'owner' }),
        teamSummaryFixture({ id: 'beta', name: 'Beta', viewerRole: 'member' }),
    ], nextCursor: null } });
    const screen = await renderScreen(<TeamsCollectionRail />);
    await vi.waitFor(() => expect(screen.findHostByTestId('teams-directory-toggle-archived')).not.toBeNull());

    // Legend has the rendered cells and its first estimates, but has received no layout events.
    const list = screen.tree.findByType('LegendList').props;
    const estimates = list.data.slice(0, 2).map((row: unknown, index: number): number =>
        list.getEstimatedItemSize?.(row, index) ?? list.estimatedItemSize,
    );
    expect(screen.findHostByTestId(`teams-row:${home}:alpha`)).not.toBeNull();
    expect(screen.findHostByTestId(`teams-row:${home}:beta`)).not.toBeNull();
    const { HAPPIER_COLLECTION_LIST_METRICS } = await import('@happier-dev/plugin-ui/presentation');
    const rowHeight = HAPPIER_COLLECTION_LIST_METRICS.describedRowMinHeight;
    expect([estimates[0], estimates[0] + estimates[1]]).toEqual([rowHeight, 2 * rowHeight]);
});

describe('Team collection loaded-page search', () => {
    it('updates only the changed mounted Team row on a 400-Team page arrival', async () => {
        const home = await addHome('row-cost-home');
        await harness.selectHomes([home]);
        const items = Array.from({ length: 400 }, (_, i) => teamSummaryFixture({ id: `team-${i}` }));
        harness.answer(home, LIST_PATH, { body: { items, nextCursor: null } });
        const screen = await renderScreen(<TeamsCollectionRail />);
        const mountedRows = () => screen.tree.findAllByType(TeamRow);
        await vi.waitFor(() => expect(mountedRows().length).toBeGreaterThan(3));
        const baseline = new Map(mountedRows().map((node) => [node.props.row.team.id, node.props] as const));
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home), accountId: 'row-cost-home' };
        const queryKey = teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' });
        const snapshot = getTeamsDirectorySnapshot(scope, queryKey);
        if (!snapshot) throw new Error('Expected loaded directory');
        await act(async () => applyTeamsDirectoryPage({ scope, queryKey,
            items: items.map((row, i) => i === 0 ? { ...row, name: 'Renamed' } : row),
            observedAt: snapshot.lastObservedAt ?? 0,
        }));
        expect(mountedRows().filter((node) => node.props !== baseline.get(node.props.row.team.id))).toHaveLength(1);
        await screen.pressByTestIdAsync(`teams-row:${home}:team-1`);
        expect(router.spies.replace).toHaveBeenCalledWith(expect.stringContaining('team-1'));
    });

    it('retains the selected archived Team in the rail without opening all archived Teams', async () => {
        const home = await addHome('archived-home');
        await harness.selectHomes([home]);
        const team = teamSummaryFixture({ id: 'archived-team', archivedAt: 1 });
        const other = teamSummaryFixture({ id: 'other-archived', archivedAt: 2 });
        harness.answer(home, LIST_PATH, { select: (input) => ({ body: {
            items: input !== null && typeof input === 'object' && 'archived' in input && input.archived === 'archived' ? [other] : [],
            nextCursor: null,
        } }) });
        harness.answer(home, '/v1/teams/get', { body: team });
        pathname = `/settings/teams/${home}/archived-team/settings`;
        const { TeamsCollectionRail } = await import('./TeamsCollectionRail');
        const screen = await renderScreen(<TeamsCollectionRail />);
        await vi.waitFor(() => expect(harness.requestsFor('/v1/teams/get').length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:archived-team`));
        expect(screen.tree.findAllByTestId(`teams-row:${home}:archived-team`).some((node) => node.props.selected === true)).toBe(true);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(`teams-row:${home}:other-archived`);
        await screen.pressByTestIdAsync('teams-directory-toggle-archived');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:other-archived`));
        await screen.pressByTestIdAsync('teams-directory-toggle-archived');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain(`teams-row:${home}:other-archived`);
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:archived-team`);
    });
    it('presents a server failure with the shared error card and retries to a successful directory', async () => {
        const home = await addHome('failed-home');
        await harness.selectHomes([home]);
        harness.answer(home, LIST_PATH, { status: 503 });
        const { TeamsDirectoryScreen } = await import('../TeamsDirectoryScreen');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(<TeamsDirectoryScreen />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-home-unavailable:${home}`));
        const card = screen.tree.findAllByType(SurfaceStateCard).find((node) => node.props.testID === `teams-home-unavailable:${home}`);
        // No Home answered: its one message is the page state, in Share's words for the same read.
        expect(card?.props).toMatchObject({ kind: 'error', title: 'teams.errors.teamsLoadFailed',
            action: { testID: 'teams-directory-retry', label: 'common.retry' } });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-loading');
        harness.answer(home, LIST_PATH, { body: { items: [], nextCursor: null } });
        await screen.pressByTestIdAsync('teams-directory-retry');
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-empty'));
    });

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
        // Retry refreshes every contributing Home. The failed Home can recover
        // before its neighbour's refresh settles; search stays partial until both answer.
        await vi.waitFor(() => {
            const completeText = JSON.stringify(screen.tree.toJSON(), (key, value) => key === 'props' ? undefined : value);
            expect(completeText).toContain('teams.directory.noMatches');
            expect(completeText).not.toContain('teams.directory.noLoadedMatches');
        });
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

it('keeps the last known Team count during a Team-change refetch', async () => {
    const home = await addHome('count-home');
    await harness.selectHomes([home]);
    const body = { items: [teamSummaryFixture()], nextCursor: null };
    harness.answer(home, LIST_PATH, { body });
    const screen = await renderScreen(<TeamsCollectionRail />);
    const { CollectionList } = await import('@/components/ui/lists/collection/CollectionList');
    await vi.waitFor(() => expect(screen.tree.findByType(CollectionList).props.count).toBe(1));
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let requested = false;
    harness.answer(home, LIST_PATH, { select: () => { requested = true; return { body, respondAfter: pending }; } });
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol/changes');
    try {
        await act(async () => publishHomeAccountChange(home, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await vi.waitFor(() => expect(requested).toBe(true));
        expect(screen.tree.findByType(CollectionList).props.count).toBe(1);
    } finally { await act(async () => { release(); await pending; }); }
});

/**
 * A return to the collection mounts it again in the same document. Every commit of that remount is
 * recorded, so a loading line drawn for a single frame before the store's rows arrive is seen.
 */
async function remountRecording(screen: Awaited<ReturnType<typeof renderScreen>>, element: React.ReactElement) {
    await screen.update(<></>);
    const commits: string[][] = [];
    const stop = screen.tree.subscribe(() => { commits.push(collectRenderedTestIds(screen.tree.toJSON())); });
    try {
        await screen.update(element);
    } finally { stop(); }
    return commits;
}

describe('Team collection return', () => {
    it('reads just the demanded Team directory on cold open and return', async () => {
        const home = await addHome('directory-cost-home');
        await harness.selectHomes([home]);
        const items = Array.from({ length: 120 }, (_, index) => teamSummaryFixture({ id: `cost-team-${index}` }));
        harness.answer(home, LIST_PATH, { select: input => {
            const { cursor } = TeamsListInputV1Schema.parse(input);
            const offset = typeof cursor === 'string' ? Number(cursor) : 0;
            const nextOffset = offset + TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1;
            return { body: { items: items.slice(offset, nextOffset), nextCursor: nextOffset < items.length ? String(nextOffset) : null } };
        } });
        const { TeamsDirectoryScreen } = await import('../TeamsDirectoryScreen');
        const page = <TeamsDirectoryScreen />;
        const eligibilityPath = '/v1/home/governance/eligibility/get';
        await expectHomePageReadCosts({
            home: harness, mount: () => renderScreen(page), leave: <></>, returnTo: page,
            settled: screen => expect(screen.findHostByTestId(`teams-row:${home}:cost-team-0`)).not.toBeNull(),
            cold: { [LIST_PATH]: 1, [eligibilityPath]: 1 },
            returning: { [LIST_PATH]: 0, [eligibilityPath]: 1 },
        });
    });

    it.each(['rail', 'page'] as const)('paints the %s from the last-known directory in its first frame, never "Loading Teams…"', async (surface) => {
        const home = await addHome('return-home');
        await harness.selectHomes([home]);
        harness.answer(home, LIST_PATH, { body: { items: [teamSummaryFixture({ id: 'northwind' })], nextCursor: null } });
        const { TeamsDirectoryScreen } = await import('../TeamsDirectoryScreen');
        const element = surface === 'rail' ? <TeamsCollectionRail /> : <TeamsDirectoryScreen />;
        const screen = await renderScreen(element);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:northwind`));
        // The return's own read is held: only the store's last-known rows can paint it.
        harness.answer(home, LIST_PATH, { body: { items: [teamSummaryFixture({ id: 'northwind' })], nextCursor: null }, respondAfter: new Promise<void>(() => {}) });
        const commits = await remountRecording(screen, element);
        expect(commits.length).toBeGreaterThan(0);
        expect(commits[0]).toContain(`teams-row:${home}:northwind`);
        expect(commits.filter((ids) => ids.includes('teams-directory-loading'))).toEqual([]);
    });
});
