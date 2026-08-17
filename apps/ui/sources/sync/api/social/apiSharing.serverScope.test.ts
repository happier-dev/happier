import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
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

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/auth/storage/tokenStorage')
    >();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: getCredentialsForServerUrlMock,
        },
    };
});

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: createEncryptionFromAuthCredentialsMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import {
    createPublicShare,
    createSessionShare,
    getSessionShares,
} from './apiSharing';

function expectHeaderValue(headers: HeadersInit | undefined, key: string, value: string) {
    expect(new Headers(headers).get(key)).toBe(value);
}

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
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
        const ownerToken = tokenForSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
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
        expectHeaderValue(sharesCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expectHeaderValue(
            sharesCall?.[1]?.headers,
            'x-happier-account-stored-content-protocol',
            String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
        );
    });

    it('creates session shares through the preferred owner server and preserves the request body', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        const ownerToken = tokenForSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
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
        expectHeaderValue(createCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expectHeaderValue(createCall?.[1]?.headers, 'Content-Type', 'application/json');
        expectHeaderValue(
            createCall?.[1]?.headers,
            'x-happier-account-stored-content-protocol',
            String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
        );
    });

    it('creates a public share through the preferred owner server with the current declaration', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        const ownerToken = tokenForSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            publicShare: { id: 'public-share-1' },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const publicShare = await createPublicShare(
            { token: 'active-token', secret: 'active-secret' },
            'session-1',
            { token: 'public-token' },
        );

        expect(publicShare.id).toBe('public-share-1');
        expect(serverFetchMock).not.toHaveBeenCalled();
        const requestCall = runtimeFetchMock.mock.calls.find(([input]) =>
            String(input) === 'https://owner.example/v1/sessions/session-1/public-share');
        expect(requestCall?.[1]).toEqual(expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ token: 'public-token' }),
        }));
        expectHeaderValue(requestCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expectHeaderValue(
            requestCall?.[1]?.headers,
            'x-happier-account-stored-content-protocol',
            String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
        );
    });
});
