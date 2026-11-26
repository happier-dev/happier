/** @vitest-environment jsdom */
import * as React from 'react';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { collectRenderedTestIds, createDeferred, renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let directoryWidth = 390;
let openTeamHome: string | null = null;
let browserLocks: ReturnType<typeof installWebLockManagerMock>;
const sdkRedirect = vi.hoisted(() => vi.fn());

// Native recycling is the boundary; keep the app's list normalization and adapters real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock();
});

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: () => {
        const { Stack, ...router } = createExpoRouterMock({
            pathname: () => openTeamHome ? `/settings/teams/${openTeamHome}/team-0` : '/settings/teams',
        }).module;
        return {
            ...router,
            Redirect: ({ href }: { href: string }) => { sdkRedirect(href); return null; },
            // Expo Router mounts the active index route inside the registered stack.
            Stack: Object.assign(
                () => openTeamHome ? (
                    <TeamSection serverId={openTeamHome} teamId="team-0">{() => null}</TeamSection>
                ) : <TeamsDirectoryScreen />,
                { Screen: Stack.Screen },
            ),
        };
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Import the real screen at collection, after the boundaries: a cold import inside a test body can outlast it.
const { TeamsDirectoryScreen } = await import('./TeamsDirectoryScreen');
const { TeamSection } = await import('./TeamSection');
const { TeamsSettingsLayout } = await import('./collection/TeamsSettingsLayout');

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const TEAMS_LIST_PATH = '/v1/teams/list';

async function renderDirectory() {
    const screen = await renderScreen(<TeamsSettingsLayout />);
    // Supply the platform measurement to the real collection geometry owner.
    await act(async () => screen.findByTestId('settings-teams-layout')!.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: directoryWidth, height: 900 } },
    }));
    return screen;
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
    browserLocks = installWebLockManagerMock();
    sdkRedirect.mockClear();
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
    directoryWidth = 390;
    openTeamHome = null;
});

afterEach(async () => {
    await standardCleanup();
    browserLocks.restore();
});

describe('TeamsDirectoryScreen craft', () => {
    it('keeps a cold directory covered until its first list draws', async () => {
        const launch = startTestLaunchCurtain();
        const answer = createDeferred<void>();
        const home = await memberHome(1);
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-0' })], nextCursor: null },
            respondAfter: answer.promise,
        });
        const screen = await renderDirectory();
        const probe = await renderScreen(<CurtainProbe />);
        const curtain = () => probe.root.findByType('CurtainProbe').props.state;
        try {
            await vi.waitFor(() => expect(screen.findByTestId('teams-directory-loading')).not.toBeNull());
            launch.releaseShell();
            await launch.paint();
            expect(curtain()).toBe('up');
            answer.resolve();
            await vi.waitFor(() => expect(screen.findByTestId(`teams-row:${home}:team-0`)).not.toBeNull());
            await launch.paint();
            expect(curtain()).toBe('leaving');
        } finally {
            await screen.unmount();
            await probe.unmount();
            answer.resolve();
            launch.dispose();
        }
    });

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

    it('beside the rail, keeps the detail loading frame mounted while landing on the first Team', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        const pending: { answer: () => void } = { answer: () => undefined };
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-0' })], nextCursor: null },
            respondAfter: new Promise<void>((resolve) => { pending.answer = resolve; }),
        });
        directoryWidth = 1440;

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(harness.requestsFor(TEAMS_LIST_PATH).length).toBeGreaterThan(0));
        const ids = () => collectRenderedTestIds(screen.tree.toJSON());
        const firstFrame = screen.findHostByTestId('workspace-destination-body-loading');
        expect(ids().filter((id) => id === 'teams-directory-loading')).toHaveLength(1);
        pending.answer();
        await vi.waitFor(() => expect(sdkRedirect).toHaveBeenCalledWith(`/settings/teams/${home}/team-0`));
        expect(firstFrame).not.toBeNull();
        expect(screen.findHostByTestId('workspace-destination-body-loading')).toBe(firstFrame);
    });

    it.each([
        { width: 1440, status: 403, body: { error: 'team_forbidden', details: { reason: 'legacy_home_credential' } },
            reason: 'teams.errors.signInOutdated', action: 'teams.errors.signInAgainAction' },
        { width: 390, status: 403, body: { error: 'team_forbidden', details: { reason: 'legacy_home_credential' } },
            reason: 'teams.errors.signInOutdated', action: 'teams.errors.signInAgainAction' },
        { width: 1440, status: 500, body: { error: 'internal_error' },
            reason: 'teams.errors.teamsLoadFailed', action: 'common.retry' },
        { width: 390, status: 500, body: { error: 'internal_error' },
            reason: 'teams.errors.teamsLoadFailed', action: 'common.retry' },
        { width: 1440, status: 404, body: { error: 'teams_unavailable' },
            reason: 'teams.unavailable.disabled', action: null },
        { width: 390, status: 404, body: { error: 'teams_unavailable' },
            reason: 'teams.unavailable.disabled', action: null },
        { width: 390, status: 400, body: { error: 'invalid_team_input' },
            reason: 'homeGovernance.invalidRead', action: null },
        { width: 1440, status: 403, body: { error: 'team_forbidden' },
            reason: 'errors.permissionDenied', action: null },
    ])('shows one reason and one recovery action for HTTP $status at $width px', async ({ width, status, body, reason, action }) => {
        const home = await memberHome(0);
        harness.answer(home, TEAMS_LIST_PATH, { status, body });
        directoryWidth = width;

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(screen.findHostByTestId(`teams-home-unavailable:${home}`)).not.toBeNull());
        expect(Boolean(screen.findHostByTestId('teams-collection-rail'))).toBe(width === 1440);
        const renderedText = screen.getTextContent().split(/\s+/);
        expect({
            reason: renderedText.filter((text) => text === reason).length,
            action: renderedText.filter((text) => text === action).length,
        }).toEqual({ reason: 1, action: action === null ? 0 : 1 });
        if (action === null) expect(screen.findByTestId('teams-directory-retry')).toBeNull();
        expect(screen.findHostByTestId('teams-directory-empty')).toBeNull();
        // No Home answered: the one Home's message is the page state, not a section about "other Homes",
        // and nothing offers archived Teams of a directory that could not be read.
        expect(renderedText).not.toContain('teams.directory.partialHomes');
        expect(renderedText).not.toContain('teams.directory.unreachableHomes');
        expect(screen.findHostByTestId('teams-directory-toggle-archived')).toBeNull();
    });

    it('names an expired Team directory page and reloads without that cursor', async () => {
        const home = await memberHome(1);
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-0' })], nextCursor: 'page-2' },
        });
        const screen = await renderDirectory();
        await vi.waitFor(() => expect(screen.findByTestId('teams-directory-load-more')).not.toBeNull());
        harness.answer(home, TEAMS_LIST_PATH, { status: 400, body: { error: 'invalid_team_cursor' } });

        await screen.pressByTestIdAsync('teams-directory-load-more');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('teams.errors.listCursorExpired'));
        expect(screen.getTextContent()).not.toContain('teams.unavailable.retry');
        expect(screen.findByTestId('teams-directory-load-more')).toBeNull();

        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-new' })], nextCursor: null },
        });
        await screen.pressByTestIdAsync('teams-directory-reload');
        await vi.waitFor(() => expect(screen.findHostByTestId(`teams-row:${home}:team-new`)).not.toBeNull());
        expect(harness.requestsFor(TEAMS_LIST_PATH).map(({ input }) => (input as { cursor: string | null }).cursor))
            .toEqual([null, 'page-2', null]);
    });

    it('names the Homes that failed beside the Homes that answered', async () => {
        const answered = await memberHome(1);
        const failed = await harness.addHome({
            name: 'Field office', serverUrl: 'https://field.example', accountId: 'member-b', teamsEnabled: true,
        });
        await harness.selectHomes([answered, failed]);
        harness.answer(failed, TEAMS_LIST_PATH, { status: 500, body: { error: 'internal_error' } });

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(screen.findHostByTestId(`teams-home-unavailable:${failed}`)).not.toBeNull());
        expect(screen.findHostByTestId(`teams-row:${answered}:team-0`)).not.toBeNull();
        const renderedText = screen.getTextContent().split(/\s+/);
        expect(renderedText.filter((text) => text === 'teams.directory.partialHomes')).toHaveLength(1);
        expect(screen.findHostByTestId('teams-directory-toggle-archived')).not.toBeNull();
    });

    it('shows one Team sign-in when a Team rule refuses the detail read beside a successful directory', async () => {
        const home = await memberHome(1);
        harness.answer(home, '/v1/teams/get', { status: 403, body: { error: 'team_authentication_required' } });
        openTeamHome = home;
        directoryWidth = 1440;

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(screen.findHostByTestId(`teams-row:${home}:team-0`)).not.toBeNull());
        await vi.waitFor(() => expect(screen.findHostByTestId('team-authentication-required')).not.toBeNull());
        expect(screen.findAllHostsByTestId('team-authentication-required-action')).toHaveLength(1);
        expect(screen.findHostByTestId(`teams-home-unavailable:${home}`)).toBeNull();
    });
});
