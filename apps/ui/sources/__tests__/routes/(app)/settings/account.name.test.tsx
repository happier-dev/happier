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
    account = await createSecretSettingsTestHarness({ features: createAccountFeaturesResponse() });
    restoreExecutor = await installRealActionExecutorModuleLoader();
    storage.setState({ isDataReady: true, profileScope: account.scope });
}

async function renderAccount() {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { default: AccountScreen } = await import('@/app/(app)/settings/account');
    return await renderSettingsView(<InjectedAuthProvider credentials={account!.credentials}><AccountScreen /></InjectedAuthProvider>);
}


type Home = { name: string | null; username: string | null; nameRequests: unknown[]; failName: boolean; whileSaving?: () => void };

function installHome(home: Home) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = getRequestUrl(input);
        const path = new URL(url).pathname;
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return Response.json({});
        if (isFeaturesRequest(url)) return Response.json(createAccountFeaturesResponse());
        if (path === '/v1/account/profile' && init?.method === 'POST') {
            const body: unknown = JSON.parse(String(init.body));
            home.nameRequests.push(body);
            home.whileSaving?.();
            if (home.failName) return Response.json({ error: 'unavailable' }, { status: 503 });
            const name = body && typeof body === 'object' ? Reflect.get(body, 'name') : null;
            home.name = typeof name === 'string' ? name : null;
            return Response.json({ name: home.name, firstName: home.name, lastName: null, timestamp: Date.now() });
        }
        if (isUsernameRequest(url)) {
            const body: unknown = JSON.parse(String(init?.body));
            home.username = String(body && typeof body === 'object' ? Reflect.get(body, 'username') : '');
            return Response.json({ username: home.username });
        }
        if (path === '/v1/account/security') return Response.json({ v: 1, encryptionMode: 'plain',
            nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
        return account!.request(input, init);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    setRuntimeFetch(fetchMock as unknown as typeof fetch);
}

async function openEditor(profile: Partial<typeof profileDefaults>, home: Home) {
    await restoreAccount();
    storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', linkedProviders: [], ...profile });
    installHome(home);
    const screen = await renderAccount();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-edit-profile')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-edit-profile');
    return screen;
}

function headerTitle(screen: Awaited<ReturnType<typeof renderAccount>>): unknown {
    return screen.findAll((node) => node.props.testID === 'settings-account-identity' && 'title' in node.props)[0]?.props.title;
}

describe('Settings → Account (name)', () => {
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        account = undefined;
        restoreExecutor?.();
        restoreExecutor = undefined;
        resetRuntimeFetch();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        routerMockRef.current?.spies.replace.mockReset();
        standardCleanup();
    });

    it('invites an Account without a name to add one, saves it and names the page with it', async () => {
        const home: Home = { name: null, username: null, nameRequests: [], failName: false };
        const screen = await openEditor({ name: null, username: null }, home);

        const field = screen.findByTestId('settings-account-name-field');
        expect(field?.props.placeholder).toBe('settingsAccount.namePlaceholder');
        await act(async () => { field!.props.onChangeText('  Leeroy Brun '); });
        await screen.pressByTestIdAsync('settings-account-profile-save');

        await vi.waitFor(() => expect(storage.getState().profile.name).toBe('Leeroy Brun'));
        expect(home.nameRequests).toEqual([{ name: 'Leeroy Brun' }]);
        await vi.waitFor(() => expect(screen.findByTestId('settings-account-name-field')).toBeNull());
        expect(headerTitle(screen)).toBe('Leeroy Brun');
    }, 40_000);

    it('clears the name when the field is emptied, falling back to the username', async () => {
        const home: Home = { name: 'Leeroy', username: 'lee', nameRequests: [], failName: false };
        const screen = await openEditor({ name: 'Leeroy', username: 'lee' }, home);

        const field = screen.findByTestId('settings-account-name-field');
        expect(field?.props.value).toBe('Leeroy');
        await act(async () => { field!.props.onChangeText('   '); });
        await screen.pressByTestIdAsync('settings-account-profile-save');

        await vi.waitFor(() => expect(storage.getState().profile.name).toBeNull());
        expect(home.nameRequests).toEqual([{ name: null }]);
        expect(home.username).toBe('lee');
        await vi.waitFor(() => expect(headerTitle(screen)).toBe('lee'));
    }, 40_000);

    it('keeps the draft and says so under the field when the Home refuses the name', async () => {
        const home: Home = { name: 'Leeroy', username: null, nameRequests: [], failName: true };
        const screen = await openEditor({ name: 'Leeroy', username: null }, home);

        await act(async () => { screen.findByTestId('settings-account-name-field')!.props.onChangeText('Lee'); });
        await screen.pressByTestIdAsync('settings-account-profile-save');

        await vi.waitFor(() => expect(screen.findByTestId('settings-account-name-field.error')).not.toBeNull());
        expect(screen.getTextContent()).toContain('settingsAccount.nameSaveFailed');
        expect(screen.findByTestId('settings-account-name-field')?.props.value).toBe('Lee');
        expect(storage.getState().profile.name).toBe('Leeroy');
        expect(headerTitle(screen)).toBe('Leeroy');
    }, 40_000);

    it('publishes only the acknowledged name, never re-applying the profile captured when Save was pressed', async () => {
        const home: Home = { name: 'Leeroy', username: 'lee', nameRequests: [], failName: false };
        // The profile moves on while the save is in flight (another device renames the handle).
        home.whileSaving = () => storage.getState().applyProfile({ ...storage.getState().profile, username: 'leeroy' });
        const screen = await openEditor({ name: 'Leeroy', username: 'lee' }, home);

        await act(async () => { screen.findByTestId('settings-account-name-field')!.props.onChangeText('Leeroy Brun'); });
        await screen.pressByTestIdAsync('settings-account-profile-save');

        await vi.waitFor(() => expect(storage.getState().profile.name).toBe('Leeroy Brun'));
        await vi.waitFor(() => expect(screen.findByTestId('settings-account-name-field')).toBeNull());
        expect(storage.getState().profile.username).toBe('leeroy');
        expect(headerTitle(screen)).toBe('Leeroy Brun');
    }, 40_000);
});
