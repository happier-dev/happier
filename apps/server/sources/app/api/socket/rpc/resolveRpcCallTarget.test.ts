import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionFindUnique = vi.hoisted(() => vi.fn());
const canApprovePermissions = vi.hoisted(() => vi.fn());

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findUnique: (...args: unknown[]) => sessionFindUnique(...args),
        },
    },
}));

vi.mock('@/app/share/accessControl', () => ({
    canApprovePermissions: (...args: unknown[]) => canApprovePermissions(...args),
}));

import { resolveRpcCallTarget } from './resolveRpcCallTarget';

describe('resolveRpcCallTarget', () => {
    beforeEach(() => {
        sessionFindUnique.mockReset();
        canApprovePermissions.mockReset();
        sessionFindUnique.mockResolvedValue({ accountId: 'session-owner' });
        canApprovePermissions.mockResolvedValue(false);
    });

    it('applies the shared-approver gate to the modern session.permission.respond RPC', async () => {
        await expect(resolveRpcCallTarget({
            callerUserId: 'shared-user',
            method: 'session-1:session.permission.respond',
        })).resolves.toEqual({ type: 'forbidden' });

        expect(sessionFindUnique).toHaveBeenCalledWith({
            where: { id: 'session-1' },
            select: { accountId: true },
        });
        expect(canApprovePermissions).toHaveBeenCalledWith('shared-user', 'session-1');
    });

    it('stamps the owner actor only after resolving the exact modern permission route', async () => {
        await expect(resolveRpcCallTarget({
            callerUserId: 'session-owner',
            method: 'session-1:session.permission.respond',
        })).resolves.toEqual({
            type: 'target',
            targetUserId: 'session-owner',
            permissionRespondAuthorization: {
                kind: 'session.permission.respond',
                sessionId: 'session-1',
                actor: {
                    kind: 'accountUser',
                    accountId: 'session-owner',
                    relationship: 'owner',
                },
            },
        });
        expect(canApprovePermissions).not.toHaveBeenCalled();
    });

    it('stamps a shared approver only after the legacy permission route passes its server gate', async () => {
        canApprovePermissions.mockResolvedValue(true);

        await expect(resolveRpcCallTarget({
            callerUserId: 'shared-user',
            method: 'session-1:permission',
        })).resolves.toEqual({
            type: 'target',
            targetUserId: 'session-owner',
            permissionRespondAuthorization: {
                kind: 'session.permission.respond',
                sessionId: 'session-1',
                actor: {
                    kind: 'accountUser',
                    accountId: 'shared-user',
                    relationship: 'sharedApprover',
                },
            },
        });
        expect(canApprovePermissions).toHaveBeenCalledWith('shared-user', 'session-1');
    });
});
