import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import * as SecureStore from 'expo-secure-store';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { renderScreen, standardCleanup, createDeferred } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

const navigation = vi.hoisted(() => ({ params: {} as Record<string, string>, replace: vi.fn(), back: vi.fn(), push: vi.fn() }));
// Hoist the platform boundary before the static credential-store graph loads.
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: navigation.params,
        router: { replace: navigation.replace, back: navigation.back, push: navigation.push } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { AccountSecuritySettingsScreen } = await import('./AccountSecuritySettingsScreen');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreExecutor: (() => void) | undefined;

beforeEach(async () => {
    installHomeGovernanceBoundaries(homes);
    restoreExecutor = await installRealActionExecutorModuleLoader();
    for (const key of Object.keys(navigation.params)) delete navigation.params[key];
    navigation.replace.mockClear(); navigation.back.mockClear(); navigation.push.mockClear();
});
afterEach(async () => {
    standardCleanup(); await connection?.dispose(); connection = undefined;
    restoreExecutor?.(); await homes.reset();
});

async function prepareHomes() {
    const target = await homes.addHome({ name: 'Home A', serverUrl: 'https://security-a.example.test', accountId: 'account-a' });
    const active = await homes.addHome({ name: 'Home B', serverUrl: 'https://security-b.example.test', accountId: 'account-b' });
    for (const serverId of [target, active]) homes.answer(serverId, '/v1/account/security', { body:
        AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: 'plain', nativeEmail: 'person@example.test',
            password: { status: 'not_enrolled', revision: null } }) });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://security-b.example.test', accountId: 'account-b',
        additionalRequestOrigins: ['https://security-a.example.test'], request: homes.request });
    Object.assign(navigation.params, { serverId: target, intent: 'email_password_connect', verificationToken: 'verify-home-a' });
    return { target, active };
}

it('focuses the notice Home through the real credential lifecycle before reading its Account Security', async () => {
    const { target } = await prepareHomes();
    const screen = await renderScreen(<AuthProvider initialCredentials={connection!.credentials}><AccountSecuritySettingsScreen /></AuthProvider>);
    await vi.waitFor(() => expect(homes.requestsFor('/v1/account/security')).not.toHaveLength(0));
    expect(homes.requestsFor('/v1/account/security').every(request => request.serverId === target)).toBe(true);
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledWith({ pathname: '/settings/account/security', params: {
        serverId: target, intent: 'email_password_connect', verificationToken: 'verify-home-a',
    } }));
    expect(screen.findByTestId('settings-account-security-home-switching')).toBeNull();
});

it('keeps Security consumers unmounted while the target device credential read is pending', async () => {
    const nativeWrites = vi.spyOn(SecureStore, 'setItemAsync');
    const { target } = await prepareHomes();
    const targetCredentials = await TokenStorage.getCredentialsForServerUrl('https://security-a.example.test', { serverId: target });
    const persistedTarget = nativeWrites.mock.calls.find(([, value]) => value.includes(targetCredentials!.token));
    expect(persistedTarget).toBeDefined();
    // Rehydrate the exact persisted OS bytes without a warm in-process credential cache.
    await TokenStorage.removeCredentialsForServerUrl('https://security-a.example.test', { serverId: target });
    await SecureStore.setItemAsync(persistedTarget![0], persistedTarget![1]);
    nativeWrites.mockRestore();
    const pending = createDeferred<void>();
    const read = SecureStore.getItemAsync;
    const credentialRead = vi.spyOn(SecureStore, 'getItemAsync').mockImplementation(async (key, options) => {
        const stored = await read(key, options);
        if (stored?.includes(targetCredentials!.token)) await pending.promise;
        return stored;
    });
    try {
        const screen = await renderScreen(<AuthProvider initialCredentials={connection!.credentials}><AccountSecuritySettingsScreen /></AuthProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-security-home-switching')?.props.accessibilityState).toEqual({ busy: true }));
        expect(homes.requestsFor('/v1/account/security')).toHaveLength(0);
        pending.resolve();
        await vi.waitFor(() => expect(homes.requestsFor('/v1/account/security')).not.toHaveLength(0));
    } finally { pending.resolve(); credentialRead.mockRestore(); }
});

it('offers Home recovery without running a Security read when the notice Home has no credentials', async () => {
    const { target } = await prepareHomes();
    await TokenStorage.removeCredentialsForServerUrl('https://security-a.example.test', { serverId: target });
    const screen = await renderScreen(<AuthProvider initialCredentials={connection!.credentials}><AccountSecuritySettingsScreen /></AuthProvider>);
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-signed-out')).not.toBeNull());
    expect(homes.requestsFor('/v1/account/security')).toHaveLength(0);
    await screen.pressByTestIdAsync('settings-account-security-signed-out-action');
    expect(navigation.push).toHaveBeenCalledWith('/?step=home');
});

// A failed device write is the real failure behind the handoff's boolean result.
// Keep the focus/switch/currentness owners real on both the failing and retry paths.
it.each(['retry', 'back'] as const)('offers %s when the native device store refuses exact Home selection', async action => {
    const { target } = await prepareHomes();
    const nativeSet = MMKV.prototype.set;
    let refuseTarget = true;
    const deviceWrite = vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: MMKV, key, value) {
        if (refuseTarget && key === 'server-state-v1' && typeof value === 'string'
            && (JSON.parse(value) as { activeServerId?: string }).activeServerId === target) {
            throw new Error('device_storage_unavailable');
        }
        return nativeSet.call(this, key, value);
    });
    try {
        const screen = await renderScreen(<AuthProvider initialCredentials={connection!.credentials}><AccountSecuritySettingsScreen /></AuthProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-home-switch-failed')).not.toBeNull());
        expect(homes.requestsFor('/v1/account/security')).toHaveLength(0);
        expect(screen.findByTestId('settings-account-security-home-switch-failed')?.props.accessibilityRole).toBe('alert');
        if (action === 'back') {
            await screen.pressByTestIdAsync('settings-account-security-home-switch-failed-secondary-action');
            expect(navigation.back).toHaveBeenCalledOnce();
        } else {
            refuseTarget = false;
            await screen.pressByTestIdAsync('settings-account-security-home-switch-failed-action');
            await vi.waitFor(() => expect(homes.requestsFor('/v1/account/security')).not.toHaveLength(0));
            expect(homes.requestsFor('/v1/account/security').every(request => request.serverId === target)).toBe(true);
            await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledWith({ pathname: '/settings/account/security', params: {
                serverId: target, intent: 'email_password_connect', verificationToken: 'verify-home-a',
            } }));
        }
    } finally { deviceWrite.mockRestore(); }
});
