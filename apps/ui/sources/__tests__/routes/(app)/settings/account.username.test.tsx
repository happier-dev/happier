import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest, isUsernameRequest } from './account.testHelpers';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    getAccountSettingsRouteModalMockRef,
    getAccountSettingsRouteRouterMockRef,
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';
import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import 'fake-indexeddb/auto';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
installAccountSettingsRouteModuleMocks({ storageModule: (importOriginal) => importOriginal() });
installDisconnectedServerSocketBoundary();
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
const modalMockRef = getAccountSettingsRouteModalMockRef();

function expectCanonicalConnectedAccountsRoute(): void {
    expect(flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).find((node) => node.id === 'connectedServices'))
        .toMatchObject({ route: '/settings/connected-services' });
}

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
    account = await createSecretSettingsTestHarness();
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
        modalMockRef.current = null;
        standardCleanup();
    });

    it('offers choosing a username from the identity header and saves it when friendsAllowUsername is enabled', async () => {
        await restoreAccount();
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

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
                terminalPresentUserPolicy: 'allowed', nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
            return account!.request(input, init);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        await import('@/modal');

        const screen = await renderAccount();
        await vi.waitFor(() => expect(screen.findRowByTitle('settingsAccount.chooseUsername')).not.toBeNull());
        expect(screen.findRowByTitle('settingsAccount.chooseUsername')?.props.testID).toBe('settings-account-username');

        await act(async () => {
            await screen.pressRowByTitle('settingsAccount.chooseUsername');
        });

        const input = screen.findByTestId('settings-account-username-field');
        expect(input).not.toBeNull();
        await act(async () => { input!.props.onChangeText('alice'); });
        await screen.pressByTestIdAsync('settings-account-username-save');
        expect(modalMockRef.current.spies.prompt).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/v1/account/username'),
            expect.objectContaining({ method: 'POST' }),
        );
        expect(usernameOnHome).toBe('alice');
        expect(storage.getState().profile.username).toBe('alice');
    }, 40_000);

    it('keeps connectedServicesV2 projections out of Account while the canonical Connected Accounts route remains available', async () => {
        await restoreAccount();
        storage.getState().applyProfile({
            ...profileDefaults,
            linkedProviders: [],
            connectedServices: ['openai'],
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
            username: null,
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return Response.json({});
            }
            if (isFeaturesRequest(url)) {
                return Response.json(createAccountFeaturesResponse());
            }
            if (new URL(url).pathname === '/v1/account/security') return Response.json({ v: 1, encryptionMode: 'plain',
                terminalPresentUserPolicy: 'allowed', nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
            return account!.request(input, init);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        const screen = await renderAccount();

        expect(screen.findRowByTitle('connectedServices.serviceNames.openaiCodex')).toBeNull();
        expectCanonicalConnectedAccountsRoute();
    }, 40_000);

    it('keeps retryable connectedServicesV2 projections out of Account while the canonical Connected Accounts route remains available', async () => {
        await restoreAccount();
        storage.getState().applyProfile({
            ...profileDefaults,
            linkedProviders: [],
            connectedServices: [],
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'retryable',
                            status: 'refresh_failed_retryable',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: {
                                v: 1,
                                status: 'refresh_failed_retryable',
                                reconnectRequired: false,
                                lastRefreshFailureKind: 'network_error',
                            },
                        },
                        {
                            profileId: 'reauth',
                            status: 'needs_reauth',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: {
                                v: 1,
                                status: 'needs_reauth',
                                reconnectRequired: true,
                                lastRefreshFailureKind: 'invalid_grant',
                            },
                        },
                    ],
                    groups: [],
                },
            ],
            username: null,
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return Response.json({});
            }
            if (isFeaturesRequest(url)) {
                return Response.json(createAccountFeaturesResponse());
            }
            if (new URL(url).pathname === '/v1/account/security') return Response.json({ v: 1, encryptionMode: 'plain',
                terminalPresentUserPolicy: 'allowed', nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
            return account!.request(input, init);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        setRuntimeFetch(fetchMock as unknown as typeof fetch);

        const screen = await renderAccount();

        expect(screen.findRowByTitle('connectedServices.serviceNames.openaiCodex')).toBeNull();
        expectCanonicalConnectedAccountsRoute();
    }, 40_000);
});
