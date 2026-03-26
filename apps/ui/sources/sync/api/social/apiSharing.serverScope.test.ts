import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const createEncryptionFromAuthCredentialsMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: runtimeFetchMock,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlMock,
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: createEncryptionFromAuthCredentialsMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { createSessionShare, getSessionShares } from './apiSharing';

function expectHeaderValue(headers: HeadersInit | undefined, key: string, value: string) {
    expect(new Headers(headers).get(key)).toBe(value);
}

describe('apiSharing server-scoped session routes', () => {
    beforeEach(() => {
        kvStore.clear();
        serverFetchMock.mockReset();
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        createEncryptionFromAuthCredentialsMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
    });

    it('gets session shares through the preferred owner server when the owner is not active', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ shares: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const shares = await getSessionShares({ token: 'active-token', secret: 'active-secret' }, 'session-1');

        expect(shares).toEqual([]);
        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            'https://owner.example/v1/sessions/session-1/shares',
            expect.objectContaining({ method: 'GET' }),
        );
        const sharesCall = runtimeFetchMock.mock.calls.find((call) => call[0] === 'https://owner.example/v1/sessions/session-1/shares');
        expect(sharesCall).toBeTruthy();
        expectHeaderValue(sharesCall?.[1]?.headers, 'Authorization', 'Bearer owner-token');
    });

    it('creates session shares through the preferred owner server and preserves the request body', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            share: {
                id: 'share-1',
                sessionId: 'session-1',
                sharedWithUser: {
                    id: 'user-2',
                    username: 'lee',
                    firstName: null,
                    lastName: null,
                    avatar: null,
                },
                accessLevel: 'edit',
                canApprovePermissions: false,
                createdAt: 1,
                updatedAt: 1,
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const share = await createSessionShare(
            { token: 'active-token', secret: 'active-secret' },
            'session-1',
            { userId: 'user-2', accessLevel: 'edit' },
        );

        expect(share.id).toBe('share-1');
        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            'https://owner.example/v1/sessions/session-1/shares',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ userId: 'user-2', accessLevel: 'edit' }),
            }),
        );
        const createCall = runtimeFetchMock.mock.calls.find((call) => call[0] === 'https://owner.example/v1/sessions/session-1/shares');
        expect(createCall).toBeTruthy();
        expectHeaderValue(createCall?.[1]?.headers, 'Authorization', 'Bearer owner-token');
        expectHeaderValue(createCall?.[1]?.headers, 'Content-Type', 'application/json');
    });
});
