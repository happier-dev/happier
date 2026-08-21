import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    fetchAccountEncryptionMode: vi.fn(),
    setSessionAttentionStanding: vi.fn(),
}));

const serverProfileMocks = vi.hoisted(() => ({
    getServerProfileById: vi.fn(),
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

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        getServerProfileById: serverProfileMocks.getServerProfileById,
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

// A server profile is stored under a URL-derived local id while every
// server-scoped projection (sessions, list view data, organization snapshots)
// is keyed by the profile's canonical scope id. Keying an organization write by
// the local id lands it where nothing reads: the request succeeds, the server
// keeps the value, and the list keeps showing the pre-press state until reload.
describe('sessionSetAttentionStandingWithServerScope', () => {
    const SCOPE_ID = 'srv_scope';
    const LOCAL_PROFILE_ID = 'localhost-52753';

    beforeEach(async () => {
        serverProfileMocks.getServerProfileById.mockReset();
        serverProfileMocks.getServerProfileById.mockReturnValue({
            id: LOCAL_PROFILE_ID,
            name: 'Local',
            serverUrl: 'https://server-a.example',
            serverIdentityId: SCOPE_ID,
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        });
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer(SCOPE_ID);
        getStorage().getState().clearSessionOrganizationForServer(LOCAL_PROFILE_ID);
    });

    it('keys the optimistic standing by the canonical server scope id, not the local profile id', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentialsSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl')
            .mockResolvedValue({ token: 'token-a', secret: 'secret-a' });
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { sessionSetAttentionStandingWithServerScope } = await import('./setSessionAttentionStanding');
        apiMocks.setSessionAttentionStanding.mockResolvedValueOnce({
            standing: { sessionId: 's1', standing: true, updatedAt: 99 },
        });

        const result = await sessionSetAttentionStandingWithServerScope('s1', true, { serverId: SCOPE_ID });

        expect(result).toEqual({ success: true });
        const state = getStorage().getState();
        expect(state.sessionOrganizationAttentionStandingsBySessionKey[`${SCOPE_ID}:s1`])
            .toEqual({ sessionId: 's1', standing: true, updatedAt: 99 });
        expect(state.sessionOrganizationAttentionStandingsBySessionKey[`${LOCAL_PROFILE_ID}:s1`])
            .toBeUndefined();
        credentialsSpy.mockRestore();
    });
});
