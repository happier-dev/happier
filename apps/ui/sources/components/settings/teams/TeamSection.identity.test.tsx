import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Install the real Home transport harness before importing screens: the testkit
// barrel's agent catalog otherwise evaluates the transport before its boundary.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeAccountDetailFixture, homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { teamCapabilitiesFixture, teamGroupFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

// Keep the canonical list adapter real; the native recycler needs a device layout boundary.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

// Resolve the real owners during collection, after their transport boundary,
// so cold source transformation cannot spend a lifecycle test's deadline.
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
const { TeamSection } = await import('./TeamSection');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { TeamOverviewScreen } = await import('./TeamOverviewScreen');

const { AppPaneProvider: OverviewPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
/** The overview opens shared kinds in the app's details pane, so it mounts inside the app's pane provider. */
function InPanes(props: React.ComponentProps<typeof TeamOverviewScreen>) {
  return <OverviewPaneProvider><TeamOverviewScreen {...props} /></OverviewPaneProvider>;
}
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');
const { HomeAdministrationSection } = await import('../home/governance/HomeAdministrationSection');
const { TeamMemberDetailScreen } = await import('./members/TeamMemberDetailScreen');
const { TeamGroupDetailScreen } = await import('./groups/TeamGroupDetailScreen');
const { HomeAdministrationAccountScreen } = await import('../home/governance/HomeAdministrationAccountScreen');
const { HomeConsoleShell, HomeConsoleSidebar } = await import('../home/governance/HomeConsoleNavigation');

const TEAM_GET = '/v1/teams/get';
const HOME_GET = '/v1/home/governance/get';

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
    resetHomeGovernanceEngineForTests();
    await harness.reset();
});

afterEach(standardCleanup);

async function addHomes() {
    const target = await harness.addHome({ name: 'Research Home', serverUrl: 'https://research.example', accountId: 'viewer', teamsEnabled: true });
    const focused = await harness.addHome({ name: 'Personal Home', serverUrl: 'https://personal.example', accountId: 'viewer', teamsEnabled: true });
    const team = teamSummaryFixture({ name: 'Shared Team', capabilities: teamCapabilitiesFixture({}) });
    harness.answer(target, TEAM_GET, { body: team });
    harness.answer(focused, TEAM_GET, { body: team });
    harness.answer(target, HOME_GET, { body: homeGovernanceProjectionFixture() });
    return { target, focused };
}

describe('exact Home and Team header identity', () => {
    it.each([
        { body: { error: 'team_not_found' }, denied: true },
        { body: undefined, denied: false },
    ])('distinguishes revoked access from a missing Team route (denied=$denied)', async ({ body, denied }) => {
        const { target } = await addHomes();
        harness.answer(target, TEAM_GET, { status: 404, body });
        const screen = await renderScreen(
            <TeamSection serverId={target} teamId="team-1" title="Settings">{() => React.createElement('View', { testID: 'scope-ready' })}</TeamSection>,
        );
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('team-unavailable')).not.toBeNull());
        expect(screen.findByType(SurfaceStateCard).props.kind).toBe(denied ? 'unavailable' : 'error');
        expect(screen.findHostByTestId('scope-ready')).toBeNull();
    });

    it('keeps the saved Home overview addressed when a different Home is focused', async () => {
        const { target, focused } = await addHomes();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        expect(getActiveServerSnapshot().serverId).toBe(focused);
        const screen = await renderScreen(<InPanes serverId={target} teamId="team-1" />);

        await waitForHomeGovernance(() => expect(screen.findHostByTestId('team-overview-home')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Research Home');
        expect(screen.getTextContent()).toContain('Shared Team');
        expect(screen.getTextContent()).not.toContain('Personal Home');
        expect(harness.requestsFor(TEAM_GET).map((request) => request.serverId)).toEqual([target]);
        expect(getActiveServerSnapshot().serverId).toBe(focused);
    });

    it.each([false, true])('keeps a generic Team page qualified when native title chrome is %s', async (showsTitle) => {
        const { target, focused } = await addHomes();
        const page = (serverId: string) => (
            <NavigationTitleChromeProvider showsTitle={showsTitle}>
                <TeamSection serverId={serverId} teamId="team-1" title="Settings">{() => React.createElement('View', { testID: 'scope-ready' })}</TeamSection>
            </NavigationTitleChromeProvider>
        );
        const screen = await renderScreen(page(target));
        await waitForHomeGovernance(() => expect(harness.requestsFor(TEAM_GET).length).toBeGreaterThan(0));
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('scope-ready')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Shared Team');
        expect(screen.getTextContent()).toContain('Research Home');
        expect(screen.getTextContent()).not.toContain('Personal Home');

        await act(async () => screen.tree.update(page(focused)));
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Personal Home'));
        expect(screen.getTextContent()).toContain('Shared Team');
        expect(screen.getTextContent()).not.toContain('Research Home');
    });

    it.each(['team', 'home'] as const)('keeps the locally known Home on the %s page through loading and refusal', async (kind) => {
        const { target } = await addHomes();
        let release = () => {};
        const respondAfter = new Promise<void>((resolve) => { release = resolve; });
        const path = kind === 'team' ? TEAM_GET : HOME_GET;
        harness.answer(target, path, {
            status: 403,
            body: { error: kind === 'team' ? 'team_forbidden' : 'home_governance_forbidden' },
            respondAfter,
        });
        const screen = await renderScreen(
            <NavigationTitleChromeProvider showsTitle>
                {kind === 'team'
                    ? <TeamSection serverId={target} teamId="team-1" title="Settings">{() => null}</TeamSection>
                    : <HomeAdministrationSection serverId={target} title="People">{() => null}</HomeAdministrationSection>}
            </NavigationTitleChromeProvider>,
        );
        try {
            await waitForHomeGovernance(() => expect(harness.requestsFor(path)).toHaveLength(1));
            expect(screen.getTextContent()).toContain('Research Home');
        } finally {
            await act(async () => release());
        }
        await waitForHomeGovernance(() => expect(screen.findHostByTestId(kind === 'team' ? 'team-unavailable' : 'home-admin-unavailable')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Research Home');
        expect(screen.getTextContent()).not.toContain('Personal Home');
    });

    it.each(['member', 'group', 'account'] as const)('qualifies the %s entity header with the addressed scope', async (kind) => {
        const { target } = await addHomes();
        harness.answer(target, '/v1/teams/members/get', { body: teamMembershipFixture() });
        harness.answer(target, '/v1/teams/members/groups/list', { body: { items: [], nextCursor: null } });
        harness.answer(target, '/v1/teams/groups/get', { body: teamGroupFixture() });
        harness.answer(target, '/v1/teams/groups/members/list', { body: { items: [], nextCursor: null } });
        harness.answer(target, '/v1/home/accounts/get', { body: homeAccountDetailFixture('ada') });
        const screen = await renderScreen(
            <NavigationTitleChromeProvider showsTitle>
                {kind === 'member' ? <TeamMemberDetailScreen serverId={target} teamId="team-1" membershipId="membership-1" />
                    : kind === 'group' ? <TeamGroupDetailScreen serverId={target} teamId="team-1" groupId="group-1" />
                        : <HomeConsoleShell serverId={target} rail="people">
                            {/* The console navigation owns Home identity; the person header owns the person. */}
                            <HomeConsoleSidebar serverId={target} />
                            <HomeAdministrationAccountScreen serverId={target} accountId="ada" />
                        </HomeConsoleShell>}
            </NavigationTitleChromeProvider>,
        );
        const readyId = kind === 'member' ? 'team-member-identity' : kind === 'group' ? 'team-group-member-count' : 'home-account-role';
        await waitForHomeGovernance(() => expect(screen.findHostByTestId(readyId)).not.toBeNull());
        expect(screen.getTextContent()).toContain('Research Home');
        expect(screen.getTextContent()).not.toContain('Personal Home');
        if (kind !== 'account') expect(screen.getTextContent()).toContain('Shared Team');
    });
});
