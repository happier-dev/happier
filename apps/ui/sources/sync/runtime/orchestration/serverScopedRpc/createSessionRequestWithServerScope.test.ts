import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const createEncryptionFromAuthCredentialsMock = vi.hoisted(() => vi.fn());

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

import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { createSessionRequestWithServerScope } from './createSessionRequestWithServerScope';

function expectHeaderValue(headers: HeadersInit | undefined, key: string, value: string) {
    expect(new Headers(headers).get(key)).toBe(value);
}

describe('createSessionRequestWithServerScope', () => {
    beforeEach(() => {
        kvStore.clear();
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        createEncryptionFromAuthCredentialsMock.mockReset();
    });

    it('uses the active request when the target server is already active', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        setActiveServerId(activeServer.id, { scope: 'device' });

        const activeRequest = vi.fn(async () => new Response(null, { status: 200 }));
        const request = createSessionRequestWithServerScope({
            serverId: activeServer.id,
            activeRequest,
        });

        await request('/v1/sessions/s1/messages', { method: 'GET' });

        expect(activeRequest).toHaveBeenCalledWith('/v1/sessions/s1/messages', { method: 'GET' });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('uses runtimeFetch with scoped auth when the target server is not active', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});

        const activeRequest = vi.fn(async () => new Response(null, { status: 200 }));
        const request = createSessionRequestWithServerScope({
            serverId: ownerServer.id,
            activeRequest,
        });

        await request('/v1/sessions/s1/messages?scope=main', { method: 'GET' });

        expect(activeRequest).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            'https://owner.example/v1/sessions/s1/messages?scope=main',
            expect.objectContaining({ method: 'GET' }),
        );
        expectHeaderValue(runtimeFetchMock.mock.calls[0]?.[1]?.headers, 'Authorization', 'Bearer owner-token');
    });

    it('preserves request body and existing headers for non-GET scoped requests', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});

        const activeRequest = vi.fn(async () => new Response(null, { status: 200 }));
        const request = createSessionRequestWithServerScope({
            serverId: ownerServer.id,
            activeRequest,
        });

        await request('/v2/sessions/s1/pending', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Test': '1',
            },
            body: JSON.stringify({ hello: 'world' }),
        });

        expect(activeRequest).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            'https://owner.example/v2/sessions/s1/pending',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ hello: 'world' }),
            }),
        );
        expectHeaderValue(runtimeFetchMock.mock.calls[0]?.[1]?.headers, 'Authorization', 'Bearer owner-token');
        expectHeaderValue(runtimeFetchMock.mock.calls[0]?.[1]?.headers, 'Content-Type', 'application/json');
        expectHeaderValue(runtimeFetchMock.mock.calls[0]?.[1]?.headers, 'X-Test', '1');
    });
});
