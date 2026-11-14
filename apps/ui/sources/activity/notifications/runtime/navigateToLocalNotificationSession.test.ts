import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { AppState } from 'react-native';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createOkFetchResponse, createServerFetchWithReachabilityProbe, getServerFetchUrl } from '@/dev/testkit';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { resetServerReachabilitySupervisors, setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { navigateToLocalNotificationSession } from './navigateToLocalNotificationSession';

const boundary = vi.hoisted(() => ({ secrets: new Map<string, string>(), navigate: vi.fn(), push: vi.fn(), alert: vi.fn() }));

// OS storage, presentation and network are boundaries; notification parsing,
// profile selection, credential admission and session navigation remain real.
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => boundary.secrets.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { boundary.secrets.set(key, value); },
    deleteItemAsync: async (key: string) => { boundary.secrets.delete(key); },
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        AppState: { currentState: 'active' },
        Alert: { alert: boundary.alert },
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { navigate: boundary.navigate, push: boundary.push } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('socket.io-client', () => ({ io: () => ({
    connected: false,
    on: () => {}, off: () => {}, connect: () => {}, disconnect: () => {}, emit: () => {},
    emitWithAck: async () => ({ ok: true }), timeout: () => ({ emitWithAck: async () => ({ ok: true }) }),
}) }));

const targetUrl = 'https://local-notification-target.example.test';
const otherUrl = 'https://local-notification-other.example.test';
let targetId: string;
let otherId: string;

function token(accountId: string): string {
    return `e30.${btoa(JSON.stringify({ sub: accountId }))}.signature`;
}

function notificationData() {
    return { sessionId: 'session', serverId: targetId, serverUrl: targetUrl, accountId: 'original-account' };
}

beforeEach(async () => {
    expect(AppState.currentState).toBe('active');
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK', 'false');
    boundary.secrets.clear();
    boundary.navigate.mockClear(); boundary.push.mockClear(); boundary.alert.mockClear();
    setServerReachabilityNetworkAllowed(true);
    const target = profiles.upsertServerProfile({ serverUrl: targetUrl, name: 'Notification Home' });
    targetId = target.id;
    profiles.setActiveServerId(targetId, { scope: 'device' });
    expect(await TokenStorage.setCredentials({ token: token('original-account') })).toBe(true);
    const other = profiles.upsertServerProfile({ serverUrl: otherUrl, name: 'Current Home' });
    otherId = other.id;
    profiles.setActiveServerId(otherId, { scope: 'device' });
    expect(await TokenStorage.setCredentials({ token: token('other-account') })).toBe(true);
    vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async input => {
        const url = getServerFetchUrl(input);
        if (url.pathname === '/v1/account/profile') return createOkFetchResponse(AccountProfileSchema.parse({
            id: url.origin === targetUrl ? 'original-account' : 'other-account',
        }));
        if (url.pathname === '/v1/artifacts') return createOkFetchResponse([]);
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    })));
});

afterEach(async () => {
    await resetServerReachabilitySupervisors();
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('local notification session navigation', () => {
    it('opens the original saved Home and Account while another Home is active', async () => {
        await navigateToLocalNotificationSession(notificationData(), () => false);

        expect(boundary.navigate).toHaveBeenCalledTimes(1);
        const route = new URL(String(boundary.navigate.mock.calls[0]?.[0]), 'https://ui.example.test');
        expect(route.pathname).toBe('/session/session');
        expect(profiles.areServerProfileIdentifiersEquivalent(route.searchParams.get('serverId') ?? '', targetId)).toBe(true);
        expect(profiles.areServerProfileIdentifiersEquivalent(profiles.getActiveServerSnapshot().serverId, targetId)).toBe(true);
        expect(boundary.alert).not.toHaveBeenCalled();
    });

    it('refuses navigation after the original Home is rebound to another Account', async () => {
        profiles.setActiveServerId(targetId, { scope: 'device' });
        expect(await TokenStorage.setCredentials({ token: token('replacement-account') })).toBe(true);
        profiles.setActiveServerId(otherId, { scope: 'device' });

        await navigateToLocalNotificationSession(notificationData(), () => false);

        expect(boundary.navigate).not.toHaveBeenCalled();
        expect(boundary.push).not.toHaveBeenCalled();
        expect(boundary.alert).toHaveBeenCalledTimes(1);
    });

    it('does not navigate when its owner is disposed while Account admission is pending', async () => {
        let disposed = false;
        const navigation = navigateToLocalNotificationSession(notificationData(), () => disposed);
        disposed = true;
        await navigation;

        expect(boundary.navigate).not.toHaveBeenCalled();
        expect(boundary.push).not.toHaveBeenCalled();
        expect(boundary.alert).not.toHaveBeenCalled();
    });
});
