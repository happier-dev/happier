import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { DEFAULT_ATTENTION_DELIVERY_POLICY_V1 } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import { deriveAccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { getStorage, useSetting } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { settingsParse } from '@/sync/domains/settings/settings';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { syncSettings } from '@/sync/engine/settings/syncSettings';
import type { Socket } from 'socket.io-client';
import { DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { useRemoteAlertRegistrationStatus } from './useRemoteAlertRegistrationStatus';

const nativeCapabilitiesState = vi.hoisted(() => ({
    current: { v: 1, platform: 'ios', events: ['ready'] } as const as unknown,
}));
const readExpoPushTokenSpy = vi.hoisted(() => vi.fn(async () => ({ data: 'ExponentPushToken[test]' })));

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let restoredAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const statusSockets: Socket[] = [];
async function restoreRemoteAlertHome(serverUrl: string, accountId: string, version: number) {
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId,
        configureSocket: socket => { configureConnectedServerSocketBoundary(socket); statusSockets.push(socket); },
        request: async (raw, init) => {
            const path = new URL(String(raw)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return accountSettingsResponse(init, version);
            return null;
        },
    });
    return restoredAccount.home;
}
function accountSettingsResponse(init: RequestInit | undefined, version: number) {
    if (init?.method === 'POST') {
        const input = JSON.parse(String(init.body)) as { expectedVersion: number };
        return Response.json({ success: true, version: input.expectedVersion + 1 });
    }
    return Response.json({ content: { t: 'plain', v: {} }, version });
}

vi.mock('../../../../modules/happier-activity-notifications', () => ({
    readActivityNotificationCapabilities: () => nativeCapabilitiesState.current,
}));

// Only the native SDK mints a token; module loading, support and token parsing stay real.
vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true })),
    getExpoPushTokenAsync: readExpoPushTokenSpy,
}));

afterEach(async () => {
    standardCleanup();
    await restoredAccount?.dispose();
    restoredAccount = undefined;
    statusSockets.length = 0;
    nativeCapabilitiesState.current = { v: 1, platform: 'ios', events: ['ready'] };
    readExpoPushTokenSpy.mockClear();
    vi.restoreAllMocks();
    resetRuntimeFetch();
});

describe('remote alert registration status', () => {
    it('ignores an unrelated confirmed Settings write and rebinds exactly once for changed policy', async () => {
        const home = await restoreRemoteAlertHome('https://remote-alert-cost.example', 'account-cost', 7);
        const scope = { serverId: home.id, accountId: 'account-cost' };
        let version = 7;
        let policyVersion = version;
        let raw: Record<string, unknown> = { sessionRemoteAlertsEnabled: true, analyticsOptOut: false };
        let pushReads = 0;
        const posts: ReturnType<typeof AccountSettingsV2UpdateRequestSchema.parse>[] = [];
        getStorage().getState().applySettingsForScope(scope, settingsParse(raw), version);
        setRuntimeFetch(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const write = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    posts.push(write);
                    if (write.content?.t !== 'plain') throw new Error('Expected plain Account Settings');
                    raw = write.content.v;
                    version++;
                    if (Object.hasOwn(write, 'remoteAlertPolicy')) policyVersion = version;
                    return Response.json({ success: true, version }, { headers: {
                        'x-happier-account-remote-alert-policy-status': deriveAccountRemoteAlertPolicyV1(raw) === null
                            ? 'disabled' : policyVersion === version ? 'current' : 'stale',
                    } });
                }
                // Positive protocol support is carried by this existing baseline read.
                return Response.json({ content: { t: 'plain', v: raw }, version }, {
                    headers: { 'x-happier-account-settings-protocols': 'remote-alert-policy-v1',
                        'x-happier-account-remote-alert-policy-status': deriveAccountRemoteAlertPolicyV1(raw) === null
                            ? 'disabled' : policyVersion === version ? 'current' : 'stale' },
                });
            }
            if (url.pathname === '/v1/push-tokens') {
                pushReads++;
                return Response.json({ v: 2, accountRemoteAlerts: { settingsVersion: version,
                    status: deriveAccountRemoteAlertPolicyV1(raw) === null ? 'disabled' : policyVersion === version ? 'current' : 'stale' }, tokens: [] });
            }
            return new Response(null, { status: 404 });
        });
        const account = await captureLazyActionAccountContext(home.id);
        // Settle the supported server's exact-version metadata through the real baseline owner
        // before measuring mounted work, including any ordinary initial normalization.
        await act(async () => { await syncSettings({ credentials: account.credentials, encryption: null,
            settingsScope: scope, pendingSettings: {}, clearPendingSettings: () => {},
            requestContext: { scope, endpointUrl: home.serverUrl, request: account.request },
        }); });
        posts.length = 0;
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({ enabled: true, serverId: home.id,
            accountEnabled: useSetting('sessionRemoteAlertsEnabled'), policy: useSetting('attentionDeliveryPolicyV1'),
            deviceEnabled: true, deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1 }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({ accountPolicy: 'current', refreshing: false }));
            pushReads = 0;
            readExpoPushTokenSpy.mockClear();
            await act(async () => { await account.mutateRawSettings(current => ({ ...current, analyticsOptOut: true })); });
            expect(pushReads).toBe(0);
            expect(readExpoPushTokenSpy).not.toHaveBeenCalled();
            expect(policyVersion).toBe(version);
            expect(hook.getCurrent().registration.accountPolicy).toBe('current');

            await act(async () => { await account.mutateRawSettings(current => ({ ...current, sessionRemoteAlertsEnabled: false })); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({ accountPolicy: 'disabled', refreshing: false }));
            expect(pushReads).toBe(1);
            expect(readExpoPushTokenSpy).toHaveBeenCalledTimes(1);
            expect(posts).toHaveLength(2);
            expect(posts[1]?.remoteAlertPolicy).toBeNull();

            pushReads = 0;
            readExpoPushTokenSpy.mockClear();
            await act(async () => { await account.mutateRawSettings(current => ({ ...current,
                machineOfflineAlertsV1: { machineIds: ['machine-enrolled'] } })); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({ accountPolicy: 'current', refreshing: false }));
            expect(pushReads).toBe(1);
            expect(readExpoPushTokenSpy).toHaveBeenCalledTimes(1);
            expect(posts[2]?.remoteAlertPolicy).not.toBeNull();
            expect(getStorage().getState().settings.sessionRemoteAlertsEnabled).toBe(false);

            // A predecessor/external writer may advance the document without republishing its
            // remote policy. The real Settings baseline ingress must carry that authority change
            // even though none of this consumer's policy preferences changed.
            raw = { ...raw, analyticsOptOut: false };
            version++;
            await act(async () => { await syncSettings({ credentials: account.credentials, encryption: null,
                settingsScope: scope, pendingSettings: {}, clearPendingSettings: () => {},
                requestContext: { scope, endpointUrl: home.serverUrl, request: account.request },
            }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({ accountPolicy: 'stale', refreshing: false }));
            // A delayed older server fact cannot restore currency after the canonical
            // Settings owner has accepted a newer revision.
            await act(async () => { getStorage().getState().applySettingsForScope(scope, settingsParse(raw), version - 1, 'current'); });
            expect(hook.getCurrent().registration.accountPolicy).toBe('stale');

            // Deliver server facts through the real registered Socket.IO listener,
            // parser, Settings ingress and mounted consumer.
            const socket = statusSockets.find(candidate => candidate.listenersAny().length > 0);
            if (!socket) throw new Error('The restored Account did not register its update listener');
            const deliver = async (publishedVersion: number, status?: 'current' | 'stale') => {
                for (const listener of socket.listenersAny()) await listener('update', { id: `policy-${publishedVersion}`,
                    seq: publishedVersion, createdAt: publishedVersion, body: { t: 'update-account', id: scope.accountId,
                        settingsV2: { content: { t: 'plain', v: raw }, version: publishedVersion },
                        ...(status ? { remoteAlertPolicyStatus: status } : {}),
                    } });
            };
            pushReads = 0;
            readExpoPushTokenSpy.mockClear();
            policyVersion = ++version;
            await act(async () => { await deliver(version, 'current'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().registration.accountPolicy).toBe('current'));
            expect(pushReads).toBe(0);
            expect(readExpoPushTokenSpy).not.toHaveBeenCalled();
            await act(async () => { await deliver(version - 1, 'stale'); });
            expect(hook.getCurrent().registration.accountPolicy).toBe('current');

            // A supported older server omits this optional fact; the incumbent
            // version-bound refresh remains available on exactly that seam.
            version++;
            await act(async () => { await deliver(version); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({ accountPolicy: 'stale', refreshing: false }));
            expect(pushReads).toBe(1);
        } finally { account.dispose(); await hook.unmount(); }
    });

    it('reads only the captured Home and rejects an old unmarked response', async () => {
        const home = await restoreRemoteAlertHome('https://remote-alert-status.example', 'account-a', 7);
        const scope = { serverId: home.id, accountId: 'account-a' };
        getStorage().getState().activateProfileScope(scope);
        getStorage().setState({ settingsScope: scope, settingsVersion: 7 });
        // Secure credential storage and HTTP are external boundaries. Scope, request and parsing stay real.
        let marked = true;
        const hosts: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(url instanceof Request ? url.url : String(url));
            hosts.push(target.host);
            if (target.pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (target.pathname === '/v2/account/settings') return accountSettingsResponse(init, 7);
            if (target.pathname !== '/v1/push-tokens') return new Response(null, { status: 404 });
            return new Response(JSON.stringify(marked ? {
                v: 2, accountRemoteAlerts: { settingsVersion: 7, status: 'stale' }, tokens: [],
            } : { tokens: [] }), { status: 200 });
        });
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: true,
            serverId: home.id,
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().registration.accountPolicy).toBe('stale'));
        expect(hook.getCurrent().registration.accountPolicy).toBe('stale');
        expect(hook.getCurrent().registration.supported).toBe(true);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('enrolling');
        expect(new Set(hosts)).toEqual(new Set(['remote-alert-status.example']));
        marked = false;
        await act(async () => { hook.getCurrent().refresh(); await new Promise((resolve) => setTimeout(resolve, 0)); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            accountPolicy: 'unavailable', supported: false, refreshing: false,
        }));
        expect(hook.getCurrent().registration.accountPolicy).toBe('unavailable');
        expect(hook.getCurrent().registration.supported).toBe(false);
        await hook.unmount();
    });

    it('does not probe enrollment while Session Follow is disabled', async () => {
        const runtimeFetch = vi.fn(async () => new Response('{}', { status: 200 }));
        setRuntimeFetch(runtimeFetch);
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: false,
            serverId: 'home-disabled',
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(hook.getCurrent().registration).toMatchObject({
            accountPolicy: 'unavailable', supported: false, deviceEnrollment: 'unavailable', refreshing: false,
        });
        expect(runtimeFetch).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('re-probes native capability on Refresh so a mounted screen can become enrollable', async () => {
        const home = await restoreRemoteAlertHome('https://remote-alert-refresh.example', 'account-refresh', 8);
        const scope = { serverId: home.id, accountId: 'account-refresh' };
        getStorage().getState().activateProfileScope(scope);
        getStorage().setState({ settingsScope: scope, settingsVersion: 8 });
        setRuntimeFetch(async (url, init) => {
            const target = new URL(url instanceof Request ? url.url : String(url));
            if (target.pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (target.pathname === '/v2/account/settings') return accountSettingsResponse(init, 8);
            if (target.pathname !== '/v1/push-tokens') return new Response(null, { status: 404 });
            return Response.json({
                v: 2,
                accountRemoteAlerts: { settingsVersion: 8, status: 'current' },
                tokens: [],
            });
        });
        nativeCapabilitiesState.current = null;
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: true,
            serverId: home.id,
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            accountPolicy: 'current', supported: true, refreshing: false,
        }));
        expect(hook.getCurrent().registration.nativeAvailable).toBe(false);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('unavailable');

        nativeCapabilitiesState.current = { v: 1, platform: 'ios', events: ['ready'] };
        await act(async () => {
            hook.getCurrent().refresh();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            nativeAvailable: true, deviceEnrollment: 'enrolling', refreshing: false,
        }));
        expect(hook.getCurrent().registration.nativeAvailable).toBe(true);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('enrolling');
        expect(readExpoPushTokenSpy).toHaveBeenCalled();
        await hook.unmount();
    });

    it('re-probes after the asynchronous Home projection resolves', async () => {
        const home = await restoreRemoteAlertHome('https://remote-alert-prepared.example', 'account-prepared', 9);
        const scope = { serverId: home.id, accountId: 'account-prepared' };
        getStorage().getState().activateProfileScope(scope);
        getStorage().setState({ settingsScope: scope, settingsVersion: 9 });
        let projectionRequested = false;
        let releaseProjection!: () => void;
        const projectionReleased = new Promise<void>(resolve => { releaseProjection = resolve; });
        setRuntimeFetch(async (url, init) => {
            const target = new URL(url instanceof Request ? url.url : String(url));
            if (target.pathname === '/v1/auth/ping' || target.pathname === '/health') {
                return Response.json({});
            }
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (target.pathname === '/v2/account/settings') return accountSettingsResponse(init, 9);
            if (target.pathname !== '/v1/push-tokens' || target.searchParams.get('projectionVersion') !== '2') {
                return new Response(null, { status: 404 });
            }
            projectionRequested = true;
            await waitForNetworkResponseForTests(projectionReleased, init?.signal);
            return Response.json({ v: 2, accountRemoteAlerts: { settingsVersion: 9, status: 'current' }, tokens: [] });
        });
        nativeCapabilitiesState.current = null;
        const hook = await renderHook(() => useRemoteAlertRegistrationStatus({
            enabled: true,
            serverId: home.id,
            accountEnabled: true,
            policy: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
            deviceEnabled: true,
            deviceOverrides: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        }));
        await waitForHomeGovernance(() => expect(projectionRequested).toBe(true));
        expect(hook.getCurrent().registration.nativeAvailable).toBe(false);

        nativeCapabilitiesState.current = { v: 1, platform: 'ios', events: ['ready'] };
        await act(async () => {
            releaseProjection();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await waitForHomeGovernance(() => expect(hook.getCurrent().registration).toMatchObject({
            supported: true, nativeAvailable: true, deviceEnrollment: 'enrolling', refreshing: false,
        }));
        expect(hook.getCurrent().registration.nativeAvailable).toBe(true);
        expect(hook.getCurrent().registration.deviceEnrollment).toBe('enrolling');
        expect(readExpoPushTokenSpy).toHaveBeenCalled();
        await hook.unmount();
    });
});
