import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest, isUsernameRequest } from './account.testHelpers';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    getAccountSettingsRouteRouterMockRef,
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';
import 'fake-indexeddb/auto';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
installAccountSettingsRouteModuleMocks({ storageModule: (importOriginal) => importOriginal() });
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
await loadSyncSingletonForTests();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let restoreExecutor: (() => void) | undefined;

const routerMockRef = getAccountSettingsRouteRouterMockRef();

vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: () => ({ remove: () => {} }),
        launchScanner: () => {},
        dismissScanner: async () => {},
    },
}));

async function restoreAccount() {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    account = await createSecretSettingsTestHarness({ features: createAccountFeaturesResponse(),
        settings: settingsParse({ experiments: true, featureToggles: { 'social.friends': true } }) });
    restoreExecutor = await installRealActionExecutorModuleLoader();
    storage.setState({ isDataReady: true, profileScope: account.scope });
}

async function renderAccount() {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { default: AccountScreen } = await import('@/app/(app)/settings/account');
    return await renderSettingsView(<InjectedAuthProvider credentials={account!.credentials}><AccountScreen /></InjectedAuthProvider>);
}

describe('Settings → Account (username)', () => {
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        account = undefined;
        restoreExecutor?.();
        restoreExecutor = undefined;
        resetRuntimeFetch();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        routerMockRef.current?.spies.push.mockReset();
        routerMockRef.current?.spies.back.mockReset();
        routerMockRef.current?.spies.replace.mockReset();
        routerMockRef.current?.spies.setParams.mockReset();
        standardCleanup();
    });

    it('offers the username in the identity header\'s profile editor and saves it when friendsAllowUsername is enabled', async () => {
        await restoreAccount();
        storage.getState().applyProfile({ ...profileDefaults, id: account!.scope.accountId, linkedProviders: [], username: null });

        let usernameOnHome: string | null = null;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return Response.json({});
            }
            if (isFeaturesRequest(url)) {
                return Response.json(createAccountFeaturesResponse());
            }
            if (isUsernameRequest(url)) {
                const body: unknown = JSON.parse(String(init?.body));
                if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'username') !== 'string') throw new Error('Invalid username request');
                usernameOnHome = String(Reflect.get(body, 'username'));
                return Response.json({ username: usernameOnHome });
            }
            if (new URL(url).pathname === '/v1/account/security') return Response.json({ v: 1, encryptionMode: 'plain',
                nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
            return account!.request(input, init);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await import('@/modal');

        const screen = await renderAccount();
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect(await getServerFeaturesSnapshot({ serverId: account!.scope.serverId })).toMatchObject({ status: 'ready',
            features: { features: { social: { friends: { enabled: true } } },
                capabilities: { social: { friends: { allowUsername: true } } } } });
        await vi.waitFor(() => expect(screen.findByTestId('settings-account-edit-profile')).not.toBeNull());
        await screen.pressByTestIdAsync('settings-account-edit-profile');

        await vi.waitFor(() => expect(screen.findByTestId('settings-account-username-field')).not.toBeNull());
        const input = screen.findByTestId('settings-account-username-field');
        expect(input).not.toBeNull();
        await act(async () => { input!.props.onChangeText('alice'); });
        await screen.pressByTestIdAsync('settings-account-profile-save');
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/v1/account/username'),
            expect.objectContaining({ method: 'POST' }),
        );
        expect(usernameOnHome).toBe('alice');
        expect(storage.getState().profile.username).toBe('alice');
    }, 40_000);
});
