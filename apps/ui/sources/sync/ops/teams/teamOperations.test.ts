import { describe, expect, it, vi } from 'vitest';

const runTeamActionMock = vi.hoisted(() => vi.fn());
const applyTeamProjectionMock = vi.hoisted(() => vi.fn());

vi.mock('./teamActionClient', () => ({
    runTeamAction: runTeamActionMock,
}));
vi.mock('@/sync/store/teams/teamsSnapshots', () => ({
    applyTeamProjection: applyTeamProjectionMock,
}));

import {
    archiveTeam,
    removeTeamLogo,
    restoreTeam,
    setTeamLogo,
    setTeamPolicy,
} from './teamOperations';

const TEAM = {
    id: 'team-1',
    name: 'Team',
    description: null,
    logo: null,
    archivedAt: null,
    policy: {
        v: 1 as const,
        sessionCreationPolicy: 'private_default' as const,
        externalSharingPolicy: 'allowed' as const,
        defaultSessionHistoryAccess: 'from_membership' as const,
        admissionMode: 'invite_only' as const,
        authenticationPolicy: null,
    },
    viewerRole: 'owner' as const,
    capabilities: {
        viewTeam: true,
        viewRoster: true,
        manageSettings: true,
        managePolicy: true,
        manageMembers: true,
        manageGroups: true,
        manageInvitations: true,
        manageOwners: true,
        manageAuthentication: true,
        archiveTeam: true,
        restoreTeam: false,
        leave: false,
    },
    admission: { historyChoice: { admin: 'choice' as const, member: 'choice' as const, guest: 'hidden' as const } },
    counts: null,
};

type TeamLifecycleConfirmationFixture = Parameters<typeof archiveTeam>[0];

describe('Team lifecycle and logo mutations', () => {
    // Each case carries its own invocation: `it.each` does not correlate the
    // operation with its arguments, so a shared argument object would have to
    // satisfy every operation's input at once.
    it.each([
        ['archive', async (confirmation: TeamLifecycleConfirmationFixture) => { await archiveTeam(confirmation); }],
        ['restore', async (confirmation: TeamLifecycleConfirmationFixture) => { await restoreTeam(confirmation); }],
        ['set logo', async (confirmation: TeamLifecycleConfirmationFixture) => {
            await setTeamLogo({ ...confirmation, image: { mimeType: 'image/png', dataBase64: 'aGVsbG8=' } });
        }],
        ['remove logo', async (confirmation: TeamLifecycleConfirmationFixture) => { await removeTeamLogo(confirmation); }],
    ] as const)('leaves %s approval policy to the shared Action front door', async (_name, invoke) => {
        runTeamActionMock.mockResolvedValueOnce({ kind: 'succeeded', value: TEAM });

        const legacySurfaceConfirmation = {
            scope: { serverId: 'home-1', accountId: 'account-1' },
            address: { serverId: 'home-1', teamId: 'team-1' },
            confirmedByPresentUser: true as const,
        };
        await invoke(legacySurfaceConfirmation);

        expect(runTeamActionMock).toHaveBeenCalledWith(expect.not.objectContaining({
            approval: expect.anything(),
        }));
    });
});

describe('setTeamPolicy', () => {
    it('forwards the canonical authentication prior value and replacement as one policy patch', async () => {
        const team = {
            id: 'team-1',
            name: 'Team',
            description: null,
            logo: null,
            archivedAt: null,
            policy: {
                v: 1,
                sessionCreationPolicy: 'private_default',
                externalSharingPolicy: 'allowed',
                defaultSessionHistoryAccess: 'from_membership',
                admissionMode: 'invite_only',
                authenticationPolicy: null,
            },
            viewerRole: 'owner',
            capabilities: {
                viewTeam: true,
                viewRoster: true,
                manageSettings: true,
                managePolicy: true,
                manageMembers: true,
                manageGroups: true,
                manageInvitations: true,
                manageOwners: true,
                manageAuthentication: true,
                archiveTeam: true,
                restoreTeam: false,
                leave: false,
            },
            admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
            counts: null,
        };
        runTeamActionMock.mockResolvedValueOnce({ kind: 'succeeded', value: team });

        await setTeamPolicy({
            scope: { serverId: 'home-1', accountId: 'account-1' },
            address: { serverId: 'home-1', teamId: 'team-1' },
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: 'restricted',
                accepted: [{ kind: 'home_method', methodId: 'email_password' }],
            },
        });

        expect(runTeamActionMock).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'teams.policy.set',
            input: {
                v: 1,
                teamId: 'team-1',
                previousAuthenticationPolicy: null,
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [{ kind: 'home_method', methodId: 'email_password' }],
                },
            },
        }));
    });

    it('forwards the canonical repair basis so a malformed stored policy can be replaced', async () => {
        const team = {
            id: 'team-1',
            name: 'Team',
            description: null,
            logo: null,
            archivedAt: null,
            recovery: null,
            policy: {
                v: 1,
                sessionCreationPolicy: 'private_default',
                externalSharingPolicy: 'allowed',
                defaultSessionHistoryAccess: 'from_membership',
                admissionMode: 'invite_only',
                authenticationPolicy: null,
                authenticationPolicyStatus: 'available',
            },
            viewerRole: 'owner',
            capabilities: {
                viewTeam: true,
                viewRoster: true,
                manageSettings: true,
                managePolicy: true,
                manageMembers: true,
                manageGroups: true,
                manageInvitations: true,
                manageOwners: true,
                manageAuthentication: true,
                archiveTeam: true,
                restoreTeam: false,
                leave: false,
            },
            admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
            counts: null,
        };
        runTeamActionMock.mockResolvedValueOnce({ kind: 'succeeded', value: team });

        await setTeamPolicy({
            scope: { serverId: 'home-1', accountId: 'account-1' },
            address: { serverId: 'home-1', teamId: 'team-1' },
            previousAuthenticationPolicy: { v: 1, status: 'repair_required' },
            authenticationPolicy: { v: 1, mode: 'inherit' },
        });

        expect(runTeamActionMock).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'teams.policy.set',
            input: {
                v: 1,
                teamId: 'team-1',
                previousAuthenticationPolicy: { v: 1, status: 'repair_required' },
                authenticationPolicy: { v: 1, mode: 'inherit' },
            },
        }));
    });
});
