import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamSummaryFixture,
} from '@/dev/testkit';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const virtualizedBoundary = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: (props: Record<string, unknown>) => React.createElement('SearchHeader', props),
}));
vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, unknown>) => {
        virtualizedBoundary.props = props;
        const data = (props.data as readonly unknown[] | undefined) ?? [];
        const renderItem = props.renderItem as (info: { item: unknown; index: number }) => React.ReactNode;
        return React.createElement(
            'VirtualizedList',
            props,
            props.ListHeaderComponent as React.ReactNode,
            ...data.map((item, index) => renderItem({ item, index })),
            props.ListFooterComponent as React.ReactNode,
        );
    },
}));

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => routeParams.current,
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const GOVERNANCE_PATH = '/v1/home/governance/get';
const TEAMS_LIST_PATH = '/v1/teams/list';

async function renderDirectory() {
    const { TeamsDirectoryScreen } = await import('./TeamsDirectoryScreen');
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
    routeParams.current = {};
    virtualizedBoundary.props = null;
});

afterEach(() => standardCleanup());

describe('TeamsDirectoryScreen Team-creation eligibility', () => {
    it('continues a connected-account Share with Team intent into that Team create route', async () => {
        const home = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'alpha', name: 'Alpha' })], nextCursor: null },
        });
        routeParams.current = {
            credentialSourceKind: 'connected_account',
            credentialSourceServerId: home,
            credentialSourcePluginId: 'openai-codex',
            credentialSourceLocalId: 'openai-codex',
            credentialSourceAccountId: 'work',
        };

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain(`teams-row:${home}:alpha`));
        screen.pressByTestId(`teams-row:${home}:alpha`);

        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${home}/alpha/credentials/new?credentialSourceKind=connected_account&credentialSourcePluginId=openai-codex&credentialSourceLocalId=openai-codex&credentialSourceAccountId=work`,
        );
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-toggle-archived');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-new');
    });

    it('searches the retained cross-Home directory inside one virtualized scroll owner', async () => {
        const homeA = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        const homeB = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            accountId: 'member-b',
            teamsEnabled: true,
        });
        await harness.selectHomes([homeA, homeB]);
        harness.answer(homeA, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(homeB, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        // Search is offered once the list no longer fits at a glance (more than eight Teams).
        harness.answer(homeA, TEAMS_LIST_PATH, {
            body: {
                items: [
                    teamSummaryFixture({ id: 'alpha', name: 'Alpha' }),
                    ...Array.from({ length: 8 }, (_, i) => teamSummaryFixture({ id: `alpha-${i}`, name: `Alpha ${i}` })),
                ],
                nextCursor: null,
            },
        });
        harness.answer(homeB, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'beta', name: 'Beta' })], nextCursor: null },
        });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain(`teams-row:${homeB}:beta`));

        expect(virtualizedBoundary.props?.testID).toBe('teams-directory-virtualized-list');
        expect(virtualizedBoundary.props?.maintainVisibleContentPosition).toBe(true);
        expect(screen.findByTestId('teams-directory-search')?.props.placeholder)
            .toBe('teams.directory.searchLoadedPlaceholder');

        await React.act(async () => {
            screen.findByTestId('teams-directory-search')?.props.onChangeText('beta');
        });

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain(`teams-row:${homeB}:beta`);
        expect(ids).not.toContain(`teams-row:${homeA}:alpha`);

        await React.act(async () => {
            screen.findByTestId('teams-directory-search')?.props.onChangeText('missing');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-search-empty');
    });

    it('shows an update-required row for an unsupported Home without hiding a capable Home', async () => {
        const homeA = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'member-a', teamsEnabled: true,
        });
        const homeB = await harness.addHome({
            name: 'Home B', serverUrl: 'https://home-b.example', accountId: 'member-b', teamsEnabled: true,
        });
        primeServerFeaturesSnapshot({
            serverId: homeB,
            snapshot: { status: 'unsupported', reason: 'invalid_payload' },
        });
        await harness.selectHomes([homeA, homeB]);
        harness.answer(homeA, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(homeA, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'alpha', name: 'Alpha' })], nextCursor: null },
        });

        const screen = await renderDirectory();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${homeA}:alpha`);
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-home-unavailable:${homeB}`);
        });

        expect(screen.getTextContent()).toContain('teams.unavailable.updateRequired');
        // Only the capable Home is read (its active and archived lists); the unsupported one never is.
        expect(new Set(harness.requestsFor(TEAMS_LIST_PATH).map((request) => request.serverId))).toEqual(new Set([homeA]));
    });

    it('offers ordinary creation only when a minimum Home projection currently permits it', async () => {
        const deniedHome = await harness.addHome({
            name: 'Managed Home',
            serverUrl: 'https://managed.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        const allowedHome = await harness.addHome({
            name: 'Self-service Home',
            serverUrl: 'https://self-service.example',
            accountId: 'member-b',
            teamsEnabled: true,
        });
        await harness.selectHomes([deniedHome, allowedHome]);
        harness.answer(deniedHome, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(allowedHome, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(deniedHome, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(allowedHome, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });

        const screen = await renderDirectory();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-new');
        });

        screen.pressByTestId('teams-directory-new');
        expect(routerPush).toHaveBeenCalledWith('/settings/teams/new');
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
        expect(new Set(harness.requestsFor(ELIGIBILITY_PATH).map((request) => request.serverId)))
            .toEqual(new Set([deniedHome, allowedHome]));
    });

    it('does not offer an ordinary create entry when every Home refuses it', async () => {
        const home = await harness.addHome({
            name: 'Managed Home',
            serverUrl: 'https://managed-only.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });

        const screen = await renderDirectory();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-empty');
            expect(harness.requestsFor(ELIGIBILITY_PATH)).toHaveLength(1);
        });

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-new');
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
        // The page says why there is no way to create a Team, and who can.
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('teams.directory.createDenied(homes=Managed Home)'));
    });

    it('names the administrators a member can ask when the one Home in view has them create Teams', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(home, ELIGIBILITY_PATH, { body: {
            teamsEnabled: true,
            createTeam: false,
            createTeamForChosenAccount: false,
            teamCreationPolicy: 'managed_only',
            administratorNames: ['Ada Lovelace', 'grace'],
            showTeams: true,
        } });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('teams.directory.createAdministered'));

        const text = screen.getTextContent();
        expect(text).toContain('Ada Lovelace');
        expect(text).toContain('grace');
        expect(text).not.toContain('teams.directory.createDenied');
        // No create action that could not succeed, and no policy link for a member.
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('teams-directory-new');
        expect(ids).not.toContain('teams-directory-empty-create');
        expect(ids).not.toContain('teams-directory-open-creation-policy');
    });

    it('tells a member that Team creation is off, with nothing to create', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(home, ELIGIBILITY_PATH, { body: {
            teamsEnabled: true,
            createTeam: false,
            createTeamForChosenAccount: false,
            teamCreationPolicy: 'disabled',
            administratorNames: ['Ada Lovelace'],
            showTeams: true,
        } });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('teams.directory.createOff'));
        expect(screen.getTextContent()).not.toContain('Ada Lovelace');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-empty-create');
    });

    it('keeps a member\'s Teams under disabled creation and offers no create affordance', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'alpha', name: 'Alpha' })], nextCursor: null },
        });
        harness.answer(home, ELIGIBILITY_PATH, { body: {
            teamsEnabled: true,
            createTeam: false,
            createTeamForChosenAccount: false,
            teamCreationPolicy: 'disabled',
            administratorNames: [],
            showTeams: true,
        } });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:alpha`));
        await vi.waitFor(() => expect(harness.requestsFor(ELIGIBILITY_PATH)).toHaveLength(1));
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('teams-directory-new');
        expect(ids).not.toContain('teams-directory-empty-create');
    });

    it('offers an administrator of managed creation New Team and the policy that would let everyone create', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'admin-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(home, ELIGIBILITY_PATH, { body: {
            teamsEnabled: true,
            createTeam: true,
            createTeamForChosenAccount: true,
            teamCreationPolicy: 'managed_only',
            administratorNames: ['Ada Lovelace'],
            showTeams: true,
        } });

        const screen = await renderDirectory();
        await vi.waitFor(() => {
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids).toContain('teams-directory-empty-create');
            expect(ids).toContain('teams-directory-open-creation-policy');
        });
        expect(screen.getTextContent()).not.toContain('teams.directory.createAdministered');

        await screen.pressByTestIdAsync('teams-directory-open-creation-policy');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/home/${encodeURIComponent(home)}/teams?setting=homeAdministration.teamsPolicy.teamCreationPolicy`,
        );
    });

    it('exposes pagination for the archived sequence after that section is opened', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [], nextCursor: null },
            select: (input) => (input as { archived?: unknown } | null)?.archived === 'archived'
                ? {
                    body: {
                        items: [teamSummaryFixture({ id: 'archived-1', archivedAt: 1_700_000_000_000 })],
                        nextCursor: 'archived-page-2',
                    },
                }
                : undefined,
        });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('teams-directory-toggle-archived'));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-archived-load-more');

        await screen.pressByTestIdAsync('teams-directory-toggle-archived');

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-archived-load-more');
        });
    });
});
