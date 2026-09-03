import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

const apiMocks = vi.hoisted(() => ({
    fetchAccountEncryptionMode: vi.fn(),
    setSessionPin: vi.fn(),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: apiMocks.fetchAccountEncryptionMode,
}));

vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return {
        ...actual,
        setSessionPin: apiMocks.setSessionPin,
    };
});

describe('setSessionPin op', () => {
    beforeEach(async () => {
        apiMocks.fetchAccountEncryptionMode.mockReset();
        apiMocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        apiMocks.setSessionPin.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('rolls back a rejected pin and turns the server limit code into recovery guidance', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionPin } = await import('./setSessionPin');
        apiMocks.setSessionPin.mockRejectedValueOnce(new HappyError('session-pin-limit-exceeded', false));

        await expect(setSessionPin({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionId: 's1001',
            pinned: true,
        })).rejects.toThrow('You can pin up to 1,000 sessions. Unpin another session and try again.');

        const state = getStorage().getState();
        expect(state.sessionOrganizationPinsBySessionKey['server-a:s1001']).toBeUndefined();
        expect(state.sessionOrganizationOptimisticRecords).toEqual({});
    });
});
