import type { Socket } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const mocks = vi.hoisted(() => ({
    sessionFindUnique: vi.fn(),
    canApprovePermissions: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: { session: { findUnique: mocks.sessionFindUnique } },
}));
vi.mock('@/app/share/accessControl', () => ({
    canApprovePermissions: mocks.canApprovePermissions,
}));
vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));

import { resolveRpcCallTarget } from './resolveRpcCallTarget';

describe('resolveRpcCallTarget delegated session approvals', () => {
    beforeEach(() => {
        mocks.sessionFindUnique.mockReset();
        mocks.canApprovePermissions.mockReset();
    });

    it.each([
        SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY,
        SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    ])('applies canApprovePermissions to %s', async (suffix) => {
        const target = {} as Socket;
        mocks.sessionFindUnique.mockResolvedValue({ accountId: 'owner' });
        mocks.canApprovePermissions.mockResolvedValue(true);

        await expect(resolveRpcCallTarget({
            callerUserId: 'delegate',
            method: `session-1:${suffix}`,
            allRpcListeners: new Map([['owner', new Map([[`session-1:${suffix}`, target]])]]),
        })).resolves.toEqual({ type: 'target', targetUserId: 'owner', targetSocket: target });
        expect(mocks.canApprovePermissions).toHaveBeenCalledWith('delegate', 'session-1');
    });

    it('rejects an unauthorized delegate on the v1 method', async () => {
        mocks.sessionFindUnique.mockResolvedValue({ accountId: 'owner' });
        mocks.canApprovePermissions.mockResolvedValue(false);

        await expect(resolveRpcCallTarget({
            callerUserId: 'delegate',
            method: `session-1:${SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1}`,
            allRpcListeners: new Map(),
        })).resolves.toEqual({ type: 'forbidden' });
    });

    it('does not broaden unrelated session RPC methods', async () => {
        await expect(resolveRpcCallTarget({
            callerUserId: 'delegate',
            method: `session-1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
            allRpcListeners: new Map(),
        })).resolves.toEqual({ type: 'target', targetUserId: 'delegate', targetSocket: undefined });
        expect(mocks.sessionFindUnique).not.toHaveBeenCalled();
        expect(mocks.canApprovePermissions).not.toHaveBeenCalled();
    });
});
