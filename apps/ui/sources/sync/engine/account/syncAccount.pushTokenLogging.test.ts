import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';
import { AccountEncryptionModeResponseSchema, AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import * as homes from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { clearLastRegisteredExpoPushToken, saveLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';
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
const pushToken = 'ExponentPushToken[secret-token]';
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
function collectLogs() {
    const messages: string[] = [];
    return { messages, log: { log: (message: string) => { messages.push(message); } } };
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

describe('registerPushTokenIfAvailable logging', () => {
    it('does not log the raw push token', async () => {
        await addHome(homeAUrl, 'account-a');
        const { messages, log } = collectLogs();
        await registerPushTokenIfAvailable({ log });
        expect(requests.filter((request) => request.method === 'POST')).toEqual([
            expect.objectContaining({ origin: homeAUrl, body: { token: pushToken, clientServerUrl: homeAUrl } }),
        ]);
        expect(messages.join('\n')).not.toContain(pushToken);
    });

    it('continues registration for remaining profiles when the first profile fails', async () => {
        const a = await addHome(homeAUrl, 'account-a');
        const b = await addHome(homeBUrl, 'account-b');
        await homes.setActiveServerId(b.home.id, { scope: 'device' });
        registrationFailures.add(homeAUrl);
        const { messages, log } = collectLogs();
        await registerPushTokenIfAvailable({ log });
        expect(requests.filter((request) => request.method === 'POST')).toEqual(expect.arrayContaining([
            expect.objectContaining({ origin: homeAUrl, authorization: `Bearer ${a.credentials.token}`, body: { token: pushToken, clientServerUrl: homeAUrl } }),
            expect.objectContaining({ origin: homeBUrl, authorization: `Bearer ${b.credentials.token}`, body: { token: pushToken, clientServerUrl: homeBUrl } }),
        ]));
        expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);
        expect(messages.join('\n')).toContain('Push token registered successfully');
        expect(messages.join('\n')).not.toContain(pushToken);
    });

    it('does not retry an enumerated active Home when its registration fails', async () => {
        await addHome(homeAUrl, 'account-a');
        const b = await addHome(homeBUrl, 'account-b');
        await homes.setActiveServerId(b.home.id, { scope: 'device' });
        registrationFailures.add(homeBUrl);
        const { messages, log } = collectLogs();
        await registerPushTokenIfAvailable({ log });
        expect(requests.filter((request) => request.method === 'POST').map((request) => request.origin).sort()).toEqual([homeAUrl, homeBUrl]);
        expect(messages.join('\n')).toContain('Push token registered successfully');
        expect(messages.join('\n')).not.toContain(pushToken);
    });

    it('does not act on an active server missing from the canonical profile snapshot', async () => {
        const removed = await addHome(homeAUrl, 'removed-account');
        await homes.setActiveServerId(removed.home.id, { scope: 'device' });
        const retained = await addHome(homeBUrl, 'retained-account');
        await homes.removeServerProfile(removed.home.id);
        saveLastRegisteredExpoPushToken('ExponentPushToken[old-token]');
        const { messages, log } = collectLogs();
        await registerPushTokenIfAvailable({ credentials: removed.credentials, log });
        expect(requests).toHaveLength(2);
        expect(requests.every((request) => request.origin === homeBUrl && request.authorization === `Bearer ${retained.credentials.token}`)).toBe(true);
        expect(requests.find((request) => request.method === 'DELETE')?.token).toBe('ExponentPushToken[old-token]');
        expect(messages.join('\n')).toContain('Push token registered successfully');
        expect(messages.join('\n')).not.toContain(pushToken);
    });

    it('does not substitute captured caller credentials after focus changes during credential lookup', async () => {
        const a = await addHome(homeAUrl, 'account-a', false);
        const b = await addHome(homeBUrl, 'account-b', false);
        await homes.setActiveServerId(a.home.id, { scope: 'device' });
        let finishCredentialRead!: () => void;
        let readStarted!: () => void;
        const started = new Promise<void>((resolve) => { readStarted = resolve; });
        const pending = new Promise<void>((resolve) => { finishCredentialRead = resolve; });
        deviceStorage.beforeRead = async () => {
            deviceStorage.beforeRead = null;
            readStarted();
            await pending;
        };
        const run = registerPushTokenIfAvailable({ credentials: a.credentials, log: { log: () => {} } });
        await started;
        // Focus mutation is queued by the real shared mutation authority.
        const focusChange = homes.setActiveServerId(b.home.id, { scope: 'device' });
        finishCredentialRead();
        await focusChange;
        await run;
        expect(homes.getActiveServerId()).toBe(b.home.id);
        expect(requests).toEqual([]);
    });

    it('logs an overall failure when all profile attempts fail', async () => {
        await addHome(homeAUrl, 'account-a');
        await addHome(homeBUrl, 'account-b');
        registrationFailures.add(homeAUrl);
        registrationFailures.add(homeBUrl);
        const { messages, log } = collectLogs();
        await registerPushTokenIfAvailable({ log });
        expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);
        expect(messages.join('\n')).toContain(`Failed to register push token for ${homeAUrl}`);
        expect(messages.join('\n')).toContain(`Failed to register push token for ${homeBUrl}`);
        expect(messages.join('\n')).toContain('Failed to register push token:');
        expect(messages.join('\n')).not.toContain(pushToken);
    });
});
