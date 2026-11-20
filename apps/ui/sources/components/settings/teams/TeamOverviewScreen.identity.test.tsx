import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';

import { collectRenderedTestIds, flushHookEffects, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    // Approval publication and its mounted continuation observe one real store.
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn(), replace: routerReplace }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { TeamOverviewScreen } = await import('./TeamOverviewScreen');

const { AppPaneProvider: OverviewPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
/** The overview opens shared kinds in the app's details pane, so it mounts inside the app's pane provider. */
function InPanes(props: React.ComponentProps<typeof TeamOverviewScreen>) {
  return <OverviewPaneProvider><TeamOverviewScreen {...props} /></OverviewPaneProvider>;
}

const TEAM_GET_PATH = '/v1/teams/get';

async function renderOverview(serverId: string) {
    return renderScreen(<InPanes serverId={serverId} teamId="team-1" />);
}

async function addHome(team: Parameters<typeof teamSummaryFixture>[0], options?: Readonly<{ credentialResourcesEnabled?: boolean }>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: options?.credentialResourcesEnabled,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, { body: teamSummaryFixture(team) });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderOverview>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
    routerReplace.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('TeamOverviewScreen Team identity', () => {
    it('offers Invite only in the setup step while the Team is new', async () => {
        const serverId = await addHome({
            capabilities: teamCapabilitiesFixture({ manageInvitations: true, manageAuthentication: true }),
            counts: { members: 1, suspendedMembers: 0, waitingInvitations: 0, groups: 0 },
        });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-setup-invite-action');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-overview-invite');
    });
    it.each([false, true])('mounts Team content and its readers only with viewTeam=%s', async (viewTeam) => {
        const serverId = await addHome({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({ viewTeam, viewRoster: viewTeam, leave: true }),
        }, { credentialResourcesEnabled: true });
        const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, {
            v: 1,
            teamId: 'team-1',
        });
        harness.answer(serverId, summary.path, {
            body: { teamId: 'team-1', kinds: [{ kind: 'sessions', status: 'available', count: 2 }] },
        });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-leave');
        await flushHookEffects();

        if (viewTeam) {
            await waitForTestId(screen, 'team-overview-shared:sessions');
            await vi.waitFor(() => {
                expect(harness.requestsFor('/v1/teams/members/list').length).toBeGreaterThan(0);
            });
            expect(harness.requestsFor(summary.path)).toHaveLength(1);
        } else {
            expect(harness.requests.filter(({ path }) => path.startsWith('/v1/teams/') && path !== TEAM_GET_PATH)).toHaveLength(0);
        }
        expect(harness.requests.filter(({ path }) =>
            path.startsWith('/v2/sessions') || path.startsWith('/v1/sessions'),
        )).toHaveLength(0);
        expect(harness.requestsFor('/v1/teams/credential-resources/list')).toHaveLength(0);

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-overview-identity');
        expect(ids).toContain('team-overview-home');
        expect(ids.includes('team-overview-shared:sessions')).toBe(viewTeam);
        expect(ids.includes('team-overview-members')).toBe(viewTeam);
        expect(ids.includes('team-overview-groups')).toBe(viewTeam);
        expect(ids).not.toContain('team-overview-setup');
        const { t } = await import('@/text');
        expect(screen.getTextContent().includes(t('teams.overview.teamSection'))).toBe(viewTeam);
    });
    it.each([false, true])('names the viewer\'s real standing: suspended when only Leave is left, otherwise their role (viewTeam=%s)', async (viewTeam) => {
        const serverId = await addHome({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({ viewTeam, viewRoster: viewTeam, leave: true }),
        });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-leave');
        const { t } = await import('@/text');
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        const header = screen.getTextContent();
        expect(ids.includes('team-overview-suspended')).toBe(!viewTeam);
        expect(header.includes(t('teams.status.suspended'))).toBe(!viewTeam);
        expect(header.includes(t('teams.role.member'))).toBe(viewTeam);
        expect(header.includes(t('teams.overview.suspendedBody'))).toBe(!viewTeam);
    });
    it.each([false, true])('confirms an explicit Ask leave locally and returns to the directory with viewTeam=%s', async (viewTeam) => {
        const serverId = await addHome({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({ viewTeam, viewRoster: viewTeam, leave: true }) });
        await harness.requireUiApproval(serverId, 'teams.members.leave');
        const { Modal } = await import('@/modal');
        const confirm = vi.spyOn(Modal, 'confirm');
        confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        harness.answer(serverId, '/v1/teams/members/leave', { body: { status: 'removed', membershipId: 'membership-1' } });
        harness.answer(serverId, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-leave');
        await screen.pressByTestIdAsync('team-overview-leave');
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(screen.findByTestId('team-overview-leave')?.props.accessibilityState?.busy).toBe(false));
        expect(harness.requestsFor('/v1/teams/members/leave')).toHaveLength(0);
        expect(routerReplace).not.toHaveBeenCalled();
        harness.answer(serverId, TEAM_GET_PATH, { status: 403, body: { error: 'team_forbidden' } });
        await screen.pressByTestIdAsync('team-overview-leave');
        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/settings/teams'));
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(harness.requestsFor('/v1/teams/members/leave')[0]?.input).toEqual({ v: 1, teamId: 'team-1' });
        expect(harness.requestsFor('/v1/artifacts')).toHaveLength(0);
        const { getTeamsDirectorySnapshot } = await import('@/sync/store/teams/teamsSnapshots');
        const { teamDirectoryQueryKeyV1 } = await import('@happier-dev/protocol/teams');
        expect(getTeamsDirectorySnapshot({ serverId, accountId: 'account-ada' }, teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' }))?.data).toEqual([]);
    });

    // Own-UI Ask approval is local; both visible and suspended leave journeys above
    // keep the decline, once-only dispatch and final navigation coverage.

    it.each([{ leave: false }, { leave: true, manageMembers: true }])('withholds Overview leave when not projected or for a manager: %j', async (capabilities) => {
        const serverId = await addHome({ capabilities: teamCapabilitiesFixture(capabilities) });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-identity');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-overview-leave');
    });

    it('renders the Team logo the Home published, not a name-derived stand-in', async () => {
        const serverId = await addHome({
            name: 'Acme',
            logo: {
                path: 'public/teams/team-1/logo.png',
                url: 'https://home-a.example/logo.png',
                thumbhash: 'abc',
            },
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-identity');

        // The Home's own logo reaches the avatar owner. A Team that has one must
        // show it here exactly as the directory row and the join screen do.
        expect(JSON.stringify(screen.tree.toJSON()))
            .toContain('https://home-a.example/logo.png');
    });

    it('still anchors on Team identity when the Home published no logo', async () => {
        const serverId = await addHome({
            name: 'Acme',
            logo: null,
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-identity');

        // No logo is not "no identity": the shared avatar owner derives a
        // monogram and accent from the immutable Team id, so the row is still a
        // recognizable Team rather than an unbranded line of text.
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-overview-identity');
        expect(ids).toContain('team-overview-home');
        // Nothing fabricates an image URL when the Home published none.
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('logo.png');
    });

    it('shows owner-required recovery and routes an authorized Home administrator to the roster', async () => {
        const serverId = await addHome({
            name: 'Acme',
            logo: null,
            capabilities: teamCapabilitiesFixture({}),
            recovery: { kind: 'owner_required', canAppointOwner: true },
        });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-owner-required-choose');

        await screen.pressByTestIdAsync('team-owner-required-choose');

        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/members`,
        );
    });

    it('shows the owner-required fact without offering recovery to an unauthorized viewer', async () => {
        const serverId = await addHome({
            name: 'Acme',
            logo: null,
            capabilities: teamCapabilitiesFixture({}),
            recovery: { kind: 'owner_required', canAppointOwner: false },
        });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-owner-required');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-owner-required-choose');
    });
});
