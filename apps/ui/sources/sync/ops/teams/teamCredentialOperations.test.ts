import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runTeamAction, invalidateTeamCredentialResources } = vi.hoisted(() => ({
    runTeamAction: vi.fn(),
    invalidateTeamCredentialResources: vi.fn(),
}));

vi.mock('./teamActionClient', () => ({ runTeamAction }));
vi.mock('@/sync/store/teams/teamsSnapshots', () => ({ invalidateTeamCredentialResources }));

describe('teamCredentialOperations outcome recovery', () => {
    beforeEach(() => vi.clearAllMocks());

    it('invalidates the canonical resource projection when a mutation outcome is unknown', async () => {
        runTeamAction.mockResolvedValueOnce({
            kind: 'failed',
            failure: { kind: 'outcome_unknown', retryable: true, code: null },
        });
        const { updateTeamCredentialResource } = await import('./teamCredentialOperations');
        const scope = { serverId: 'home-a', accountId: 'account-a' } as const;
        const address = { serverId: 'home-a', teamId: 'team-a' } as const;

        await expect(updateTeamCredentialResource({
            scope,
            address,
            resourceId: 'resource-a',
            expectedRevision: 3,
            enabled: false,
        })).resolves.toEqual({
            kind: 'failed',
            failure: { kind: 'outcome_unknown', retryable: true, code: null },
        });
        expect(invalidateTeamCredentialResources).toHaveBeenCalledWith(scope, address, 'resource-a');
    });

    it('carries an exact surface confirmation through a destructive resource mutation', async () => {
        runTeamAction.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resourceId: 'resource-a', revision: 4 },
        });
        const { deleteTeamCredentialResource } = await import('./teamCredentialOperations');

        await deleteTeamCredentialResource({
            scope: { serverId: 'home-a', accountId: 'account-a' },
            address: { serverId: 'home-a', teamId: 'team-a' },
            resourceId: 'resource-a',
            expectedRevision: 3,
            confirmedByPresentUser: true,
        });

        expect(runTeamAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'teams.credentials.delete',
            approval: 'surface_confirmed',
        }));
    });

    it('sends the complete editor replacement as one fenced update intent', async () => {
        runTeamAction.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resourceId: 'resource-a', revision: 4 },
        });
        const { updateTeamCredentialResource } = await import('./teamCredentialOperations');
        const replacement = {
            enabled: true,
            displayName: 'Shared provider',
            sessionUsePolicy: 'team_context_required' as const,
            requestPolicy: null,
            allMembersAllowedRoutes: ['brokered' as const],
            groupGrants: [],
            memberGrants: [],
            usageLimitDelta: { upserts: [], deleteIds: ['limit-a'] },
        };

        await updateTeamCredentialResource({
            scope: { serverId: 'home-a', accountId: 'account-a' },
            address: { serverId: 'home-a', teamId: 'team-a' },
            resourceId: 'resource-a',
            expectedRevision: 3,
            replacement,
        });

        expect(runTeamAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'teams.credentials.update',
            input: { resourceId: 'resource-a', expectedRevision: 3, replacement },
        }));
    });

    it.each([
        ['teams.credentials.limits.delete', async (operations: typeof import('./teamCredentialOperations')) => operations.deleteTeamCredentialUsageLimit({
            scope: { serverId: 'home-a', accountId: 'account-a' },
            address: { serverId: 'home-a', teamId: 'team-a' },
            resourceId: 'resource-a', expectedRevision: 3, limitId: 'limit-a', confirmedByPresentUser: true,
        })],
        ['teams.credentials.externalKeys.revoke', async (operations: typeof import('./teamCredentialOperations')) => operations.revokeTeamCredentialExternalApiKey({
            scope: { serverId: 'home-a', accountId: 'account-a' },
            resourceId: 'resource-a', keyId: 'key-a', confirmedByPresentUser: true,
        })],
        ['teams.credentials.externalKeys.revokeAll', async (operations: typeof import('./teamCredentialOperations')) => operations.revokeAllTeamCredentialExternalApiKeys({
            scope: { serverId: 'home-a', accountId: 'account-a' },
            resourceId: 'resource-a', confirmedByPresentUser: true,
        })],
    ] as const)('carries an exact surface confirmation through %s', async (actionId, invoke) => {
        runTeamAction.mockResolvedValueOnce({ kind: 'succeeded', value: {} });
        await invoke(await import('./teamCredentialOperations'));
        expect(runTeamAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId,
            approval: 'surface_confirmed',
        }));
    });
});
