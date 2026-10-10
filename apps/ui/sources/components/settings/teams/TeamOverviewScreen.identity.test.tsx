import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
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

async function addHome(team: Parameters<typeof teamSummaryFixture>[0]): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
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
    it('confirms leave for a non-manager, removes the Team from the directory and returns there', async () => {
        const serverId = await addHome({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({ leave: true }) });
        const { Modal } = await import('@/modal');
        const confirm = vi.spyOn(Modal, 'confirm');
        confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        harness.answer(serverId, '/v1/teams/members/leave', { body: { status: 'removed', membershipId: 'membership-1' } });
        harness.answer(serverId, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-leave');
        await screen.pressByTestIdAsync('team-overview-leave');
        expect(harness.requestsFor('/v1/teams/members/leave')).toHaveLength(0);
        expect(routerReplace).not.toHaveBeenCalled();
        harness.answer(serverId, TEAM_GET_PATH, { status: 403, body: { error: 'team_forbidden' } });
        await screen.pressByTestIdAsync('team-overview-leave');
        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/settings/teams'));
        expect(confirm).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ destructive: true }));
        expect(harness.requestsFor('/v1/teams/members/leave')[0]?.input).toEqual({ v: 1, teamId: 'team-1' });
        expect(harness.requestsFor('/v1/artifacts')).toHaveLength(0);
        const { getTeamsDirectorySnapshot } = await import('@/sync/store/teams/teamsSnapshots');
        const { teamDirectoryQueryKeyV1 } = await import('@happier-dev/protocol/teams');
        expect(getTeamsDirectorySnapshot({ serverId, accountId: 'account-ada' }, teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' }))?.data).toEqual([]);
    });

    it('finishes leave after deferred UI approval without redispatching', async () => {
        const serverId = await addHome({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({ leave: true }) });
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        await harness.requireUiApproval(serverId, 'teams.members.leave');
        harness.answer(serverId, '/v1/teams/members/leave', { body: { status: 'removed', membershipId: 'membership-1' } });
        harness.answer(serverId, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-leave');
        await screen.pressByTestIdAsync('team-overview-leave');
        await waitForTestId(screen, 'team-approval');
        expect(harness.requestsFor('/v1/teams/members/leave')).toHaveLength(0);
        expect(routerReplace).not.toHaveBeenCalled();
        const create = harness.requestsFor('/v1/artifacts').find((request) => {
            const input = request.input;
            return input !== null && typeof input === 'object' && 'id' in input;
        });
        const input = create?.input;
        if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') {
            throw new Error('leave_approval_artifact_missing');
        }
        await expect(decideApprovalAsInbox(serverId, input.id, 'approve')).resolves.toMatchObject({ ok: true });
        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/settings/teams'));
        expect(harness.requestsFor('/v1/teams/members/leave')).toHaveLength(1);
        expect(routerReplace).toHaveBeenCalledTimes(1);
    });

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
