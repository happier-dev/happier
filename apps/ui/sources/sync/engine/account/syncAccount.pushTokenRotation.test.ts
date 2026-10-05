import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';
import { AccountEncryptionModeResponseSchema, AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import * as homes from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { clearLastRegisteredExpoPushToken, loadRegisteredExpoPushTokenState, loadLastRegisteredExpoPushToken, loadExpoPushTokensToUnregister, saveLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';

const deviceStorage = vi.hoisted((): {
    values: Map<string, string>;
    beforeRead: null | (() => Promise<void>);
} => ({
    values: new Map<string, string>(),
    beforeRead: null,
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => {
        await deviceStorage.beforeRead?.();
        return deviceStorage.values.get(key) ?? null;
    },
    setItemAsync: async (key: string, value: string) => { deviceStorage.values.set(key, value); },
    deleteItemAsync: async (key: string) => { deviceStorage.values.delete(key); },
}));
vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));
const Notifications = await import('expo-notifications');
const { registerPushTokenIfAvailable } = await import('./syncAccount');

type PushRequest = { origin: string; method: string; token: string; authorization: string | null; body?: unknown };
const requests: PushRequest[] = [];
const createdHomeScopes: Array<{ serverUrl: string; serverId: string }> = [];
const registrationFailures = new Set<string>();
const cleanupFailures = new Set<string>();
const settingsUnavailable = new Set<string>();
const settingsByOrigin = new Map<string, unknown>();
const homeAUrl = 'https://home-a.example.test';
const homeBUrl = 'https://home-b.example.test';
const pushToken = 'ExponentPushToken[new]';
let originalSecureStoreFallback: string | undefined;

function credentialsFor(accountId: string): AuthCredentials {
    return { token: [btoa(JSON.stringify({ alg: 'none' })), btoa(JSON.stringify({ sub: accountId })), 'signature'].join('.') };
}
async function addHome(serverUrl: string, accountId: string, withCredentials = true) {
    const home = await homes.upsertServerProfile({ serverUrl, name: accountId });
    const serverId = homes.resolveServerProfileScopeId(home);
    createdHomeScopes.push({ serverUrl, serverId });
    const credentials = credentialsFor(accountId);
    if (withCredentials) {
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, credentials)).toBe(true);
    }
    return { home, credentials };
}
function permission(status: PermissionStatus) {
    return { status, expires: 'never', granted: status === PermissionStatus.GRANTED, canAskAgain: status !== PermissionStatus.DENIED } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;
}
const network: RuntimeFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.pathname === '/v1/push-tokens' && method === 'POST') {
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        requests.push({ origin: url.origin, method, token: '', authorization: new Headers(init?.headers).get('Authorization'), body });
        return registrationFailures.has(url.origin) ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith('/v1/push-tokens/') && method === 'DELETE') {
        requests.push({ origin: url.origin, method, token: decodeURIComponent(url.pathname.slice('/v1/push-tokens/'.length)), authorization: new Headers(init?.headers).get('Authorization') });
        return cleanupFailures.has(url.origin) ? new Response(null, { status: 503 }) : Response.json({ success: true });
    }
    if (url.pathname === '/v1/account/encryption') return Response.json(AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 0 }));
    if (url.pathname === '/v2/account/settings') {
        return settingsUnavailable.has(url.origin) ? new Response(null, { status: 503 }) : Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: settingsByOrigin.get(url.origin) ?? {} }, version: 1 }));
    }
    if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ success: true });
    // Unsupported optional features stay fail-closed through the real feature owner.
    return new Response(null, { status: 404 });
};
async function resetDeviceState() {
    deviceStorage.beforeRead = null;
    // A case may remove a profile without removing its retained device credential.
    // Keep that exact scope until the public storage owner confirms its removal.
    while (createdHomeScopes.length > 0) {
        const scope = createdHomeScopes[0]!;
        expect(await TokenStorage.removeCredentialsForServerUrl(scope.serverUrl, { serverId: scope.serverId })).toBe(true);
        createdHomeScopes.shift();
    }
    await TokenStorage.removeCredentials();
    for (const home of homes.listServerProfiles()) {
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: homes.resolveServerProfileScopeId(home) });
        await homes.removeServerProfile(home.id);
    }
    homes.resetServerProfilesRuntimeForTests();
    deviceStorage.values.clear();
    storage.getState().clearSettingsScope();
    clearLastRegisteredExpoPushToken();
    resetServerReachabilitySupervisors();
    resetServerFeaturesClientForTests();
    invalidateAccountEncryptionModeCache();
}
beforeEach(async () => {
    originalSecureStoreFallback = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK;
    process.env.EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK = '0';
    setRuntimeFetch(network);
    await resetDeviceState();
    requests.length = 0;
    registrationFailures.clear();
    cleanupFailures.clear();
    settingsUnavailable.clear();
    settingsByOrigin.clear();
    vi.mocked(Notifications.getPermissionsAsync).mockReset().mockResolvedValue(permission(PermissionStatus.GRANTED));
    vi.mocked(Notifications.requestPermissionsAsync).mockReset().mockResolvedValue(permission(PermissionStatus.GRANTED));
    vi.mocked(Notifications.getExpoPushTokenAsync).mockReset().mockResolvedValue({ type: 'expo', data: pushToken });
});
afterEach(async () => {
    vi.useRealTimers();
    await resetDeviceState();
    resetRuntimeFetch();
    if (originalSecureStoreFallback === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK;
    else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK = originalSecureStoreFallback;
    vi.clearAllMocks();
});

describe('registerPushTokenIfAvailable rotation cleanup', () => {
    it('unregisters the previous token when Expo rotates tokens', async () => {
        const a = await addHome(homeAUrl, 'account-a');
        const b = await addHome(homeBUrl, 'account-b');
        saveLastRegisteredExpoPushToken('ExponentPushToken[old]');
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(loadLastRegisteredExpoPushToken()).toBe(pushToken);
        expect(requests.filter((request) => request.method === 'DELETE')).toEqual(expect.arrayContaining([
            { origin: homeAUrl, method: 'DELETE', token: 'ExponentPushToken[old]', authorization: `Bearer ${a.credentials.token}` },
            { origin: homeBUrl, method: 'DELETE', token: 'ExponentPushToken[old]', authorization: `Bearer ${b.credentials.token}` },
        ]));
        expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(2);
    });

    it('uses serverId-scoped credentials when profiles share the same server URL', async () => {
        // The profile owner accepts retained OS rows with distinct stable Home identities.
        // Current adoption rejects conflicting new descriptors; do not counterfeit that path.
        new MMKV({ id: scopedStorageId('server-profiles', readStorageScopeFromEnv()) }).set('server-state-v1', JSON.stringify({
            activeServerId: 'home-b', activeServerIdIsExplicit: true,
            servers: {
                'home-a': { id: 'home-a', name: 'A', serverUrl: 'https://shared.example.test', canonicalServerUrl: 'https://shared.example.test', serverIdentityId: 'srv_identity_a', source: 'manual', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
                'home-b': { id: 'home-b', name: 'B', serverUrl: 'https://shared.example.test', canonicalServerUrl: 'https://shared.example.test', serverIdentityId: 'srv_identity_b', source: 'manual', createdAt: 2, updatedAt: 2, lastUsedAt: 2 },
            },
        }));
        homes.resetServerProfilesRuntimeForTests();
        expect(homes.listServerProfiles().map(homes.resolveServerProfileScopeId).sort()).toEqual(['srv_identity_a', 'srv_identity_b']);
        const a = credentialsFor('account-a');
        const b = credentialsFor('account-b');
        for (const [serverId, credentials] of [['srv_identity_a', a], ['srv_identity_b', b]] satisfies Array<[string, AuthCredentials]>) {
            createdHomeScopes.push({ serverUrl: 'https://shared.example.test', serverId });
            expect(await TokenStorage.setCredentialsForServerUrl('https://shared.example.test', { serverId }, credentials)).toBe(true);
        }
        saveLastRegisteredExpoPushToken('ExponentPushToken[old]');
        await registerPushTokenIfAvailable({ credentials: b, log: { log: () => {} } });
        expect(loadLastRegisteredExpoPushToken()).toBe(pushToken);
        const posts = requests.filter((request) => request.method === 'POST');
        const deletes = requests.filter((request) => request.method === 'DELETE');
        expect(posts).toHaveLength(2);
        expect(deletes).toHaveLength(2);
        for (const credentials of [a, b]) {
            expect(posts).toContainEqual({ origin: 'https://shared.example.test', method: 'POST', token: '', authorization: `Bearer ${credentials.token}`, body: { token: pushToken, clientServerUrl: 'https://shared.example.test' } });
            expect(deletes).toContainEqual({ origin: 'https://shared.example.test', method: 'DELETE', token: 'ExponentPushToken[old]', authorization: `Bearer ${credentials.token}` });
        }
    });

    it('unregisters the previous token exactly once per Home without duplicating the focused Home', async () => {
        const a = await addHome(homeAUrl, 'account-a');
        await addHome(homeBUrl, 'account-b');
        await homes.setActiveServerId(a.home.id, { scope: 'device' });
        saveLastRegisteredExpoPushToken('ExponentPushToken[old]');
        const captured = credentialsFor('captured-account');
        await registerPushTokenIfAvailable({ credentials: captured, log: { log: () => {} } });
        expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.origin).sort()).toEqual([homeAUrl, homeBUrl]);
        expect(requests.every((request) => request.authorization !== `Bearer ${captured.token}`)).toBe(true);
    });

    it('keeps the prior token reachable for cleanup when one enabled Home fails, cleans succeeded Homes, and settles on the next full cycle', async () => {
        await addHome(homeAUrl, 'account-a');
        await addHome(homeBUrl, 'account-b');
        saveLastRegisteredExpoPushToken('ExponentPushToken[old]');
        registrationFailures.add(homeAUrl);
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(requests.filter((request) => request.method === 'DELETE').map((request) => [request.origin, request.token])).toEqual([[homeBUrl, 'ExponentPushToken[old]']]);
        expect(loadRegisteredExpoPushTokenState()).toEqual({ current: pushToken, cleanupPending: 'ExponentPushToken[old]' });
        expect(loadExpoPushTokensToUnregister()).toEqual([pushToken, 'ExponentPushToken[old]']);
        requests.length = 0;
        registrationFailures.clear();
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.origin).sort()).toEqual([homeAUrl, homeBUrl]);
        expect(loadRegisteredExpoPushTokenState()).toEqual({ current: pushToken, cleanupPending: null });
        expect(loadExpoPushTokensToUnregister()).toEqual([pushToken]);
    });

    it('keeps the cleanup basis when a Home cleanup fails while the observed token advances', async () => {
        await addHome(homeAUrl, 'account-a');
        saveLastRegisteredExpoPushToken('ExponentPushToken[old]');
        cleanupFailures.add(homeAUrl);
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
        expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.token)).toEqual(['ExponentPushToken[old]']);
        expect(loadRegisteredExpoPushTokenState()).toEqual({ current: pushToken, cleanupPending: 'ExponentPushToken[old]' });
        expect(loadExpoPushTokensToUnregister()).toEqual([pushToken, 'ExponentPushToken[old]']);
    });

    it('registers the latest token per Home even when an offline Home cannot clean an older generation', async () => {
        await addHome(homeAUrl, 'account-a');
        await addHome(homeBUrl, 'account-b');
        saveLastRegisteredExpoPushToken('ExponentPushToken[A]');
        registrationFailures.add(homeAUrl);
        cleanupFailures.add(homeAUrl);
        vi.mocked(Notifications.getExpoPushTokenAsync)
            .mockResolvedValueOnce({ type: 'expo', data: 'ExponentPushToken[B]' })
            .mockResolvedValueOnce({ type: 'expo', data: 'ExponentPushToken[C]' });
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(loadRegisteredExpoPushTokenState()).toEqual({ current: 'ExponentPushToken[B]', cleanupPending: 'ExponentPushToken[A]' });
        requests.length = 0;
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(requests.filter((request) => request.origin === homeBUrl)).toEqual([
            expect.objectContaining({ method: 'POST', body: { token: 'ExponentPushToken[C]', clientServerUrl: homeBUrl } }),
            expect.objectContaining({ method: 'DELETE', token: 'ExponentPushToken[B]' }),
        ]);
        expect(loadRegisteredExpoPushTokenState()).toEqual({ current: 'ExponentPushToken[C]', cleanupPending: 'ExponentPushToken[B]' });
    });

    it('does not send current or previous tokens to an absent focused profile', async () => {
        const removed = await addHome(homeAUrl, 'account-a');
        await homes.setActiveServerId(removed.home.id, { scope: 'device' });
        await homes.removeServerProfile(removed.home.id);
        saveLastRegisteredExpoPushToken('ExponentPushToken[old]');
        await registerPushTokenIfAvailable({ credentials: removed.credentials, log: { log: () => {} } });
        expect(requests).toEqual([]);
    });
});
