import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

import {
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamGroupFixture,
    teamMembershipFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        // The transfer is confirmed once; these cases are about what happens
        // after the manager says yes.
        return createModalModuleMock({ confirmResult: true }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const MEMBER_GET_PATH = '/v1/teams/members/get';
const MEMBER_GROUPS_PATH = '/v1/teams/members/groups/list';
const MEMBER_ROLE_SET_PATH = '/v1/teams/members/role/set';
const MEMBER_SUSPEND_PATH = '/v1/teams/members/suspend';
const MANAGEMENT_SET_PATH = '/v1/teams/members/management/set';
const DIRECTORY_SOURCES_PATH = '/v1/teams/team-1/directory-sources';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

const NO_MEMBER_CAPABILITIES = {
    setRole: false,
    assignableRoles: [],
    suspend: false,
    reactivate: false,
    remove: false,
    setManagement: false,
};

function directorySource(id: string, displayName: string) {
    return {
        v: 1 as const,
        id,
        teamId: 'team-1',
        kind: 'workos_directory' as const,
        displayName,
        state: 'active' as const,
        allowedActions: [],
        sync: {
            mode: 'events_and_full' as const,
            attempt: 'succeeded' as const,
            freshness: 'fresh' as const,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFullReconcileAt: null,
            nextScheduledAt: null,
        },
        error: null,
    };
}

async function renderDetail(serverId: string) {
    const { TeamMemberDetailScreen } = await import('./TeamMemberDetailScreen');
    return renderScreen(
        <TeamMemberDetailScreen serverId={serverId} teamId="team-1" membershipId="membership-1" />,
    );
}

async function addHome(team: ReturnType<typeof teamSummaryFixture>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, { body: team });
    harness.answer(serverId, MEMBER_GROUPS_PATH, { body: { items: [], nextCursor: null } });
    harness.answer(serverId, ARTIFACT_CREATE_PATH, {
        body: {
            id: 'artifact-approval',
            header: '',
            body: '',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: 1,
            bodyVersion: 1,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
        },
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderDetail>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('TeamMemberDetailScreen management source', () => {
    it('opens the exact identity connection that owns a JIT-managed lifetime', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageAuthentication: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                management: {
                    kind: 'identity_connection',
                    identityConnectionId: 'connection-sso',
                    label: 'Acme SSO',
                },
            }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-open-source');
        await screen.pressByTestIdAsync('team-member-open-source');

        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/authentication/connection-sso`,
        );
    });

    it('withholds the transfer when the Home says this membership cannot be converted', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageAuthentication: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ capabilities: NO_MEMBER_CAPABILITIES }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-identity');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-member-management');
        await act(async () => {
            await Promise.resolve();
        });
        expect(harness.requestsFor(DIRECTORY_SOURCES_PATH)).toHaveLength(0);
    });

    it('transfers to the exact source the manager chose', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageAuthentication: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, setManagement: true },
            }),
        });
        harness.answer(serverId, DIRECTORY_SOURCES_PATH, {
            body: {
                items: [directorySource('source-okta', 'Okta'), directorySource('source-entra', 'Entra ID')],
                nextCursor: null,
            },
        });
        harness.answer(serverId, MANAGEMENT_SET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, setManagement: true },
                management: {
                    kind: 'directory_source',
                    directorySourceId: 'source-entra',
                    label: 'Entra ID',
                },
            }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-management');

        await waitForTestId(screen, 'team-member-management:source-entra');
        await screen.pressByTestIdAsync('team-member-management:source-entra');

        await vi.waitFor(() => {
            expect(harness.requestsFor(MANAGEMENT_SET_PATH)).toHaveLength(1);
        });
        expect(harness.requestsFor(MANAGEMENT_SET_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            membershipId: 'membership-1',
            // The exact source, never a vague "manage externally".
            management: { kind: 'directory_source', directorySourceId: 'source-entra' },
        });
    });

    it('explains a refused conversion in the Home\'s own terms rather than as a generic failure', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageAuthentication: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, setManagement: true },
            }),
        });
        harness.answer(serverId, DIRECTORY_SOURCES_PATH, {
            body: { items: [directorySource('source-okta', 'Okta')], nextCursor: null },
        });
        harness.answer(serverId, MANAGEMENT_SET_PATH, {
            status: 409,
            body: { error: 'management_conflict' },
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-management');
        await waitForTestId(screen, 'team-member-management:source-okta');
        await screen.pressByTestIdAsync('team-member-management:source-okta');

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.members.managementConflict');
        });
        expect(screen.getTextContent()).not.toContain('teams.errors.generic');
    });

    it('offers a return to native management for an externally owned lifetime', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageAuthentication: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, setManagement: true },
                management: {
                    kind: 'directory_source',
                    directorySourceId: 'source-okta',
                    label: 'Okta',
                },
            }),
        });
        harness.answer(serverId, MANAGEMENT_SET_PATH, { body: teamMembershipFixture() });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-management');

        // The source that owns this lifetime is reachable from here.
        screen.pressByTestId('team-member-open-source');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/authentication/directory/source-okta`,
        );

        await screen.pressByTestIdAsync('team-member-management:native');

        await vi.waitFor(() => {
            expect(harness.requestsFor(MANAGEMENT_SET_PATH)).toHaveLength(1);
        });
        expect(harness.requestsFor(MANAGEMENT_SET_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            membershipId: 'membership-1',
            management: { kind: 'native' },
        });
    });
});

describe('TeamMemberDetailScreen current membership', () => {
    it('refreshes the point detail for the exact Home Team AccountChange', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ status: 'active' }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-identity');
        // An active membership is the quiet state: nothing on the page says "suspended".
        expect(screen.getTextContent()).not.toContain('teams.status.suspended');

        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                status: 'suspended',
                capabilities: {
                    ...NO_MEMBER_CAPABILITIES,
                    reactivate: true,
                },
            }),
        });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol');

        publishHomeAccountChange('another-home', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        publishHomeAccountChange(serverId, ['home-governance']);
        await Promise.resolve();
        expect(harness.requestsFor(MEMBER_GET_PATH)).toHaveLength(1);

        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        await waitForTestId(screen, 'team-member-reactivate');
        expect(harness.requestsFor(MEMBER_GET_PATH)).toHaveLength(2);
    });

    it('says a suspended membership is suspended at the head of the page, without also saying Active', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ status: 'suspended' }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-status');

        expect(screen.getTextContent()).toContain('teams.status.suspended');
        expect(screen.getTextContent()).not.toContain('teams.status.active');
    });

    it('preserves the last-known member and offers retry when a refresh cannot reach the Home', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture(),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-identity');

        harness.answer(serverId, MEMBER_GET_PATH, { status: 503, body: { error: 'unavailable' } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol');
        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });

        await waitForTestId(screen, 'team-member-retry');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-member-identity');
        expect(screen.getTextContent()).toContain('teams.unavailable.offline');
    });

    it('withdraws the last-known member after an authoritative access refusal', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, { body: teamMembershipFixture() });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-identity');

        harness.answer(serverId, MEMBER_GET_PATH, { status: 403, body: { error: 'forbidden' } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol');
        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });

        await waitForTestId(screen, 'team-member-unavailable');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-member-identity');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-member-retry');
        expect(screen.getTextContent()).toContain('teams.errors.forbidden');
    });

});

describe('TeamMemberDetailScreen role picker', () => {
    it('exposes role choices as one radio group with checked state', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageOwners: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                role: 'member',
                capabilities: { ...NO_MEMBER_CAPABILITIES, setRole: true, assignableRoles: ['owner', 'admin', 'member', 'guest'] },
            }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-role:member');

        const selected = screen.findByTestId('team-member-role:member');
        expect([selected?.props.accessibilityRole, selected?.props.role]).toContain('radio');
        expect(selected?.props.accessibilityState).toMatchObject({ checked: true });

        let ancestor = selected?.parent ?? null;
        while (ancestor
            && ancestor.props.accessibilityRole !== 'radiogroup'
            && ancestor.props.role !== 'radiogroup') {
            ancestor = ancestor.parent;
        }
        expect(ancestor).not.toBeNull();
        expect(ancestor?.props.accessibilityLabel ?? ancestor?.props['aria-label']).toBe('teams.members.roleLabel');
    });

    it('withholds owner from an admin the Home has not given owner authority', async () => {
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'admin',
            capabilities: teamCapabilitiesFixture({ manageMembers: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, setRole: true, assignableRoles: ['admin', 'member', 'guest'] },
            }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-role:member');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-member-role:owner');
        expect(ids).toContain('team-member-role:admin');
        expect(ids).toContain('team-member-role:guest');
        // The withheld control is explained rather than silently missing.
        expect(screen.getTextContent()).toContain('teams.members.ownerOnlyAction');
    });

    it('offers only owner on the narrow Home owner-required recovery path', async () => {
        const serverId = await addHome(teamSummaryFixture({
            recovery: { kind: 'owner_required', canAppointOwner: true },
            viewerRole: null,
            // A Home administrator: readable, no Team membership authority.
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, setRole: true, assignableRoles: ['owner'] },
            }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-role:owner');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-member-role:admin');
        expect(ids).not.toContain('team-member-role:member');
        expect(ids).not.toContain('team-member-role:guest');
    });

    it('offers no roles when the server projects an empty role choice', async () => {
        const serverId = await addHome(teamSummaryFixture({
            recovery: { kind: 'owner_required', canAppointOwner: false },
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({ viewTeam: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, setRole: false },
            }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-identity');

        expect(collectRenderedTestIds(screen.tree.toJSON())
            .filter((id) => id.startsWith('team-member-role:'))).toEqual([]);
    });

    it('offers no role control at all when the Home withholds setRole', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageOwners: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ capabilities: NO_MEMBER_CAPABILITIES }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-identity');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.filter((id) => id.startsWith('team-member-role:'))).toEqual([]);
    });

    it('reports a refused role change in the Home\'s own terms instead of failing silently', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageOwners: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                role: 'owner',
                capabilities: { ...NO_MEMBER_CAPABILITIES, setRole: true, assignableRoles: ['owner', 'admin', 'member', 'guest'] },
            }),
        });
        harness.answer(serverId, MEMBER_ROLE_SET_PATH, {
            status: 409,
            body: { error: 'team_owner_transfer_required' },
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-role:member');
        await screen.pressByTestIdAsync('team-member-role:member');

        await vi.waitFor(() => {
            expect(harness.requestsFor(MEMBER_ROLE_SET_PATH)).toHaveLength(1);
        });
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.members.lastOwnerBlocked');
        });
        // The refused member is still the Home's truth, not a blank or a lie.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-member-identity');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-member-notice');
    });

    it('reports a refused suspension without losing the loaded member', async () => {
        const serverId = await addHome(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageMembers: true, manageOwners: true }),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({
                capabilities: { ...NO_MEMBER_CAPABILITIES, suspend: true },
            }),
        });
        harness.answer(serverId, MEMBER_SUSPEND_PATH, {
            status: 409,
            body: { error: 'team_owner_transfer_required' },
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-suspend');
        await screen.pressByTestIdAsync('team-member-suspend');

        await vi.waitFor(() => {
            expect(harness.requestsFor(MEMBER_SUSPEND_PATH)).toHaveLength(1);
        });
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.members.lastOwnerBlocked');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-member-identity');
    });
});

describe('TeamMemberDetailScreen effective Groups', () => {
    it.each([
        { status: 403, label: 'teams.errors.forbidden' },
        { status: 404, label: 'teams.unavailable.updateRequired' },
    ])('explains an initial Group read refusal ($status) without offering an ineffective retry', async ({ status, label }) => {
        const serverId = await addHome(teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ capabilities: NO_MEMBER_CAPABILITIES }),
        });
        harness.answer(serverId, MEMBER_GROUPS_PATH, { status });

        const screen = await renderDetail(serverId);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(label));

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-member-identity');
        expect(ids).not.toContain('team-member-groups-retry');
        expect(ids).not.toContain('team-member-groups-empty');
        expect(screen.getTextContent()).not.toContain('teams.unavailable.offline');
    });

    it('recovers an initial transient Group read failure and retains loaded Groups when the next page fails', async () => {
        const serverId = await addHome(teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ capabilities: NO_MEMBER_CAPABILITIES }),
        });
        harness.answer(serverId, MEMBER_GROUPS_PATH, { status: 503 });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-groups-retry');
        expect(screen.getTextContent()).toContain('teams.unavailable.offline');

        harness.answer(serverId, MEMBER_GROUPS_PATH, {
            body: { items: [teamGroupFixture({ id: 'group-infra' })], nextCursor: 'next-page' },
        });
        await screen.pressByTestIdAsync('team-member-groups-retry');
        await waitForTestId(screen, 'team-member-group:group-infra');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-member-groups-retry');

        harness.answer(serverId, MEMBER_GROUPS_PATH, { status: 503 });
        await screen.pressByTestIdAsync('team-member-groups-load-more');
        await waitForTestId(screen, 'team-member-groups-retry');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-member-group:group-infra');
        expect(screen.getTextContent()).toContain('teams.unavailable.offline');
    });

    it('reads the membership\'s own Groups and opens one at its exact address', async () => {
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ capabilities: NO_MEMBER_CAPABILITIES }),
        });
        harness.answer(serverId, MEMBER_GROUPS_PATH, {
            body: { items: [teamGroupFixture({ id: 'group-infra', name: 'Infrastructure' })], nextCursor: null },
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-group:group-infra');

        // Addressed by the membership lifetime, never by Account.
        expect(harness.requestsFor(MEMBER_GROUPS_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            membershipId: 'membership-1',
        });

        screen.pressByTestId('team-member-group:group-infra');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/groups/group-infra`,
        );
    });

    it('says the membership is in no Groups only once the Home has answered', async () => {
        const serverId = await addHome(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
        }));
        harness.answer(serverId, MEMBER_GET_PATH, {
            body: teamMembershipFixture({ capabilities: NO_MEMBER_CAPABILITIES }),
        });

        const screen = await renderDetail(serverId);
        await waitForTestId(screen, 'team-member-groups-empty');
        expect(screen.getTextContent()).toContain('teams.members.detailGroupsEmpty');
    });
});
