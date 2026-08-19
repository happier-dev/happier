import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    fetchAccountEncryptionMode: vi.fn(),
    setSessionAttentionStanding: vi.fn(),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: apiMocks.fetchAccountEncryptionMode,
}));

vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return {
        ...actual,
        setSessionAttentionStanding: apiMocks.setSessionAttentionStanding,
    };
});

describe('setSessionAttentionStanding op', () => {
    beforeEach(async () => {
        apiMocks.fetchAccountEncryptionMode.mockReset();
        apiMocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        apiMocks.setSessionAttentionStanding.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('reconciles the optimistic standing with the server response', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        apiMocks.setSessionAttentionStanding.mockResolvedValueOnce({
            standing: { sessionId: 's1', standing: true, updatedAt: 99 },
        });

        await setSessionAttentionStanding({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            serverUrl: 'https://server-a.example',
            sessionId: 's1',
            standing: true,
        });

        expect(apiMocks.setSessionAttentionStanding).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example',
            sessionId: 's1',
            request: { standing: true },
        }));
        const state = getStorage().getState();
        expect(state.sessionOrganizationAttentionStandingsBySessionKey['server-a:s1'])
            .toEqual({ sessionId: 's1', standing: true, updatedAt: 99 });
        expect(state.sessionOrganizationOptimisticRecords).toEqual({});
    });

    it('drops the standing optimistically when the override is cleared', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        apiMocks.setSessionAttentionStanding.mockResolvedValueOnce({ standing: null });

        await setSessionAttentionStanding({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionId: 's1',
            standing: null,
        });

        expect(apiMocks.setSessionAttentionStanding).toHaveBeenCalledWith(expect.objectContaining({
            request: { standing: null },
        }));
        expect(getStorage().getState().sessionOrganizationAttentionStandingsBySessionKey['server-a:s1']).toBeUndefined();
    });

    it('rolls the optimistic standing back and rethrows when the request fails', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        apiMocks.setSessionAttentionStanding.mockRejectedValueOnce(new Error('offline'));

        await expect(setSessionAttentionStanding({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionId: 's1',
            standing: true,
        })).rejects.toThrow('offline');

        const state = getStorage().getState();
        expect(state.sessionOrganizationAttentionStandingsBySessionKey['server-a:s1']).toBeUndefined();
        expect(state.sessionOrganizationOptimisticRecords).toEqual({});
    });
});
