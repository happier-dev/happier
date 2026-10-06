import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';
import { AccountEncryptionModeResponseSchema, AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import * as homes from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { clearLastRegisteredExpoPushToken, loadRegisteredExpoPushTokenState, saveLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';
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
const pushToken = 'ExponentPushToken[policy-token]';
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

const disabledSettings = { attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: false } } } };
describe('registerPushTokenIfAvailable push policy', () => {
    it('skips a focused Home whose offline settings fallback disables Expo push', async () => {
        const { home, credentials } = await addHome(homeAUrl, 'account-a');
        await homes.setActiveServerId(home.id, { scope: 'device' });
        const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const scope = createAccountSettingsScope(homes.resolveServerProfileScopeId(home), 'account-a');
        if (!scope) throw new Error('The arranged Home must have an Account settings scope');
        saveAccountSettings(scope, settingsParse(disabledSettings), 1);
        settingsUnavailable.add(homeAUrl);
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(Notifications.getPermissionsAsync).toHaveBeenCalled();
        expect(requests).toEqual([{ origin: homeAUrl, method: 'DELETE', token: pushToken, authorization: `Bearer ${credentials.token}` }]);
    });

    it('treats a disabled focused Home as terminal with no fallback re-registration', async () => {
        const a = await addHome(homeAUrl, 'account-a');
        await addHome(homeBUrl, 'account-b');
        await homes.setActiveServerId(a.home.id, { scope: 'device' });
        settingsByOrigin.set(homeAUrl, disabledSettings);
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(requests.filter((request) => request.method === 'POST').map((request) => request.origin)).toEqual([homeBUrl]);
        expect(requests.filter((request) => request.method === 'DELETE')).toEqual([
            { origin: homeAUrl, method: 'DELETE', token: pushToken, authorization: `Bearer ${a.credentials.token}` },
        ]);
    });

    it('does not substitute caller credentials when the focused Home has no stored credential', async () => {
        const a = await addHome(homeAUrl, 'account-a', false);
        const b = await addHome(homeBUrl, 'account-b');
        await homes.setActiveServerId(a.home.id, { scope: 'device' });
        await registerPushTokenIfAvailable({ credentials: a.credentials, log: { log: () => {} } });
        expect(requests).toEqual([
            { origin: homeBUrl, method: 'POST', token: '', authorization: `Bearer ${b.credentials.token}`, body: { token: pushToken, clientServerUrl: homeBUrl } },
        ]);
    });

    it('does not mutate an absent-profile active Home outside the canonical profile cycle', async () => {
        const removed = await addHome(homeAUrl, 'account-a');
        await homes.setActiveServerId(removed.home.id, { scope: 'device' });
        await homes.removeServerProfile(removed.home.id);
        await registerPushTokenIfAvailable({ credentials: removed.credentials, log: { log: () => {} } });
        expect(requests).toEqual([]);
    });

    it('never triggers the OS permission prompt from background registration', async () => {
        await addHome(homeAUrl, 'account-a');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue(permission(PermissionStatus.UNDETERMINED));
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
    });

    it('withdraws a previously registered token from every reachable Home after OS permission is denied', async () => {
        const a = await addHome(homeAUrl, 'account-a');
        const b = await addHome(homeBUrl, 'account-b');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue(permission(PermissionStatus.DENIED));
        saveLastRegisteredExpoPushToken(pushToken);
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
        expect(requests).toHaveLength(2);
        expect(requests).toEqual(expect.arrayContaining([
            { origin: homeAUrl, method: 'DELETE', token: pushToken, authorization: `Bearer ${a.credentials.token}` },
            { origin: homeBUrl, method: 'DELETE', token: pushToken, authorization: `Bearer ${b.credentials.token}` },
        ]));
        expect(loadRegisteredExpoPushTokenState()).toEqual({ current: null, cleanupPending: null });
    });

    it('retains local cleanup state when permission is denied but a Home credential is unavailable', async () => {
        await addHome(homeAUrl, 'account-a', false);
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue(permission(PermissionStatus.DENIED));
        saveLastRegisteredExpoPushToken(pushToken);
        await registerPushTokenIfAvailable({ credentials: credentialsFor('captured-account'), log: { log: () => {} } });
        expect(requests).toEqual([]);
        expect(loadRegisteredExpoPushTokenState()).toEqual({ current: pushToken, cleanupPending: null });
    });

    it('registers the token when permission was already granted', async () => {
        const a = await addHome(homeAUrl, 'account-a');
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        expect(requests).toEqual([
            { origin: homeAUrl, method: 'POST', token: '', authorization: `Bearer ${a.credentials.token}`, body: { token: pushToken, clientServerUrl: homeAUrl } },
        ]);
    });

    it('returns instead of stalling when the notification runtime never answers', async () => {
        await addHome(homeAUrl, 'account-a');
        const { PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS } = await import('@/activity/notifications/permission/pushNotificationAccess');
        vi.useFakeTimers();
        try {
            vi.mocked(Notifications.getPermissionsAsync).mockImplementation(() => new Promise<Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>>(() => {}));
            const { messages, log } = collectLogs();
            let settled = false;
            const run = registerPushTokenIfAvailable({ log }).then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS);
            await run;
            expect(settled).toBe(true);
            expect(requests).toEqual([]);
            expect(messages.join('\n')).toContain('runtime_timeout');
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns without registering when the device cannot mint a token', async () => {
        await addHome(homeAUrl, 'account-a');
        vi.mocked(Notifications.getExpoPushTokenAsync).mockRejectedValue(new Error('no valid "aps-environment" entitlement string found'));
        await registerPushTokenIfAvailable({ log: { log: () => {} } });
        expect(requests).toEqual([]);
    });
});
