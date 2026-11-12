import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, createSessionListRenderableSessionFixture, flushHookEffects, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

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

const TEAM_GET_PATH = '/v1/teams/get';

async function renderOverview(serverId: string) {
    const { TeamOverviewScreen } = await import('./TeamOverviewScreen');
    return renderScreen(<TeamOverviewScreen serverId={serverId} teamId="team-1" />);
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
    // Modal is the host boundary. Reuse this fixture's person-choice controller
    // for both ordinary confirmations and the real Action review dialog.
    vi.mocked(Modal.show).mockReset().mockImplementation(config => {
        if (config.chrome?.kind === 'card' && config.chrome.testID === 'actions.confirmation-review.modal') {
            const props = config.props as { onAnswer(confirmed: boolean): void };
            queueMicrotask(() => { void Modal.confirm('Action review', '').then(props.onAnswer); });
        }
        return 'action-review';
    });
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
    setScreenSharingPrivacyActive(false);
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
    it('shows only the lab slice of retained Team sessions and opens each on its exact Home', async () => {
        const serverId = await addHome({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({ viewRoster: true }) });
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { tryWriteServerEnabledBitInPlace} = await import('@happier-dev/protocol/features/serverEnabledBit');
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const { storage } = await import('@/sync/domains/state/storage');
        const { buildSessionListFilterQueryHomes, resolveSessionListViewContextDefaults } = await import('@/components/sessions/shell/search/sessionListViewFilters');
        const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');
        const address = createTeamAddress(serverId, 'team-1');
        if (!address) throw new Error('team_fixture_address_invalid');
        const { defaults } = resolveSessionListViewContextDefaults({ kind: 'team', team: address }, [serverId], 'all');
        const [home] = buildSessionListFilterQueryHomes(defaults, { storage: 'active', includeInactive: !storage.getState().settings.hideInactiveSessions, mountedHomeServerIds: [serverId] });
        if (!home) throw new Error('team_query_fixture_invalid');
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-identity');
        const rows = ['session-a', 'session-b', 'session-c'].map((id, index) => createSessionListRenderableSessionFixture({ id, active: true, updatedAt: 30 - index, activeAt: 30 - index, metadata: { path: '/project', name: id } }));
        await (await import('react-test-renderer')).act(async () => {
            storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' });
            storage.getState().commitSessionListQueryMembership(home.queryKey, { serverId, accountId: 'account-ada', sessionIds: rows.map((row) => row.id), lastKnown: true });
        });
        await waitForTestId(screen, 'team-overview-session:session-a');
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-overview-session:session-b');
        expect(ids).not.toContain('team-overview-session:session-c');
        expect(ids).not.toContain('team-overview-sessions-empty');
        await (await import('react-test-renderer')).act(async () => {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic(serverId, 'session-a', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        const privateIds = collectRenderedTestIds(screen.tree.toJSON());
        expect(privateIds).not.toContain('team-overview-session:session-a');
        expect(privateIds).toContain('team-overview-session:session-c');
        await (await import('react-test-renderer')).act(async () => setScreenSharingPrivacyActive(false));
        await screen.pressByTestIdAsync('team-overview-session:session-a');
        expect(routerPush).toHaveBeenLastCalledWith(`/session/session-a?serverId=${encodeURIComponent(serverId)}`);
    });
    it('renders the shared-sessions reader state without inventing an empty list', async () => {
        const serverId = await addHome({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({ viewRoster: true }) });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-identity');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-overview-sessions-state');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-overview-sessions');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-overview-sessions-empty');
    });

    it.each([false, true])('mounts Team content and its readers only with viewTeam=%s', async (viewTeam) => {
        const serverId = await addHome({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({ viewTeam, viewRoster: viewTeam, leave: true }),
        }, { credentialResourcesEnabled: true });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-leave');
        await flushHookEffects();

        if (viewTeam) {
            await vi.waitFor(() => {
                expect(harness.requestsFor('/v1/teams/credential-resources/list').length).toBeGreaterThan(0);
                expect(harness.requestsFor('/v1/teams/members/list').length).toBeGreaterThan(0);
            });
        } else {
            expect(harness.requests.filter(({ path }) => path.startsWith('/v2/sessions') || path.startsWith('/v1/sessions'))).toHaveLength(0);
            expect(harness.requests.filter(({ path }) => path.startsWith('/v1/teams/') && path !== TEAM_GET_PATH)).toHaveLength(0);
        }

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-overview-identity');
        expect(ids).toContain('team-overview-home');
        expect(ids.includes('team-overview-sessions')).toBe(viewTeam);
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

    it('opens the ordinary Team Sessions destination with its exact Home-qualified address', async () => {
        const serverId = await addHome({
            name: 'Acme',
            logo: null,
            capabilities: teamCapabilitiesFixture({}),
        });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-sessions');

        screen.tree.root.findByProps({ testID: 'team-overview-sessions' }).props.onPress();

        expect(routerPush).toHaveBeenCalledWith(
            `/teams/team-1/sessions?serverId=${encodeURIComponent(serverId)}`,
        );
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
