import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlMock,
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: createEncryptionFromAuthCredentialsMock,
}));

import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import {
    createSessionRequestWithServerScope,
    resolveSessionRequestForServerAccountScope,
} from './createSessionRequestWithServerScope';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

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

        const ownerToken = tokenForSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockImplementation(async () => new Response(null, { status: 200, headers: new Headers() }));

        const activeRequest = vi.fn(async () => new Response(null, { status: 200 }));
        const request = createSessionRequestWithServerScope({
            serverId: ownerServer.id,
            activeRequest,
        });

        await request('/v1/sessions/s1/messages?scope=main', { method: 'GET' });

        expect(activeRequest).not.toHaveBeenCalled();
        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input).includes('/v1/sessions/s1/messages?scope=main'));
        expect(call).toBeTruthy();
        expect(call?.[1]).toEqual(expect.objectContaining({ method: 'GET' }));
        expectHeaderValue(call?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
    });

    it('preserves request body and existing headers for non-GET scoped requests', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });

        const ownerToken = tokenForSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockImplementation(async () => new Response(null, { status: 200, headers: new Headers() }));

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
        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input).includes('/v2/sessions/s1/pending'));
        expect(call).toBeTruthy();
        expect(call?.[1]).toEqual(expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ hello: 'world' }),
        }));
        expectHeaderValue(call?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expectHeaderValue(call?.[1]?.headers, 'Content-Type', 'application/json');
        expectHeaderValue(call?.[1]?.headers, 'X-Test', '1');
    });

    it('binds an outbox action request to the exact persisted server and authenticated account', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        const ownerToken = tokenForSub('account-owner');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(null, { status: 200 }));

        const request = await resolveSessionRequestForServerAccountScope({
            scope: { serverId: ownerServer.id, accountId: 'account-owner' },
            activeRequest: async () => {
                throw new Error('must not substitute active authority');
            },
        });
        await request('/v2/sessions/s1/pending', { method: 'POST', body: 'exact-body' });

        const call = runtimeFetchMock.mock.calls.find(([input]) => String(input).includes('/v2/sessions/s1/pending'));
        expect(call).toBeTruthy();
        expect(call?.[1]).toEqual(expect.objectContaining({ body: 'exact-body' }));
        expectHeaderValue(call?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
    });

    it('rejects credentials whose authenticated account does not match the persisted outbox scope', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('different-account'), secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});

        await expect(resolveSessionRequestForServerAccountScope({
            scope: { serverId: ownerServer.id, accountId: 'account-owner' },
            activeRequest: async () => new Response(null, { status: 200 }),
        })).rejects.toThrow('authenticated account does not match');
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });
});

afterEach(async () => {
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
});
