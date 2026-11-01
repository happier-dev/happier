import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';
import { DEFAULT_ATTENTION_DELIVERY_POLICY_V1 } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const SECURE_STORE_DEV_FALLBACK_ENV = 'EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK';
let originalSecureStoreDevFallback: string | undefined;
const runtimeFetchWithServerReachabilityMock = vi.hoisted(() => vi.fn());
const secureStore = vi.hoisted(() => new Map<string, string>());
const activityNotificationCapabilities = vi.hoisted(() => vi.fn(() => null as unknown));
const removeActivityNotificationContext = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../../modules/happier-activity-notifications', () => ({
    readActivityNotificationCapabilities: activityNotificationCapabilities,
    prepareActivityNotificationStorage: () => '/native/activity-alerts',
    prepareActivityNotificationContext: () => true,
    removeActivityNotificationContext,
    clearActivityNotificationContext: () => undefined,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchWithServerReachabilityMock,
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: {
                            OS: 'ios',
                        },
                    }
    );
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));

vi.mock('expo-secure-store', () => {
    return {
        getItemAsync: async (key: string) => secureStore.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => {
            secureStore.set(key, value);
        },
        deleteItemAsync: async (key: string) => {
            secureStore.delete(key);
        },
    };
});

const Notifications = await import('expo-notifications');
const serverProfiles = await import('@/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { registerPushTokenIfAvailable } = await import('./syncAccount');
// Resolve the shared state graph during module collection, not the first
// cleanup hook (which otherwise pays the whole cold-import cost).
const { storage } = await import('@/sync/domains/state/storageStore');

async function resetPersistedHomes(): Promise<void> {
    const { clearLastRegisteredExpoPushToken } = await import('@/sync/domains/state/pushTokenRegistration');
    clearLastRegisteredExpoPushToken();
    await TokenStorage.removeCredentials();
    for (const profile of serverProfiles.listServerProfiles()) {
        await serverProfiles.removeServerProfile(profile.id);
    }
    secureStore.clear();
    storage.getState().clearSettingsScope();
}

function tokenForAccount(accountId: string): string {
    return [
        btoa(JSON.stringify({ alg: 'none' })),
        btoa(JSON.stringify({ sub: accountId })),
        'signature',
    ].join('.');
}

beforeEach(async () => {
    await resetPersistedHomes();
    originalSecureStoreDevFallback = process.env[SECURE_STORE_DEV_FALLBACK_ENV];
    process.env[SECURE_STORE_DEV_FALLBACK_ENV] = '0';
    runtimeFetchWithServerReachabilityMock.mockReset();
    activityNotificationCapabilities.mockReturnValue(null);
    removeActivityNotificationContext.mockClear();
    runtimeFetchWithServerReachabilityMock.mockImplementation(async () => Response.json({ success: true }));
    setRuntimeFetch(async (input, init) => runtimeFetchWithServerReachabilityMock({
        url: String(input),
        init,
    }));
});

afterEach(async () => {
    resetRuntimeFetch();
    await resetPersistedHomes();
    if (originalSecureStoreDevFallback === undefined) {
        delete process.env[SECURE_STORE_DEV_FALLBACK_ENV];
    } else {
        process.env[SECURE_STORE_DEV_FALLBACK_ENV] = originalSecureStoreDevFallback;
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('registerPushTokenIfAvailable (multi-server)', () => {
    it('registers and unregisters exact Iroh Homes through real carrier policy and scoped native leases', async () => {
        const { getIrohHomeTunnelRuntime, disposeIrohHomeTunnelRuntime } = await import('@/sync/runtime/nativeIrohTunnels/runtime');
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const actualReachability = await vi.importActual<typeof import('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch')>(
            '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch',
        );
        // This case keeps the entire request/readiness path real. Only native
        // hardware, network I/O, SecureStore and Expo are substituted.
        runtimeFetchWithServerReachabilityMock.mockImplementation(actualReachability.runtimeFetchWithServerReachability);
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[native]' });
        const homes = await Promise.all(['a', 'b'].map((suffix) => serverProfiles.adoptHomeProfile({
            source: 'manual', descriptor: {
                v: 1, homeServerIdentityId: `srv_native_push_${suffix}`,
                canonicalServerUrl: `https://native-push-${suffix}.example.test`, revision: 1,
                endpoints: [{ kind: 'iroh', endpointId: suffix.repeat(64) }],
            },
        })));
        for (const home of homes) {
            await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
                token: tokenForAccount(home.id), secret: 's',
            });
        }
        await serverProfiles.setActiveServerId(homes[0]!.id, { scope: 'device' });
        const requests: Array<{ url: string; method: string }> = [];
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            requests.push({ url, method: init?.method ?? 'GET' });
            if (url.endsWith('/v1/features')) return Response.json({
                features: {}, capabilities: { serverIdentity: {
                    serverIdentityId: url.startsWith('http://127.0.0.1:45991') ? 'srv_native_push_a' : 'srv_native_push_b',
                } },
            });
            return Response.json({ ok: true, success: true });
        });
        await disposeIrohHomeTunnelRuntime();
        const runtime = getIrohHomeTunnelRuntime({ native: {
            ensureHomeTunnel: async (input) => ({
                leaseId: `native-${input.homeServerIdentityId}`,
                homeServerIdentityId: input.homeServerIdentityId, homeEndpointId: input.endpointId,
                runtimeOrigin: input.homeServerIdentityId === 'srv_native_push_a' ? 'http://127.0.0.1:45991' : 'http://127.0.0.1:46111',
                carrier: 'iroh', observedPath: 'direct', startedAtMs: 1,
            }),
            releaseHomeTunnel: async () => undefined,
        } });
        try {
            await registerPushTokenIfAvailable({
                credentials: null, log: { log: () => undefined },
                getHomeAccountSettings: async (home) => home.serverUrl.includes('native-push-b')
                    ? { attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: false } } } }
                    : {},
            });
            expect(requests.filter(({ url, method }) => url.includes('/v1/push-tokens') && method !== 'GET').sort((a, b) => a.url.localeCompare(b.url))).toEqual([
                { url: 'http://127.0.0.1:45991/v1/push-tokens', method: 'POST' },
                { url: `http://127.0.0.1:46111/v1/push-tokens/${encodeURIComponent('ExponentPushToken[native]')}`, method: 'DELETE' },
            ]);
            expect(requests.every(({ url }) => url.startsWith('http://127.0.0.1:'))).toBe(true);
            expect(runtime.listTunnels().leases).toEqual([]);
        } finally {
            await disposeIrohHomeTunnelRuntime();
            await resetServerReachabilitySupervisors();
            resetRuntimeFetch();
        }
    });

    it('enrolls only the negotiated exact token row and keeps disabled local overrides as Account inheritance', async () => {
        activityNotificationCapabilities.mockReturnValue({ v: 1, platform: 'ios', events: ['ready'] });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[enrolled]' });
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://enrolled.example.test', name: 'Enrolled' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        const accountToken = tokenForAccount('account-enrolled');
        await TokenStorage.setCredentials({ token: accountToken, secret: 's' });
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request) => {
            if (/\/v1\/features(?:\/authenticated)?$/.test(String(request.url))) return Response.json({
                features: { sessions: { enabled: true, following: { enabled: true } } }, capabilities: {},
            });
            if (String(request.url).endsWith('/v1/push-tokens?projectionVersion=2')) return Response.json({
                v: 2, accountRemoteAlerts: { settingsVersion: 1, status: 'current' },
                tokens: [{ id: 'exact-row', token: 'ExponentPushToken[enrolled]', createdAt: 1, updatedAt: 1, clientServerUrl: null, remoteAlerts: null }],
            });
            if (String(request.url).endsWith('/v1/account/encryption/currentness')) return Response.json({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
            return Response.json({ success: true });
        });
        await registerPushTokenIfAvailable({ credentials: { token: accountToken, secret: 's' }, log: { log: () => undefined },
            getAccountSettings: () => ({ sessionRemoteAlertsEnabled: true }),
            getLocalSettings: () => ({ deviceRemoteAlertsEnabled: true, attentionDeviceOverridesV1: { enabled: false,
                localNotifications: { enabled: false }, sounds: { enabled: false, volume: 0 } } }),
        });
        const remote = runtimeFetchWithServerReachabilityMock.mock.calls.map(([request]) => request.init?.body)
            .filter((body): body is string => typeof body === 'string').map((body) => JSON.parse(body))
            .find((body) => body.remoteAlerts);
        expect(remote?.remoteAlerts).toMatchObject({ registrationId: 'exact-row', policy: {
            enabled: true, nativeConsumer: 'ios_service_extension_v1', quietHoursOverride: { mode: 'account' },
            foregroundBehavior: 'account', previewCeiling: 'account', soundVolume: 1,
        } });
    });

    it('never publishes a captured device policy after local privacy changes during enrollment', async () => {
        activityNotificationCapabilities.mockReturnValue({ v: 1, platform: 'ios', events: ['ready'] });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[policy-race]' });
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://policy-race.example.test', name: 'Policy race' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        const accountToken = tokenForAccount('account-policy-race');
        await TokenStorage.setCredentials({ token: accountToken, secret: 's' });
        const encryptionRead = createDeferred<void>();
        let releaseEncryptionRead!: () => void;
        const encryptionStarted = new Promise<void>((resolve) => { releaseEncryptionRead = resolve; });
        let localSettings: Record<string, unknown> = {
            deviceRemoteAlertsEnabled: true,
            attentionDeviceOverridesV1: {
                enabled: true,
                privacy: { previewBehavior: 'include_preview' },
            },
        };
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request) => {
            const url = String(request.url);
            if (/\/v1\/features(?:\/authenticated)?$/.test(url)) return Response.json({
                features: { sessions: { enabled: true, following: { enabled: true } } }, capabilities: {},
            });
            if (url.endsWith('/v1/push-tokens?projectionVersion=2')) return Response.json({
                v: 2, accountRemoteAlerts: { settingsVersion: 1, status: 'current' },
                tokens: [{ id: 'policy-race-row', token: 'ExponentPushToken[policy-race]', createdAt: 1, updatedAt: 1, clientServerUrl: null, remoteAlerts: null }],
            });
            if (url.endsWith('/v1/account/encryption/currentness')) {
                releaseEncryptionRead();
                await encryptionRead.promise;
                return Response.json({
                    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                });
            }
            return Response.json({ success: true });
        });

        const run = registerPushTokenIfAvailable({
            credentials: { token: accountToken, secret: 's' },
            log: { log: () => undefined },
            getAccountSettings: () => ({ sessionRemoteAlertsEnabled: true }),
            getHomeAccountSettings: async () => ({ sessionRemoteAlertsEnabled: true }),
            getLocalSettings: () => localSettings,
        });
        await encryptionStarted;
        localSettings = {
            deviceRemoteAlertsEnabled: true,
            attentionDeviceOverridesV1: {
                enabled: true,
                privacy: { previewBehavior: 'status_only' },
            },
        };
        encryptionRead.resolve();
        await run;

        const publishedPolicies = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request.init?.body)
            .filter((body): body is string => typeof body === 'string')
            .map((body) => JSON.parse(body) as Record<string, unknown>)
            .filter((body) => body.remoteAlerts !== undefined);
        expect(publishedPolicies).toEqual([]);
    });
    it('keeps remote enrollment and native context inactive when the exact Home disables Session Follow', async () => {
        activityNotificationCapabilities.mockReturnValue({ v: 1, platform: 'ios', events: ['ready'] });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[feature-off]' });
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://feature-off.example.test', name: 'Off' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        const accountToken = tokenForAccount('account-feature-off');
        await TokenStorage.setCredentials({ token: accountToken, secret: 's' });
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request) => {
            if (/\/v1\/features(?:\/authenticated)?$/.test(String(request.url))) return Response.json({
                features: { sessions: { enabled: true, following: { enabled: false } } }, capabilities: {},
            });
            return Response.json({ success: true });
        });

        await registerPushTokenIfAvailable({ credentials: { token: accountToken, secret: 's' }, log: { log: () => undefined },
            getAccountSettings: () => ({ sessionRemoteAlertsEnabled: true }),
            getLocalSettings: () => ({ deviceRemoteAlertsEnabled: true }),
        });

        const requestedPaths = runtimeFetchWithServerReachabilityMock.mock.calls.map(([request]) => new URL(String(request.url)).pathname + new URL(String(request.url)).search);
        expect(requestedPaths).toContain('/v1/push-tokens');
        expect(requestedPaths).not.toContain('/v1/push-tokens?projectionVersion=2');
        expect(removeActivityNotificationContext).toHaveBeenCalled();
    });
    it('keeps enrollment unavailable on a Home that does not negotiate the projection', async () => {
        activityNotificationCapabilities.mockReturnValue({ v: 1, platform: 'android', events: ['ready'] });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[predecessor]' });
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://predecessor.example.test', name: 'Predecessor' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 'predecessor', secret: 's' });
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request) => {
            if (/\/v1\/features(?:\/authenticated)?$/.test(String(request.url))) return Response.json({
                features: { sessions: { enabled: true, following: { enabled: true } } }, capabilities: {},
            });
            // A predecessor Home ignores the query and answers its released shape.
            if (String(request.url).includes('/v1/push-tokens?')) return Response.json({
                tokens: [{ id: 'exact-row', token: 'ExponentPushToken[predecessor]', createdAt: 1, updatedAt: 1, clientServerUrl: null }],
            });
            return Response.json({ success: true });
        });
        await registerPushTokenIfAvailable({ credentials: { token: 'predecessor', secret: 's' }, log: { log: () => undefined },
            getAccountSettings: () => ({ sessionRemoteAlertsEnabled: true }),
            getLocalSettings: () => ({ deviceRemoteAlertsEnabled: true }),
        });
        const bodies = runtimeFetchWithServerReachabilityMock.mock.calls.map(([request]) => request.init?.body)
            .filter((body): body is string => typeof body === 'string').map((body) => JSON.parse(body));
        expect(bodies.some((body) => body.remoteAlerts)).toBe(false);
        expect(bodies.some((body) => body.token === 'ExponentPushToken[predecessor]')).toBe(true);
    });

    it('clears an existing enrollment when the Account withdraws disclosure and never rewrites an unchanged overlay', async () => {
        activityNotificationCapabilities.mockReturnValue({ v: 1, platform: 'ios', events: ['ready'] });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[optout]' });
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://optout.example.test', name: 'Opt out' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        const accountToken = tokenForAccount('account-optout');
        await TokenStorage.setCredentials({ token: accountToken, secret: 's' });
        const enrolled = {
            v: 1, enabled: true, nativeConsumer: 'ios_service_extension_v1',
            quietHoursOverride: { mode: 'account' }, foregroundBehavior: 'account', previewCeiling: 'account', soundVolume: 1,
        };
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request) => {
            if (/\/v1\/features(?:\/authenticated)?$/.test(String(request.url))) return Response.json({
                features: { sessions: { enabled: true, following: { enabled: true } } }, capabilities: {},
            });
            if (String(request.url).endsWith('/v1/push-tokens?projectionVersion=2')) return Response.json({
                v: 2, accountRemoteAlerts: { settingsVersion: 1, status: 'current' },
                tokens: [{ id: 'exact-row', token: 'ExponentPushToken[optout]', createdAt: 1, updatedAt: 1, clientServerUrl: null, remoteAlerts: enrolled }],
            });
            if (String(request.url).endsWith('/v1/account/encryption/currentness')) return Response.json({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
            return Response.json({ success: true });
        });

        const readRemoteAlertBodies = () => runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request.init?.body)
            .filter((body): body is string => typeof body === 'string').map((body) => JSON.parse(body))
            .filter((body) => body.remoteAlerts);

        // Same overlay as the persisted row: the cycle must not rewrite it.
        await registerPushTokenIfAvailable({ credentials: { token: accountToken, secret: 's' }, log: { log: () => undefined },
            getAccountSettings: () => ({ sessionRemoteAlertsEnabled: true }),
            getLocalSettings: () => ({ deviceRemoteAlertsEnabled: true }),
        });
        expect(readRemoteAlertBodies()).toEqual([]);

        runtimeFetchWithServerReachabilityMock.mockClear();
        await registerPushTokenIfAvailable({ credentials: { token: accountToken, secret: 's' }, log: { log: () => undefined },
            getAccountSettings: () => ({}),
            getLocalSettings: () => ({ deviceRemoteAlertsEnabled: true }),
        });
        expect(readRemoteAlertBodies()).toEqual([{
            token: 'ExponentPushToken[optout]',
            remoteAlerts: { registrationId: 'exact-row', policy: null },
        }]);
    });

    it('does not register or rewrite an existing enrollment when this cycle could not read Home consent', async () => {
        activityNotificationCapabilities.mockReturnValue({ v: 1, platform: 'ios', events: ['ready'] });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[unknown]' });
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://unknown.example.test', name: 'Unknown' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        const accountToken = tokenForAccount('account-unknown');
        await TokenStorage.setCredentials({ token: accountToken, secret: 's' });
        await registerPushTokenIfAvailable({ credentials: { token: accountToken, secret: 's' }, log: { log: () => undefined },
            // Neither the live Home read nor a cached projection answers.
            getAccountSettings: () => null,
            getHomeAccountSettings: async () => null,
            getLocalSettings: () => ({ deviceRemoteAlertsEnabled: true }),
        });
        const urls = runtimeFetchWithServerReachabilityMock.mock.calls.map(([request]) => String(request.url));
        expect(urls.some((url) => url.includes('projectionVersion=2'))).toBe(false);
        expect(urls.some((url) => url.includes('/v1/push-tokens'))).toBe(false);
    });

    it('skips only the Home with unknown consent while preserving cleanup custody and registering another Home', async () => {
        const {
            loadRegisteredExpoPushTokenState,
            saveLastRegisteredExpoPushToken,
        } = await import('@/sync/domains/state/pushTokenRegistration');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        });
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[current]',
        });
        saveLastRegisteredExpoPushToken('ExponentPushToken[previous]');

        const unknownHome = await serverProfiles.upsertServerProfile({
            serverUrl: 'https://unknown-consent.example.test',
            name: 'Unknown consent',
        });
        const enabledHome = await serverProfiles.upsertServerProfile({
            serverUrl: 'https://enabled-consent.example.test',
            name: 'Enabled consent',
        });
        await serverProfiles.setActiveServerId(unknownHome.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(
            unknownHome.serverUrl,
            { serverId: unknownHome.id },
            { token: tokenForAccount('unknown-consent-account'), secret: 'unknown' },
        );
        await TokenStorage.setCredentialsForServerUrl(
            enabledHome.serverUrl,
            { serverId: enabledHome.id },
            { token: tokenForAccount('enabled-consent-account'), secret: 'enabled' },
        );

        await registerPushTokenIfAvailable({
            credentials: null,
            log: { log: () => undefined },
            getAccountSettings: () => null,
            getHomeAccountSettings: async (home) => (
                home.id === unknownHome.id ? null : {}
            ),
        });

        const pushMutations = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => ({
                url: String(request.url),
                method: request.init?.method ?? 'GET',
            }))
            .filter(({ url }) => url.includes('/v1/push-tokens'));
        expect(pushMutations).toEqual([
            { url: `${enabledHome.serverUrl}/v1/push-tokens`, method: 'POST' },
            {
                url: `${enabledHome.serverUrl}/v1/push-tokens/${encodeURIComponent('ExponentPushToken[previous]')}`,
                method: 'DELETE',
            },
        ]);
        expect(loadRegisteredExpoPushTokenState()).toEqual({
            current: 'ExponentPushToken[current]',
            cleanupPending: 'ExponentPushToken[previous]',
        });
    });

    it('registers for all saved servers with credentials', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.requestPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[secret-token]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);

        const { upsertServerProfile, setActiveServerId } = serverProfiles;
        const defaultServer = await upsertServerProfile({
            serverUrl: 'https://remote-a.example.test',
            name: 'Primary',
        });
        const company = await upsertServerProfile({
            serverUrl: 'https://company.example.test',
            name: 'Company',
        });

        await setActiveServerId(defaultServer.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(
            defaultServer.serverUrl,
            { serverId: defaultServer.id },
            { token: 't_primary', secret: 's' },
        );

        await setActiveServerId(company.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(
            company.serverUrl,
            { serverId: company.id },
            { token: 't_company', secret: 's' },
        );

        await setActiveServerId(defaultServer.id, { scope: 'device' });

        const messages: string[] = [];
        const log = { log: (message: string) => messages.push(message) };

        await registerPushTokenIfAvailable({
            credentials: { token: 't_primary', secret: 's' } satisfies AuthCredentials,
            log,
            getAccountSettings: () => ({}),
            getHomeAccountSettings: async () => ({}),
        });

        const urls = runtimeFetchWithServerReachabilityMock.mock.calls
            .filter(([request]) => request.init?.method === 'POST')
            .map(([request]) => String(request.url))
            .sort();
        expect(urls).toEqual([
            'https://company.example.test/v1/push-tokens',
            'https://remote-a.example.test/v1/push-tokens',
        ]);
        expect(messages.join('\n')).not.toContain('ExponentPushToken[secret-token]');

        const bodiesByUrl = new Map<string, any>();
        for (const [request] of runtimeFetchWithServerReachabilityMock.mock.calls) {
            const url = String(request.url);
            const init = (request.init ?? {}) as any;
            const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
            bodiesByUrl.set(url, body);
        }
        expect(bodiesByUrl.get('https://remote-a.example.test/v1/push-tokens')).toMatchObject({
            token: 'ExponentPushToken[secret-token]',
            clientServerUrl: 'https://remote-a.example.test',
        });
        expect(bodiesByUrl.get('https://company.example.test/v1/push-tokens')).toMatchObject({
            token: 'ExponentPushToken[secret-token]',
            clientServerUrl: 'https://company.example.test',
        });
    });

    it('uses current local consent for the focused Home and explicit settings for other Homes', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[scoped]' } as never);
        const { upsertServerProfile, setActiveServerId } = serverProfiles;
        const homeA = await upsertServerProfile({ serverUrl: 'https://home-a.example.test', name: 'A' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'B' });
        await setActiveServerId(homeA.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 'a', secret: 's' });
        await setActiveServerId(homeB.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 'b', secret: 's' });
        await setActiveServerId(homeA.id, { scope: 'device' });

        const reads: string[] = [];
        await registerPushTokenIfAvailable({
            credentials: { token: 'a', secret: 's' },
            log: { log: vi.fn() },
            getHomeAccountSettings: async (home) => {
                reads.push(home.serverUrl);
                return {};
            },
            getAccountSettings: () => ({
                attentionDeliveryPolicyV1: {
                ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
                channels: {
                    expo_push: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels.expo_push, enabled: false },
                },
            },
            }),
        });

        // The focused settings write is local-first and may still be pending its
        // debounced server flush. A stale live read must not override that intent.
        expect(reads).toEqual([
            'https://home-b.example.test',
            'https://home-b.example.test',
        ]);
        const mutationCalls = runtimeFetchWithServerReachabilityMock.mock.calls
            .filter(([request]) => request.init?.method === 'POST' || request.init?.method === 'DELETE')
            .map(([request]) => ({ method: request.init?.method, url: String(request.url) }))
            .sort((left, right) => left.url.localeCompare(right.url));
        expect(mutationCalls).toEqual([
            { method: 'DELETE', url: 'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Bscoped%5D' },
            { method: 'POST', url: 'https://home-b.example.test/v1/push-tokens' },
        ]);
    });

    it('reads a never-focused Home live setting through explicit Home requests and skips the live-disabled Home', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[live-read]' } as never);
        const tokenForAccount = (accountId: string) => [
            btoa(JSON.stringify({ alg: 'none' })),
            btoa(JSON.stringify({ sub: accountId })),
            'signature',
        ].join('.');
        const secretBytes = new Uint8Array(32).fill(19);
        const { encodeBase64 } = await import('@/encryption/base64');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { sealAccountScopedBlobCiphertext } = await import('@happier-dev/protocol');
        const homeBEncryption = await Encryption.create(secretBytes);
        const homeBSettingsCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: {
                type: 'dataKey',
                machineKey: homeBEncryption.getContentPrivateKey(),
            },
            payload: { attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: false } } } },
            randomBytes: () => new Uint8Array(24).fill(23),
        });
        const homeACredentials = { token: tokenForAccount('account-a'), secret: encodeBase64(secretBytes, 'base64url') } satisfies AuthCredentials;
        const homeBCredentials = { token: tokenForAccount('account-b'), secret: encodeBase64(secretBytes, 'base64url') } satisfies AuthCredentials;
        const { upsertServerProfile, setActiveServerId } = serverProfiles;
        const homeA = await upsertServerProfile({
            serverUrl: 'https://live-a.example.test',
            name: 'A',
        });
        const homeB = await upsertServerProfile({
            serverUrl: 'https://live-b.example.test',
            name: 'B',
        });
        await setActiveServerId(homeA.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(
            homeA.serverUrl,
            { serverId: homeA.id },
            homeACredentials,
        );
        await TokenStorage.setCredentialsForServerUrl(
            homeB.serverUrl,
            { serverId: homeB.id },
            homeBCredentials,
        );

        // B is never synced, so it has no persisted scoped Account Settings
        // projection. Its live endpoints authoritatively disable Expo push and
        // the disabled v2 E2EE envelope must not be misread as enabled defaults.
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string }) => {
            const url = String(request.url);
            if (url.endsWith('/v1/account/encryption')) {
                return Response.json({ mode: url.includes('live-b') ? 'e2ee' : 'plain', updatedAt: 1 });
            }
            if (url.endsWith('/v2/account/settings')) {
                return Response.json({
                    content: url.includes('live-b')
                        ? { t: 'encrypted', c: homeBSettingsCiphertext }
                        : { t: 'plain', v: {} },
                    version: 7,
                });
            }
            return Response.json({ success: true });
        });

        await registerPushTokenIfAvailable({
            credentials: homeACredentials,
            log: { log: vi.fn() },
        });

        const calls = runtimeFetchWithServerReachabilityMock.mock.calls.map(([request]) => request as { url: string; init?: RequestInit });
        const homeBCalls = calls.filter(({ url }) => url.includes('live-b'));
        // The never-focused Home is read live through its own explicit endpoints.
        expect(homeBCalls.some(({ url }) => url.endsWith('/v1/account/encryption'))).toBe(true);
        expect(homeBCalls.some(({ url }) => url.endsWith('/v2/account/settings'))).toBe(true);
        for (const { init } of homeBCalls) {
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${tokenForAccount('account-b')}`);
        }
        const registeredUrls = calls
            .filter(({ url, init }) => url.endsWith('/v1/push-tokens') && init?.method === 'POST')
            .map(({ url }) => url);
        expect(registeredUrls).toEqual(['https://live-a.example.test/v1/push-tokens']);
        expect(calls.filter(({ url, init }) => url.includes('live-b') && init?.method === 'DELETE'))
            .toEqual([expect.objectContaining({
                url: 'https://live-b.example.test/v1/push-tokens/ExponentPushToken%5Blive-read%5D',
            })]);
        expect(calls.some(({ url, init }) => !url.includes('live-a') && !url.includes('live-b') && (init?.method === 'POST' || init?.method === 'DELETE'))).toBe(false);
    });

    it('falls back to the Home-scoped cached setting for an offline Home while the focused Home stays enabled', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[offline-cache]' } as never);
        const tokenForAccount = (accountId: string) => [
            btoa(JSON.stringify({ alg: 'none' })),
            btoa(JSON.stringify({ sub: accountId })),
            'signature',
        ].join('.');
        const { upsertServerProfile, setActiveServerId } = serverProfiles;
        const homeA = await upsertServerProfile({ serverUrl: 'https://offline-a.example.test', name: 'A' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://offline-b.example.test', name: 'B' });
        await setActiveServerId(homeA.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: tokenForAccount('account-a'), secret: 's' });
        await setActiveServerId(homeB.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: tokenForAccount('account-b'), secret: 's' });
        await setActiveServerId(homeA.id, { scope: 'device' });

        // B holds a last-known disabled scoped projection from an earlier sync.
        const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const scopeB = createAccountSettingsScope(homeB.id, 'account-b');
        expect(scopeB).not.toBeNull();
        if (!scopeB) return;
        saveAccountSettings(scopeB, {
            ...settingsDefaults,
            attentionDeliveryPolicyV1: {
                ...settingsDefaults.attentionDeliveryPolicyV1,
                channels: {
                    ...settingsDefaults.attentionDeliveryPolicyV1.channels,
                    expo_push: {
                        ...settingsDefaults.attentionDeliveryPolicyV1.channels.expo_push,
                        enabled: false,
                    },
                },
            },
        }, 3);

        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string }) => {
            const url = String(request.url);
            if (url.includes('offline-b')) throw new Error('home offline');
            if (url.endsWith('/v1/account/encryption')) {
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            if (url.endsWith('/v2/account/settings')) {
                return Response.json({ content: { t: 'plain', v: {} }, version: 2 });
            }
            return Response.json({ success: true });
        });

        await registerPushTokenIfAvailable({
            credentials: { token: tokenForAccount('account-a'), secret: 's' } satisfies AuthCredentials,
            log: { log: vi.fn() },
        });

        const calls = runtimeFetchWithServerReachabilityMock.mock.calls.map(([request]) => request as { url: string; init?: RequestInit });
        // Live-first: B is asked directly even though a scoped cache exists.
        expect(calls.some(({ url }) => url.includes('offline-b') && url.endsWith('/v1/account/encryption'))).toBe(true);
        const registeredUrls = calls
            .filter(({ url, init }) => url.endsWith('/v1/push-tokens') && init?.method === 'POST')
            .map(({ url }) => url);
        // A registers from its own live setting; B keeps its offline last-known
        // disabled consent and is never registered.
        expect(registeredUrls).toEqual(['https://offline-a.example.test/v1/push-tokens']);
    });

    it('makes one registration attempt per Home and never re-registers a failed Home with caller credentials', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[single-decision]' } as never);
        const { clearLastRegisteredExpoPushToken } = await import('@/sync/domains/state/pushTokenRegistration');
        clearLastRegisteredExpoPushToken();
        const { upsertServerProfile, setActiveServerId } = serverProfiles;
        const homeA = await upsertServerProfile({ serverUrl: 'https://single-a.example.test', name: 'A' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://single-b.example.test', name: 'B' });
        await setActiveServerId(homeA.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 'single-a' });
        await setActiveServerId(homeB.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 'single-b' });
        await setActiveServerId(homeA.id, { scope: 'device' });

        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string }) => {
            if (String(request.url).includes('single-a')) throw new Error('registration endpoint failed');
            return Response.json({ success: true });
        });

        // The caller context deliberately carries a credential that belongs to no
        // enumerated Home (for example an Account Service credential leaked into
        // this call). The canonical per-Home decision must never send it anywhere.
        await registerPushTokenIfAvailable({
            credentials: { token: 'foreign-account-service-credential' } satisfies AuthCredentials,
            log: { log: vi.fn() },
            getHomeAccountSettings: async () => ({}),
        });

        const postCalls = runtimeFetchWithServerReachabilityMock.mock.calls.filter(([request]) => {
            const params = request as { url: string; init?: RequestInit };
            return params.url.endsWith('/v1/push-tokens') && params.init?.method === 'POST';
        });
        const postUrls = postCalls.map(([request]) => String((request as { url: string }).url));
        // One canonical attempt per Home: the failed focused Home must not be
        // retried through a separate focused-Home fallback decision.
        expect(postUrls.filter((url) => url.includes('single-a'))).toHaveLength(1);
        expect(postUrls.filter((url) => url.includes('single-b'))).toHaveLength(1);
        for (const [request] of postCalls) {
            const headers = (request as { init?: RequestInit }).init?.headers as Record<string, string> | undefined;
            expect(JSON.stringify(headers ?? {})).not.toContain('foreign-account-service-credential');
        }
    });

    it('reconciles an independent Home while another Home is pending and settles after both outcomes', async () => {
        const {
            loadRegisteredExpoPushTokenState,
            saveLastRegisteredExpoPushToken,
        } = await import('@/sync/domains/state/pushTokenRegistration');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[concurrent-homes]' } as never);
        saveLastRegisteredExpoPushToken('ExponentPushToken[previous-concurrent-homes]');
        const homeA = await serverProfiles.upsertServerProfile({ serverUrl: 'https://pending-home-a.example.test', name: 'Pending A' });
        const homeB = await serverProfiles.upsertServerProfile({ serverUrl: 'https://healthy-home-b.example.test', name: 'Healthy B' });
        await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, { token: 'pending-a', secret: 'a' });
        await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, { token: 'healthy-b', secret: 'b' });

        const homeAConsent = createDeferred<unknown>();
        let homeBConsentReads = 0;
        const log = vi.fn();
        let reconciliationSettled = false;
        const run = registerPushTokenIfAvailable({
            credentials: null,
            log: { log },
            getHomeAccountSettings: async (home) => {
                if (home.id === homeA.id) return homeAConsent.promise;
                homeBConsentReads += 1;
                return {};
            },
        }).finally(() => {
            reconciliationSettled = true;
        });

        await vi.waitFor(() => expect(homeBConsentReads).toBe(2));
        expect(runtimeFetchWithServerReachabilityMock.mock.calls.some(([request]) => {
            const scopedRequest = request as { url: string; init?: RequestInit };
            return scopedRequest.url === `${homeB.serverUrl}/v1/push-tokens`
                && scopedRequest.init?.method === 'POST';
        })).toBe(true);
        expect(reconciliationSettled).toBe(false);

        homeAConsent.reject(new Error('Home A offline'));
        await run;

        expect(reconciliationSettled).toBe(true);
        expect(log).toHaveBeenCalledWith(`Push notification consent unavailable for Home ${homeA.serverUrl}; skipping this reconciliation cycle`);
        expect(log).toHaveBeenCalledWith('Push token registered successfully');
        expect(loadRegisteredExpoPushTokenState()).toEqual({
            current: 'ExponentPushToken[concurrent-homes]',
            cleanupPending: 'ExponentPushToken[previous-concurrent-homes]',
        });
    });

    it('compensates a registration that completes after its Home credential is removed', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[stale]' } as never);
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://stale.example.test', name: 'Stale' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'stale-home-token' });
        let finishRegistration!: () => void;
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string; init?: RequestInit }) => {
            if (request.url.endsWith('/v1/push-tokens') && request.init?.method === 'POST') {
                await new Promise<void>((resolve) => { finishRegistration = resolve; });
            }
            return Response.json({ success: true });
        });

        const run = registerPushTokenIfAvailable({ credentials: { token: 'stale-home-token' }, log: { log: vi.fn() }, getAccountSettings: () => ({}) });
        await vi.waitFor(() => expect(finishRegistration).toBeTypeOf('function'));
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        finishRegistration();
        await run;

        const mutations = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request as { url: string; init?: RequestInit })
            .filter(({ url }) => url.includes('/v1/push-tokens'))
            .map(({ init }) => init?.method);
        expect(mutations).toEqual(['POST', 'DELETE']);
    });

    it('compensates a registration that completes after its Home profile is removed', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[removed]' } as never);
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://removed.example.test', name: 'Removed' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'removed-home-token' });
        let finishRegistration!: () => void;
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string; init?: RequestInit }) => {
            if (request.url.endsWith('/v1/push-tokens') && request.init?.method === 'POST') {
                await new Promise<void>((resolve) => { finishRegistration = resolve; });
            }
            return Response.json({ success: true });
        });

        const run = registerPushTokenIfAvailable({ credentials: { token: 'removed-home-token' }, log: { log: vi.fn() }, getAccountSettings: () => ({}) });
        await vi.waitFor(() => expect(finishRegistration).toBeTypeOf('function'));
        await serverProfiles.removeServerProfile(home.id);
        finishRegistration();
        await run;

        const mutations = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request as { url: string; init?: RequestInit })
            .filter(({ url }) => url.includes('/v1/push-tokens'))
            .map(({ init }) => init?.method);
        expect(mutations).toEqual(['POST', 'DELETE']);
    });

    it('compensates a registration that completes after focused Home push is disabled', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[disabled-race]' } as never);
        const home = await serverProfiles.upsertServerProfile({ serverUrl: 'https://disabled-race.example.test', name: 'Disabled race' });
        await serverProfiles.setActiveServerId(home.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'disabled-race-token' });
        let pushEnabled = true;
        let finishRegistration!: () => void;
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string; init?: RequestInit }) => {
            if (request.url.endsWith('/v1/push-tokens') && request.init?.method === 'POST') {
                await new Promise<void>((resolve) => { finishRegistration = resolve; });
            }
            return Response.json({ success: true });
        });
        const readSettings = () => pushEnabled
            ? {}
            : { attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: false } } } };

        const run = registerPushTokenIfAvailable({
            credentials: { token: 'disabled-race-token' },
            log: { log: vi.fn() },
            getAccountSettings: readSettings,
        });
        await vi.waitFor(() => expect(finishRegistration).toBeTypeOf('function'));
        pushEnabled = false;
        finishRegistration();
        await run;

        const mutations = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request as { url: string; init?: RequestInit })
            .filter(({ url }) => url.includes('/v1/push-tokens'))
            .map(({ init }) => init?.method);
        expect(mutations).toEqual(['POST', 'DELETE']);
    });

    it('compensates only the Home whose consent becomes unknown while registration is in flight', async () => {
        const {
            loadRegisteredExpoPushTokenState,
            saveLastRegisteredExpoPushToken,
        } = await import('@/sync/domains/state/pushTokenRegistration');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[consent-race]' } as never);
        saveLastRegisteredExpoPushToken('ExponentPushToken[previous-consent-race]');
        const active = await serverProfiles.upsertServerProfile({ serverUrl: 'https://active-consent-race.example.test', name: 'Active' });
        const uncertain = await serverProfiles.upsertServerProfile({ serverUrl: 'https://uncertain-consent-race.example.test', name: 'Uncertain' });
        const sibling = await serverProfiles.upsertServerProfile({ serverUrl: 'https://sibling-consent-race.example.test', name: 'Sibling' });
        await serverProfiles.setActiveServerId(active.id, { scope: 'device' });
        await TokenStorage.setCredentialsForServerUrl(uncertain.serverUrl, { serverId: uncertain.id }, { token: tokenForAccount('uncertain-consent-race'), secret: 'uncertain' });
        await TokenStorage.setCredentialsForServerUrl(sibling.serverUrl, { serverId: sibling.id }, { token: tokenForAccount('sibling-consent-race'), secret: 'sibling' });
        let uncertainConsentReads = 0;

        await registerPushTokenIfAvailable({
            credentials: null,
            log: { log: () => undefined },
            getAccountSettings: () => null,
            getHomeAccountSettings: async (home) => {
                if (home.id !== uncertain.id) return {};
                uncertainConsentReads += 1;
                return uncertainConsentReads === 1 ? {} : null;
            },
        });

        const mutations = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request as { url: string; init?: RequestInit })
            .filter(({ url }) => url.includes('/v1/push-tokens'))
            .map(({ url, init }) => ({ url, method: init?.method ?? 'GET' }));
        expect(mutations).toContainEqual({
            url: `${uncertain.serverUrl}/v1/push-tokens`,
            method: 'POST',
        });
        expect(mutations).toContainEqual({
            url: `${uncertain.serverUrl}/v1/push-tokens/${encodeURIComponent('ExponentPushToken[consent-race]')}`,
            method: 'DELETE',
        });
        expect(mutations).toContainEqual({
            url: `${sibling.serverUrl}/v1/push-tokens`,
            method: 'POST',
        });
        expect(loadRegisteredExpoPushTokenState()).toEqual({
            current: 'ExponentPushToken[consent-race]',
            cleanupPending: 'ExponentPushToken[previous-consent-race]',
        });
    });

    it('does not apply newly focused Home B disabled consent to an in-flight Home A registration', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[focus-race]' } as never);
        const homeA = await serverProfiles.upsertServerProfile({ serverUrl: 'https://focus-race-a.example.test', name: 'A' });
        const homeB = await serverProfiles.upsertServerProfile({ serverUrl: 'https://focus-race-b.example.test', name: 'B' });
        const credentialsA = { token: tokenForAccount('focus-race-account-a'), secret: 'a' } satisfies AuthCredentials;
        const credentialsB = { token: tokenForAccount('focus-race-account-b'), secret: 'b' } satisfies AuthCredentials;
        await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, credentialsA);
        await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsB);

        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const scopeA = createAccountSettingsScope(homeA.id, 'focus-race-account-a');
        const scopeB = createAccountSettingsScope(homeB.id, 'focus-race-account-b');
        expect(scopeA).not.toBeNull();
        expect(scopeB).not.toBeNull();
        if (!scopeA || !scopeB) return;
        await serverProfiles.setActiveServerId(homeA.id, { scope: 'device' });
        await storage.getState().activateSettingsScope(scopeA);

        let finishHomeARegistration!: () => void;
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string; init?: RequestInit }) => {
            if (request.url === `${homeA.serverUrl}/v1/push-tokens` && request.init?.method === 'POST') {
                await new Promise<void>((resolve) => { finishHomeARegistration = resolve; });
            }
            return Response.json({ success: true });
        });

        const run = registerPushTokenIfAvailable({
            credentials: credentialsA,
            log: { log: vi.fn() },
            getHomeAccountSettings: async () => ({}),
        });
        await vi.waitFor(() => expect(finishHomeARegistration).toBeTypeOf('function'));
        await serverProfiles.setActiveServerId(homeB.id, { scope: 'device' });
        await storage.getState().activateSettingsScope(scopeB);
        storage.getState().applySettingsLocal({
            attentionDeliveryPolicyV1: {
                ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
                channels: {
                    expo_push: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels.expo_push, enabled: false },
                },
            },
        });
        finishHomeARegistration();
        await run;

        const homeAMutations = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request as { url: string; init?: RequestInit })
            .filter(({ url }) => url.includes('focus-race-a') && url.includes('/v1/push-tokens'))
            .map(({ init }) => init?.method);
        expect(homeAMutations).toEqual(['POST']);
    });

    it('compensates Home A when A consent changes while Home B is focused and enabled', async () => {
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: PermissionStatus.GRANTED, expires: 'never', granted: true, canAskAgain: false } as never);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[scope-race]' } as never);
        const homeA = await serverProfiles.upsertServerProfile({ serverUrl: 'https://scope-race-a.example.test', name: 'A' });
        const homeB = await serverProfiles.upsertServerProfile({ serverUrl: 'https://scope-race-b.example.test', name: 'B' });
        const credentialsA = { token: tokenForAccount('scope-race-account-a'), secret: 'a' } satisfies AuthCredentials;
        const credentialsB = { token: tokenForAccount('scope-race-account-b'), secret: 'b' } satisfies AuthCredentials;
        await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, credentialsA);
        await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsB);

        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const scopeA = createAccountSettingsScope(homeA.id, 'scope-race-account-a');
        const scopeB = createAccountSettingsScope(homeB.id, 'scope-race-account-b');
        expect(scopeA).not.toBeNull();
        expect(scopeB).not.toBeNull();
        if (!scopeA || !scopeB) return;
        await serverProfiles.setActiveServerId(homeA.id, { scope: 'device' });
        await storage.getState().activateSettingsScope(scopeA);

        let finishHomeARegistration!: () => void;
        runtimeFetchWithServerReachabilityMock.mockImplementation(async (request: { url: string; init?: RequestInit }) => {
            if (request.url === `${homeA.serverUrl}/v1/push-tokens` && request.init?.method === 'POST') {
                await new Promise<void>((resolve) => { finishHomeARegistration = resolve; });
            }
            return Response.json({ success: true });
        });

        const run = registerPushTokenIfAvailable({
            credentials: credentialsA,
            log: { log: vi.fn() },
            getHomeAccountSettings: async () => ({}),
        });
        await vi.waitFor(() => expect(finishHomeARegistration).toBeTypeOf('function'));
        await serverProfiles.setActiveServerId(homeB.id, { scope: 'device' });
        await storage.getState().activateSettingsScope(scopeB);
        storage.getState().applySettingsForScope(scopeA, {
            ...settingsDefaults,
            attentionDeliveryPolicyV1: {
                ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
                channels: {
                    expo_push: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels.expo_push, enabled: false },
                },
            },
        }, 1);
        finishHomeARegistration();
        await run;

        const homeAMutations = runtimeFetchWithServerReachabilityMock.mock.calls
            .map(([request]) => request as { url: string; init?: RequestInit })
            .filter(({ url }) => url.includes('scope-race-a') && url.includes('/v1/push-tokens'))
            .map(({ init }) => init?.method);
        expect(homeAMutations).toEqual(['POST', 'DELETE']);
    });
});
