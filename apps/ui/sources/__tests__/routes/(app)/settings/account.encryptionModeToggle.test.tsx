import React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderSettingsView } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { createEmptyAccountBootstrapHttpResponse, createEmptyAccountMigrationCensusHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import {
    type AccountSecurityGetResponseV1} from '@happier-dev/protocol/auth/accountSecurity';
import {
    AccountEncryptionMigrateRequestSchema,
    createAccountEncryptionMigrateRequestBindingDigestV1} from '@happier-dev/protocol/account/encryptionMigrate';
import {
    computeAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
    encodePasswordCredentialFieldV1} from '@happier-dev/protocol/auth/accountPasswordCredential';
import {
    sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import {
    invalidateAccountEncryptionModeCache,
} from '@/sync/api/account/apiAccountEncryptionMode';
import {
    resetRuntimeFetch,
    setRuntimeFetch,
} from '@/utils/system/runtimeFetch';
import {
    resetServerReachabilitySupervisors,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import {
    resetEndpointSupervisorPoolForTests,
} from '@/sync/runtime/connectivity/endpointSupervisorPool';
import type {
    AccountEncryptionMigrationSessionRow,
} from '@/sync/ops/account/buildAccountEncryptionMigrationStorageDirectives';
import { TokenStorage } from '@/auth/storage/tokenStorage';

import {
    createAccountFeaturesResponse,
    getRequestUrl,
    isFeaturesRequest,
} from './account.testHelpers';
import {
    getAccountSettingsRouteRouterMockRef,
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


installTokenStorageWebPlatformMocks();
installAccountSettingsRouteModuleMocks();

const routerMockRef = getAccountSettingsRouteRouterMockRef();

// UI Vitest selects the real Node crypto ports and libsodium-wrappers already.
// Re-mocking an alias by importing its target can wait on its own factory.
const browser = await installBrowserRuntimeForTests({
    url: 'https://account-settings.example.test', onNavigate: () => {},
});
beforeEach(() => { browser.activate(); browser.window.sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => browser.restore());

const useFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledMock(featureId),
}));

vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: () => ({ remove: () => {} }),
        launchScanner: () => {},
        dismissScanner: async () => {},
    },
}));

const useAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => useAuthMock(),
}));

const activeServerSnapshotState = vi.hoisted(() => ({
    current: {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    },
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.current,
}));
vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>()),
    getActiveServerSnapshot: () => activeServerSnapshotState.current,
}));

const serverFetchMock = vi.hoisted(() => vi.fn(
    async (path: string, init?: RequestInit) => globalThis.fetch(
        new URL(path, 'https://account-settings.test').toString(),
        init,
    ),
));
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/http/client')>()),
    serverFetch: serverFetchMock,
}));

const fetchAccountEncryptionCurrentnessMock =
    vi.hoisted(() => vi.fn());
const fetchAccountSecurityMock = vi.hoisted(() => vi.fn<() => Promise<AccountSecurityGetResponseV1>>(async () => ({
    v: 1 as const,
    encryptionMode: 'plain' as const,
    nativeEmail: null,
    password: { status: 'not_enrolled' as const, revision: null },
})));
const prepareAccountEncryptionModePasswordCredentialMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/auth/accountSecurity', () => ({
    prepareAccountEncryptionModePasswordCredential: prepareAccountEncryptionModePasswordCredentialMock,
}));
vi.mock('@/components/settings/account/accountSecurityActionClient', () => ({
    createAccountSecurityActionClient: () => ({
        read: fetchAccountSecurityMock,
    }),
}));
vi.mock(
    '@/sync/api/account/apiAccountEncryptionMode',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/sync/api/account/apiAccountEncryptionMode')
        >();
        return {
            ...actual,
            fetchAccountEncryptionCurrentness:
                fetchAccountEncryptionCurrentnessMock,
        };
    },
);

vi.mock('@/sync/sync', () => ({
    sync: {
        encryption: {
            decryptAutomationTemplateRaw: vi.fn(async () => null),
        },
        reconfigureSessionDraftRepositoryForAccountMode: vi.fn(),
        // No admitted Account socket exists in this fixture, so reads use the focused Home request.
        getAccountEncryptionObservationBinding: () => null,
    },
}));

vi.mock('@/sync/engine/machines/syncMachines', () => ({
    fetchMachineRows: vi.fn(async () => []),
}));

vi.mock('@/sync/api/account/apiKv', () => ({
    kvList: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

vi.mock('@/sync/api/artifacts/apiArtifacts', () => ({
    fetchArtifacts: vi.fn(async () => []),
    fetchArtifact: vi.fn(),
}));

const fetchSessionInventoryMock =
    vi.hoisted(() => vi.fn<
        () => Promise<readonly AccountEncryptionMigrationSessionRow[]>
    >(async () => []));
vi.mock(
    '@/sync/ops/account/fetchAccountEncryptionMigrationSessionInventory',
    () => ({
        fetchAccountEncryptionMigrationSessionInventory:
            fetchSessionInventoryMock,
    }),
);
const fetchReviewCommentInventoryMock =
    vi.hoisted(() => vi.fn(async () => ({
        v: 1 as const,
        items: [],
    })));
vi.mock(
    '@/sync/domains/reviews/comments/accountEncryptionMigrationApi',
    () => ({
        fetchReviewCommentAccountEncryptionMigrationInventory:
            fetchReviewCommentInventoryMock,
    }),
);
const fetchSessionOrganizationInventoryMock =
    vi.hoisted(() => vi.fn(async () => ({
        version: 0,
        folders: [],
        tags: [],
        labels: [],
    })));
vi.mock(
    '@/sync/ops/account/fetchSessionOrganizationAccountEncryptionMigrationInventory',
    () => ({
        fetchSessionOrganizationAccountEncryptionMigrationInventory:
            fetchSessionOrganizationInventoryMock,
    }),
);

const buildContentKeyBindingMock = vi.hoisted(() => vi.fn(async () => ({
    contentPublicKey: Buffer.from(
        new Uint8Array(32).fill(4),
    ).toString('base64'),
    contentPublicKeySig: 'content-public-key-signature',
})));
vi.mock('@/auth/oauth/contentKeyBinding', () => ({
    buildContentKeyBinding: buildContentKeyBindingMock,
}));

vi.mock('@/auth/flows/challenge', () => ({
    deriveAccountSigningPublicKey: () =>
        new Uint8Array(32).fill(3),
    signAccountPayload: () => new Uint8Array(64).fill(2),
}));

function findEncryptionModeSwitch(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findByTestId('settings-account-encryption-mode-switch');
}

function findEncryptionModeSwitches(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findAllByTestId('settings-account-encryption-mode-switch');
}

function findClientEncryptionRequirementSwitch(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findByTestId('settings-account-client-encryption-requirement-switch');
}

function createReachabilityProbeResponse(): { ok: true; status: 200; json: () => Promise<{ ok: true }> } {
    return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
    };
}

function e2eeTransitionPasswordCredential(expectedRevision: number) {
    const field = (bytes: number) => encodePasswordCredentialFieldV1(new Uint8Array(bytes));
    return {
        expectedRevision,
        credential: {
            v: 1 as const,
            kind: 'e2ee_password_envelope' as const,
            envelope: {
                v: 1 as const,
                accountSigningPublicKey: field(32),
                kdf: {
                    algorithm: 'argon2id13' as const,
                    salt: field(16),
                    opsLimit: 3,
                    memLimitBytes: 64 * 1024 * 1024,
                    outputBytes: 32 as const,
                },
                cipher: {
                    algorithm: 'aes256gcm' as const,
                    nonce: field(12),
                    ciphertext: field(48),
                },
            },
            authVerifier: {
                v: 1 as const,
                hash: {
                    v: 1 as const,
                    algorithm: 'scrypt' as const,
                    parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                    salt: field(16),
                    digest: field(32),
                },
            },
        },
    };
}

const PINNED_CONTENT_PUBLIC_KEY = Buffer.from(
    new Uint8Array(32).fill(4),
).toString('base64');

describe('Settings → Account (encryption mode toggle)', () => {
    beforeEach(async () => {
        await Promise.all([
            resetServerReachabilitySupervisors(),
            resetEndpointSupervisorPoolForTests(),
        ]);
        setRuntimeFetch((input, init) => globalThis.fetch(input, init));
    });

    afterEach(async () => {
        resetRuntimeFetch();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        invalidateAccountEncryptionModeCache();
        fetchAccountEncryptionCurrentnessMock.mockReset();
        fetchAccountSecurityMock.mockReset();
        fetchAccountSecurityMock.mockResolvedValue({
            v: 1,
            encryptionMode: 'plain',
            nativeEmail: null,
            password: { status: 'not_enrolled', revision: null },
        });
        prepareAccountEncryptionModePasswordCredentialMock.mockReset();
        buildContentKeyBindingMock.mockReset();
        buildContentKeyBindingMock.mockResolvedValue({
            contentPublicKey: PINNED_CONTENT_PUBLIC_KEY,
            contentPublicKeySig: 'content-public-key-signature',
        });
        fetchSessionInventoryMock.mockReset();
        fetchSessionInventoryMock.mockResolvedValue([]);
        fetchReviewCommentInventoryMock.mockReset();
        fetchReviewCommentInventoryMock.mockResolvedValue({
            v: 1,
            items: [],
        });
        fetchSessionOrganizationInventoryMock.mockReset();
        fetchSessionOrganizationInventoryMock.mockResolvedValue({
            version: 0,
            folders: [],
            tags: [],
            labels: [],
        });
        activeServerSnapshotState.current = {
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        };
        routerMockRef.current?.spies.push.mockReset();
        await Promise.all([
            resetServerReachabilitySupervisors(),
            resetEndpointSupervisorPoolForTests(),
        ]);
    });

    it('does not fetch account encryption mode when the feature gate is disabled', async () => {
        useFeatureEnabledMock.mockReturnValue(false);
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't' },
            logout: vi.fn(),
            login: vi.fn(),
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [],
            username: null,
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (url.endsWith('/v1/auth/ping') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (isFeaturesRequest(url)) {
                return Response.json(createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: false }));
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { AccountEncryptionSettingsSection: AccountScreen } = await import('@/components/settings/account/AccountEncryptionSettingsSection');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await act(async () => {});

            expect(findEncryptionModeSwitches(screen)).toHaveLength(0);
        } finally {
            await screen?.unmount();
        }
    });

    it('keeps Account encryption enabled while this client requires E2EE', async () => {
        useFeatureEnabledMock.mockImplementation((featureId: string) => featureId === 'encryption.accountOptOut');
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            logout: vi.fn(),
            login: vi.fn(),
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [],
            username: null,
        });
        storage.getState().applySettingsLocal({
            clientEncryptionRequirementV1: 'require_e2ee',
            clientEncryptionRequirementLocalV1: 'require_e2ee',
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') return createReachabilityProbeResponse();
            if (url.endsWith('/v1/auth/ping') && method === 'GET') return createReachabilityProbeResponse();
            if (isFeaturesRequest(url)) {
                return Response.json(createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: true }));
            }
            if (url.endsWith('/v1/account/encryption') && method === 'GET') {
                return Response.json({ mode: 'e2ee', updatedAt: 1 });
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { AccountEncryptionSettingsSection: AccountScreen } = await import('@/components/settings/account/AccountEncryptionSettingsSection');
        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await vi.waitFor(() => {
                expect(findClientEncryptionRequirementSwitch(screen!)?.props.value).toBe(true);
                expect(findEncryptionModeSwitch(screen!)?.props.disabled).toBe(true);
            });
        } finally {
            await screen?.unmount();
            storage.getState().applySettingsLocal({
                clientEncryptionRequirementV1: 'follow_account',
                clientEncryptionRequirementLocalV1: 'follow_account',
            });
        }
    });


    it('withdraws a recovery CTA before same-scope refetches and across credential and server scope changes', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        const authState: { credentials: { token: string } } = {
            credentials: { token: 'account-a-token' },
        };
        const TestAuthContext = React.createContext({
            isAuthenticated: true,
            credentials: authState.credentials,
            logout: vi.fn(),
            login: vi.fn(),
        });
        useAuthMock.mockImplementation(() => React.useContext(TestAuthContext));
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-a',
            linkedProviders: [],
            username: null,
        });

        let resolveSameScopeMode!: (response: Response) => void;
        const sameScopeMode = new Promise<Response>((resolve) => {
            resolveSameScopeMode = resolve;
        });
        let resolveCredentialBMode!: (response: Response) => void;
        const credentialBMode = new Promise<Response>((resolve) => {
            resolveCredentialBMode = resolve;
        });
        let resolveServerBMode!: (response: Response) => void;
        const serverBMode = new Promise<Response>((resolve) => {
            resolveServerBMode = resolve;
        });
        let accountAModeRequests = 0;
        let accountBModeRequests = 0;
        const { AccountEncryptionSettingsSection: AccountScreen } = await import('@/components/settings/account/AccountEncryptionSettingsSection');
        const TestableAccountScreen = AccountScreen as React.ComponentType<{
            testScopeRevision: number;
        }>;
        const renderAccountScreen = (testScopeRevision: number) => (
            <TestAuthContext.Provider value={{
                isAuthenticated: true,
                credentials: authState.credentials,
                logout: vi.fn(),
                login: vi.fn(),
            }}>
                <TestableAccountScreen testScopeRevision={testScopeRevision} />
            </TestAuthContext.Provider>
        );
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (url.endsWith('/v1/auth/ping') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (isFeaturesRequest(url)) {
                return Response.json(createAccountFeaturesResponse({
                        encryptionAccountOptOutEnabled: true,
                    }));
            }
            if (url.endsWith('/v2/account/settings/history') && method === 'GET') {
                return new Response(JSON.stringify({ snapshots: [] }), {
                    status: 200,
                });
            }
            if (url.endsWith('/v1/account/encryption') && method === 'GET') {
                const authorization = new Headers(init?.headers).get('Authorization');
                if (authorization === 'Bearer account-a-token') {
                    accountAModeRequests += 1;
                    return await (
                        accountAModeRequests === 1
                            ? new Response(JSON.stringify({
                                error: 'account-encryption-recovery-required',
                            }), { status: 400 })
                            : sameScopeMode
                    );
                }
                if (authorization === 'Bearer account-b-token') {
                    accountBModeRequests += 1;
                    return await (
                        accountBModeRequests === 1
                            ? credentialBMode
                            : serverBMode
                    );
                }
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { Modal } = await import('@/modal');
        const alertSpy = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(
                renderAccountScreen(0),
            );
            await flushHookEffects();
            await vi.waitFor(() => {
                expect(
                    screen!.findByTestId('settings-account-encryption-recovery'),
                ).toBeTruthy();
            });

            authState.credentials = { token: 'account-a-token' };
            await screen.update(renderAccountScreen(1));

            await vi.waitFor(() => {
                expect(accountAModeRequests).toBe(2);
            });
            expect(
                screen.findByTestId('settings-account-encryption-recovery'),
            ).toBeNull();

            await act(async () => {
                resolveSameScopeMode(new Response(JSON.stringify({
                    error: 'migration-required',
                }), { status: 400 }));
                await Promise.resolve();
            });
            await vi.waitFor(() => {
                expect(alertSpy).toHaveBeenCalledWith(
                    'common.error',
                    'Failed to load encryption setting',
                );
            });
            expect(
                screen.findByTestId('settings-account-encryption-recovery'),
            ).toBeNull();

            authState.credentials = { token: 'account-b-token' };
            await screen.update(renderAccountScreen(2));

            expect(
                screen.findByTestId('settings-account-encryption-recovery'),
            ).toBeNull();
            await vi.waitFor(() => {
                expect(accountBModeRequests).toBe(1);
            });

            await act(async () => {
                resolveCredentialBMode(new Response(JSON.stringify({
                    error: 'account-encryption-recovery-required',
                }), { status: 400 }));
                await Promise.resolve();
            });
            await vi.waitFor(() => {
                expect(
                    screen!.findByTestId('settings-account-encryption-recovery'),
                ).toBeTruthy();
            });

            activeServerSnapshotState.current = {
                serverId: 'server-b',
                serverUrl: 'https://server-b.example.test',
                generation: 2,
            };
            await screen.update(renderAccountScreen(3));

            expect(
                screen.findByTestId('settings-account-encryption-recovery'),
            ).toBeNull();
            await vi.waitFor(() => {
                expect(accountBModeRequests).toBe(2);
            });

            await act(async () => {
                resolveServerBMode(new Response(JSON.stringify({
                    error: 'migration-required',
                }), { status: 400 }));
                await Promise.resolve();
            });
            await vi.waitFor(() => {
                expect(alertSpy).toHaveBeenCalledWith(
                    'common.error',
                    'Failed to load encryption setting',
                );
            });
            expect(
                screen.findByTestId('settings-account-encryption-recovery'),
            ).toBeNull();
        } finally {
            await screen?.unmount();
        }
    });

});

// Preserve the incumbent family only for unchanged cases. Changed admission,
// custody and migration cases below exercise every internal Account owner.
const currentAccountOwnerModules = [
    '@/hooks/server/useFeatureEnabled', '@/auth/context/AuthContext',
    '@/hooks/server/useActiveServerSnapshot', '@/sync/domains/server/serverRuntime',
    '@/sync/http/client', '@/sync/api/auth/accountSecurity',
    '@/components/settings/account/accountSecurityActionClient',
    '@/sync/api/account/apiAccountEncryptionMode', '@/sync/sync',
    '@/sync/engine/machines/syncMachines', '@/sync/api/account/apiKv',
    '@/sync/api/artifacts/apiArtifacts',
    '@/sync/ops/account/fetchAccountEncryptionMigrationSessionInventory',
    '@/sync/domains/reviews/comments/accountEncryptionMigrationApi',
    '@/sync/ops/account/fetchSessionOrganizationAccountEncryptionMigrationInventory',
    '@/auth/oauth/contentKeyBinding', '@/auth/flows/challenge',
    '@/sync/domains/state/storage',
] as const;

async function mountCurrentEncryptionHome(params: Readonly<{
    mode: 'plain' | 'e2ee';
    retainedCredential?: boolean;
    ownerMaterialUnavailable?: boolean;
    provider?: 'mtls' | 'github';
    password?: boolean;
    mutableDeviceCustody?: boolean;
}> = { mode: 'plain' }) {
    await import('fake-indexeddb/auto');
    const { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    installDisconnectedServerSocketBoundary();
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const restoreExecutor = await installRealActionExecutorModuleLoader();
    let mode = params.mode;
    let rejectModeRead = false;
    let accountVersion = 4;
    let settingsVersion = 0;
    let settingsContent: unknown = null;
    const serverUrl = 'https://encryption-' + crypto.randomUUID() + '.example.test';
    const homeIdentity = 'srv_' + crypto.randomUUID();
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    await adoptHomeProfile({ source: 'manual', descriptorAuthority: 'current_connection_observation', descriptor: {
        v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }],
    } });
    const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const token = createAccountTokenForTests('account-a', { currentAccount: true });
    const credentials = mode === 'e2ee' || params.retainedCredential
        ? { token, secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') }
        : { token };
    const migrations: import('@happier-dev/protocol/account/encryptionMigrate').AccountEncryptionMigrateRequest[] = [];
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const passwordProof = { provider: 'email_password', pending: 'password-step-up-pending', proof: 'password-step-up-proof' };
    let signingKeyFingerprint: string | null = null;
    let contentKeyFingerprint: string | null = null;
    let preparedPasswordCredential: unknown;
    let restorePasswordWorker = () => {};
    if (params.password) {
        // Node has no Web Worker. Adapt only its cloned message ports; run the
        // canonical worker handler and actual Argon2 WASM primitive unchanged.
        const previousWorker = globalThis.Worker;
        const previousHandler = globalThis.onmessage;
        const previousPostMessage = globalThis.postMessage;
        let activeWorker: PasswordWorkerPort | null = null;
        class PasswordWorkerPort {
            onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
            onerror: (() => void) | null = null;
            onmessageerror: (() => void) | null = null;
            constructor() { activeWorker = this; }
            postMessage(input: unknown) {
                const cloned = structuredClone(input);
                queueMicrotask(() => { void Promise.resolve(workerHandler(new MessageEvent('message', { data: cloned }))).catch(() => this.onerror?.()); });
            }
            terminate() { if (activeWorker === this) activeWorker = null; }
        }
        vi.stubGlobal('onmessage', null);
        vi.stubGlobal('postMessage', (message: unknown) => {
            const cloned = structuredClone(message);
            activeWorker?.onmessage?.(new MessageEvent('message', { data: cloned }));
        });
        await import('@/auth/password/passwordKdf.worker');
        // This process-global callback is the Worker port, not a Window handler.
        const registeredWorkerHandler: unknown = globalThis.onmessage;
        if (typeof registeredWorkerHandler !== 'function') throw new Error('Expected canonical password worker handler');
        const workerHandler = (event: MessageEvent<unknown>): unknown => registeredWorkerHandler(event);
        vi.stubGlobal('Worker', PasswordWorkerPort);
        restorePasswordWorker = () => {
            vi.stubGlobal('Worker', previousWorker);
            vi.stubGlobal('onmessage', previousHandler);
            vi.stubGlobal('postMessage', previousPostMessage);
        };
    }
    if (params.password || mode === 'e2ee') {
        const { deriveAccountSigningPublicKey } = await import('@/auth/flows/challenge');
        const { buildContentKeyBinding } = await import('@/auth/oauth/contentKeyBinding');
        signingKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(new Uint8Array(32).fill(7)));
        const binding = await buildContentKeyBinding(new Uint8Array(32).fill(7));
        contentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(new Uint8Array(Buffer.from(binding.contentPublicKey, 'base64')));
    }
    // Full source documents remain at the HTTP fixture boundary for demanded
    // reads. Only the sealed owner material is deliberately from another key.
    const { createSessionListSourceFixture } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const ownerInventory = createSessionListSourceFixture({ sessions: params.ownerMaterialUnavailable ? [{
        id: 'session-locked', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, archivedAt: null,
        encryptionMode: 'e2ee', metadata: 'shared-metadata', metadataLayoutVersion: 1, metadataVersion: 7,
        agentState: null, agentStateVersion: 8, dataEncryptionKey: null, share: null,
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
            ownerMetadata: { v: 1 }, randomBytes: length => new Uint8Array(length).fill(9) }),
    }] : [], hasNext: false, nextCursor: null });
    const account = await restoreServerAccountForTest({
        serverUrl, accountId: 'account-a', credentials,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            const method = init?.method ?? 'GET';
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            requests.push({ path, method, body });
            if (path === '/health') return Response.json({});
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: true }));
            if (path === '/v1/account/encryption') return rejectModeRead
                ? Response.json({ error: 'migration-required' }, { status: 400 })
                : Response.json({ mode, updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode, version: accountVersion,
                updatedAt: 1, signingKeyFingerprint, contentKeyFingerprint,
                recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } });
            if (path === '/v1/account/security') return Response.json({ v: 1, encryptionMode: mode,
                nativeEmail: params.password ? 'person@example.test' : null,
                password: params.password ? { status: 'enrolled', revision: 5 } : { status: 'not_enrolled', revision: null } });
            if (path === '/v1/auth/entry' && method === 'POST') return Response.json({ v: 1, state: 'ready', scope: { kind: 'home' },
                actions: [{ kind: 'authenticate', methodId: params.provider, action: 'login', mode: 'keyless', origin: 'home',
                    presentation: { displayName: params.provider } }], autoRedirect: null });
            if (path === '/v1/auth/mtls' && method === 'POST') return Response.json({ success: true, pending: 'mtls-pending' });
            if (path === '/v1/auth/external/github/params') return Response.json({ url: 'https://github.example.test/authorize' });
            if (path === '/v1/auth/email/step-up' && method === 'POST') return Response.json({ externalAuthProof: passwordProof });
            if (path === '/v1/auth/password/mutation/challenge' && method === 'POST') {
                const { PasswordMutationPreparationRequestV1Schema, PasswordMutationPreparationResponseV1Schema} = await import('@happier-dev/protocol/auth/accountSecurity');
                const preparation = PasswordMutationPreparationRequestV1Schema.parse(body);
                if (!('newE2eePassword' in preparation)) throw new Error('Expected encrypted password preparation');
                const targetCredential = { ...e2eeTransitionPasswordCredential(5).credential, envelope: preparation.newE2eePassword.envelope };
                preparedPasswordCredential = { expectedRevision: 5, credential: targetCredential };
                return Response.json(PasswordMutationPreparationResponseV1Schema.parse({ targetCredential }));
            }
            if (path === '/v2/account/settings') return Response.json({ content: settingsContent, version: settingsVersion });
            if (path === '/v2/sessions/read-batch') return null;
            if (path === '/v2/sessions/session-locked') return Response.json({ session: ownerInventory.sessions[0] });
            if (path === '/v2/sessions') return Response.json(ownerInventory);
            if (path === '/v2/sessions/active' || path === '/v2/sessions/archived') return Response.json({ sessions: [], hasNext: false, nextCursor: null });
            if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/kv') return Response.json({ items: [], nextCursor: null });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-a',
                linkedProviders: params.provider ? [{ id: params.provider, login: 'fixture-user', displayName: 'Fixture user',
                    avatarUrl: null, profileUrl: null, showOnProfile: false }] : [],
            });
            if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
            const bootstrapResponse = createEmptyAccountMigrationCensusHttpResponse(path, init)
                ?? createEmptyAccountBootstrapHttpResponse(path, init);
            if (bootstrapResponse) return bootstrapResponse;
            if (path === '/v1/account/encryption/migrate/review-comments/inventory') return Response.json({ v: 1, items: [] });
            if (path === '/v1/account/encryption/migrate/session-organization/inventory') return Response.json({ version: 0, folders: [], tags: [], labels: [] });
            if (path === '/v1/account/encryption/migrate/automations/inventory') return Response.json({ templates: [], runs: [] });
            if (path === '/v1/account/encryption/artifacts') return Response.json({ ownerAccountId: 'account-a', encryptionMode: mode, items: [], nextCursor: null });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            if (path === '/v1/account/encryption/migrate' && method === 'POST') {
                const migration = AccountEncryptionMigrateRequestSchema.parse(body);
                const replay = migrations.some(previous => JSON.stringify(previous) === JSON.stringify(migration));
                migrations.push(migration);
                if (!replay) {
                    mode = migration.toMode;
                    settingsContent = migration.settingsContent;
                    settingsVersion += 1;
                    accountVersion += 1;
                    if (migration.keyProof) {
                        signingKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(new Uint8Array(Buffer.from(migration.keyProof.publicKey, 'base64')));
                        const contentPublicKey = migration.keyProof.contentPublicKey;
                        if (typeof contentPublicKey !== 'string') throw new Error('Expected migration Account content-key binding');
                        contentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(new Uint8Array(Buffer.from(contentPublicKey, 'base64')));
                    }
                }
                return Response.json({ success: true, mode, accountVersion, settingsVersion,
                    ...(migration.providerConnections ? { providerConnections: {
                        row: { revision: migration.providerConnections.expectedRevision, content: null },
                    } } : {}),
                    ...(migration.profileRows ? { profileRows: {
                        rows: [], referenceGuardRevision: 'absent', transferControl: { status: 'absent' },
                    } } : {}),
                });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
    const { storage: currentStorage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await queue.awaitQueue();
    currentStorage.getState().applySettingsLocal({ clientEncryptionRequirementV1: 'follow_account',
        clientEncryptionRequirementLocalV1: 'follow_account', experiments: true, featureToggles: { 'encryption.accountOptOut': true } });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    await vi.waitFor(() => expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({
        serverId: account.serverId, accountId: 'account-a',
    }));
    currentStorage.setState({ isDataReady: true });
    const { InjectedAuthProvider, AuthProvider } = await import('@/auth/context/AuthContext');
    const { AccountEncryptionSettingsSection } = await import('@/components/settings/account/AccountEncryptionSettingsSection');
    const { renderSettingsView: renderCurrentSettings } = await import('@/dev/testkit');
    const { Modal } = await import('@/modal');
    const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    const alert = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();
    const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('current plain password');
    const { TokenStorage: currentTokens } = await import('@/auth/storage/tokenStorage');
    let rejectNextCredentialWrite = false;
    const credentialWrites: unknown[] = [];
    // Observe only adopted credentials at the native browser storage port;
    // pending continuation documents carry no root bearer.
    const storagePort = Object.getPrototypeOf(browser.storage) as Storage;
    const actualSetItem = storagePort.setItem;
    const writeBoundary = params.mutableDeviceCustody ? vi.spyOn(storagePort, 'setItem').mockImplementation(function (this: Storage, key, value) {
        let written: unknown;
        try { written = JSON.parse(value); } catch { written = null; }
        if (written && typeof written === 'object' && Reflect.get(written, 'token') === credentials.token
            && typeof Reflect.get(written, 'secret') === 'string') {
            credentialWrites.push(written);
            if (rejectNextCredentialWrite) {
                rejectNextCredentialWrite = false;
                throw new Error('Browser storage write unavailable');
            }
        }
        actualSetItem.call(this, key, value);
    }) : null;
    const render = async () => renderCurrentSettings(params.mutableDeviceCustody
        ? <AuthProvider initialCredentials={await currentTokens.getCredentialsForServerUrl(serverUrl, { serverId: account.serverId })}><AccountEncryptionSettingsSection /></AuthProvider>
        : <InjectedAuthProvider credentials={credentials}><AccountEncryptionSettingsSection /></InjectedAuthProvider>);
    let screen = await render();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-encryption-mode-switch')?.props.disabled).toBe(false));
    return { account, credentials, migrations, requests, get screen() { return screen; }, alert, currentStorage, credentialWrites,
        get mode() { return mode; }, get settingsContent() { return settingsContent; },
        get preparedPasswordCredential() { return preparedPasswordCredential; },
        rejectNextCredentialWrite() { rejectNextCredentialWrite = true; },
        rejectModeRead() { rejectModeRead = true; },
        async remount() { await screen.unmount(); screen = await render(); },
        async dispose() { await screen.unmount(); writeBoundary?.mockRestore(); await account.dispose(); confirm.mockRestore(); alert.mockRestore(); prompt.mockRestore(); restorePasswordWorker(); restoreExecutor(); } };
}

describe('Account encryption current Home authority', () => {
    beforeAll(() => {
        // Retire the preceding legacy fixture graph once. Real Home cases share
        // one Sync/transport/Auth graph for their complete Account lifecycles.
        currentAccountOwnerModules.forEach((id) => vi.doUnmock(id));
        vi.resetModules();
    });
    it('keeps a generic migration-required mode response fail-closed without a Secret Key recovery CTA', async () => {
        const home = await mountCurrentEncryptionHome();
        try {
            home.rejectModeRead();
            (await import('@/sync/api/account/apiAccountEncryptionMode')).invalidateAccountEncryptionModeCache();
            await home.remount();
            await vi.waitFor(() => expect(home.alert).toHaveBeenCalledWith('common.error', 'Failed to load encryption setting'));
            expect(home.screen.findByTestId('settings-account-encryption-recovery')).toBeNull();
            expect(home.migrations).toEqual([]);
        } finally { await home.dispose(); }
    });

    it('publishes authoritative plaintext mode without requiring retirement of historical credentials', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'plain', retainedCredential: true });
        try {
            expect(home.screen.findByTestId('settings-account-encryption-mode-switch')?.props.value).toBe(false);
            const { getCurrentAuth } = await import('@/auth/context/currentAuth');
            const { TokenStorage: currentTokens } = await import('@/auth/storage/tokenStorage');
            expect(getCurrentAuth()?.credentials).toEqual(home.credentials);
            await expect(currentTokens.getCredentialsForServerUrl(home.account.home.serverUrl)).resolves.toEqual(home.credentials);
            expect(home.migrations).toEqual([]);
            expect(home.alert).not.toHaveBeenCalled();
        } finally { await home.dispose(); }
    });

    it('preserves historical credentials without replacement or retry after disabling Account encryption', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'e2ee' });
        try {
            await act(async () => { await home.screen.findByTestId('settings-account-encryption-mode-switch')?.props.onValueChange(false); });
            expect(home.migrations, home.requests.map(({ method, path }) => `${method} ${path}`).join('\n')).toHaveLength(1);
            expect(home.migrations[0]).toMatchObject({ toMode: 'plain', expectedAccountVersion: 4,
                expectedSettingsVersion: 0, settingsContent: { t: 'plain' } });
            expect(home.mode).toBe('plain');
            expect(home.screen.findByTestId('settings-account-encryption-mode-switch')?.props.value).toBe(false);
            const { getCurrentAuth } = await import('@/auth/context/currentAuth');
            expect(getCurrentAuth()?.credentials).toEqual(home.credentials);
            // The injected device custody boundary refuses mutation; successful
            // mode transition therefore proves retirement was never required.
            expect(home.alert).not.toHaveBeenCalled();
            expect(JSON.stringify(home.settingsContent)).not.toContain(Reflect.get(home.credentials, 'secret'));
        } finally { await home.dispose(); }
    });

    it('refuses a stale encryption control after the mounted Account lifetime disconnects', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'e2ee' });
        try {
            const staleControl = home.screen.findByTestId('settings-account-encryption-mode-switch');
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
            const before = home.requests.length;
            await act(async () => { await staleControl?.props.onValueChange(false); });
            expect(home.migrations).toEqual([]);
            expect(home.requests.slice(before).some(row => row.path.includes('/encryption/migrate') || row.path === '/v1/auth/email/step-up')).toBe(false);
        } finally { await home.dispose(); }
    });

    it('aborts before POST when Session owner material is unavailable', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'e2ee', ownerMaterialUnavailable: true });
        try {
            await act(async () => { await home.screen.findByTestId('settings-account-encryption-mode-switch')?.props.onValueChange(false); });
            await vi.waitFor(() => expect(home.alert).toHaveBeenCalledWith('common.error', 'settingsAccount.encryptionUpdateFailed'));
            expect(home.requests.some(row => row.path === '/v2/sessions/archived')).toBe(true);
            expect(home.migrations).toEqual([]);
            expect(home.mode).toBe('e2ee');
            expect(home.alert).toHaveBeenCalledWith('common.error', 'settingsAccount.encryptionUpdateFailed');
        } finally { await home.dispose(); }
    });

    it('emits the request-bound body only for a restored pinned Account key', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'plain', retainedCredential: true, password: true, mutableDeviceCustody: true });
        try {
            await act(async () => {
                await home.screen.findByTestId('settings-account-encryption-mode-switch')?.props.onValueChange(true);
                // The rendered Switch dispatches a native event; its return value is
                // not the completion of the password Worker or migration request.
                await vi.waitFor(() => expect(home.migrations, home.requests.map(({ method, path }) => `${method} ${path}`).join('\n')).toHaveLength(1));
            });
            const migration = home.migrations[0];
            expect(migration).toMatchObject({ toMode: 'e2ee', expectedAccountVersion: 4, expectedSettingsVersion: 0,
                expectedSigningKeyFingerprint: expect.any(String), expectedContentKeyFingerprint: expect.any(String),
                settingsContent: { t: 'encrypted' }, passwordCredential: home.preparedPasswordCredential,
                externalAuthProof: { provider: 'email_password', pending: 'password-step-up-pending', proof: 'password-step-up-proof' } });
            expect(migration.keyProof).not.toHaveProperty('challenge');
            const { externalAuthProof: _proof, ...boundRequest } = migration;
            expect(home.requests.filter(row => row.path === '/v1/auth/email/step-up').map(row => row.body)).toEqual([{
                v: 1, password: 'current plain password', purpose: 'account_encryption_first_key',
                requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({ request: boundRequest, accountId: 'account-a', sourceMode: 'plain' }),
            }]);
            expect(home.mode).toBe('e2ee');
            const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
            const { openAccountScopedBlobCiphertext } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
            const content = migration.settingsContent;
            if (!content) throw new Error('Expected migrated Settings envelope');
            expect(content.t).toBe('encrypted');
            if (content.t !== 'encrypted') throw new Error('Expected encrypted Settings');
            expect(openAccountScopedBlobCiphertext({ kind: 'account_settings',
                material: resolveAccountScopedCryptoMaterialFromCredentials(home.credentials), ciphertext: content.c,
            })?.value).toMatchObject({ clientEncryptionRequirementV1: 'follow_account' });
            expect(home.alert).not.toHaveBeenCalled();
        } finally { await home.dispose(); }
    });

    it('replays retained mTLS custody after credential persistence fails without issuing a second challenge', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'plain', provider: 'mtls', mutableDeviceCustody: true });
        try {
            const { TokenStorage: currentTokens } = await import('@/auth/storage/tokenStorage');
            await currentTokens.clearPendingExternalAuth();
            home.rejectNextCredentialWrite();
            const control = home.screen.findByTestId('settings-account-encryption-mode-switch');
            await act(async () => {
                await control?.props.onValueChange(true);
                // The rendered Switch dispatches a native event; its return value does not await the
                // migration request, the rejected credential write or the failure alert.
                await vi.waitFor(() => {
                    expect(home.migrations, home.requests.map(({ method, path }) => `${method} ${path}`).join('\n')).toHaveLength(1);
                    expect(home.credentialWrites).toHaveLength(1);
                    expect(home.alert).toHaveBeenCalled();
                });
            });
            const retained = await currentTokens.readPendingExternalAuthStateForServerUrl(home.account.home.serverUrl, { serverId: home.account.serverId });
            expect(retained.value?.accountEncryptionFirstKey?.migrationSubmissionAttempted).toBe(true);
            expect(retained.value?.provider).toBe('mtls');
            await act(async () => {
                await control?.props.onValueChange(true);
                await vi.waitFor(() => expect(home.migrations).toHaveLength(2));
            });
            expect(home.requests.filter(row => row.path === '/v1/auth/mtls' && row.method === 'POST')).toHaveLength(1);
            expect(home.migrations[1]).toEqual(home.migrations[0]);
            expect(home.migrations[0].externalAuthProof).toMatchObject({ provider: 'mtls', pending: 'mtls-pending', proof: expect.any(String) });
            const challenge = home.requests.find(row => row.path === '/v1/auth/mtls')?.body;
            const { externalAuthProof: _proof, ...boundRequest } = home.migrations[0];
            expect(challenge).toMatchObject({ purpose: 'account_encryption_first_key', proofHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({ request: boundRequest, accountId: 'account-a', sourceMode: 'plain' }) });
            expect(home.credentialWrites).toHaveLength(2);
            const { getCurrentAuth } = await import('@/auth/context/currentAuth');
            await vi.waitFor(() => expect(getCurrentAuth()?.credentials).toEqual(home.credentialWrites[1]));
            expect(home.credentialWrites[1]).toMatchObject({ token: home.credentials.token, secret: expect.any(String) });
            await expect(currentTokens.readPendingExternalAuthStateForServerUrl(home.account.home.serverUrl, { serverId: home.account.serverId })).resolves.toEqual({ value: null, serverMismatch: false });
            expect(home.mode).toBe('e2ee');
        } finally { await home.dispose(); }
    });

    it('automatically resumes retained OAuth custody after authoritative E2EE hydration', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'plain', provider: 'github', mutableDeviceCustody: true });
        // External browser navigation is the OS boundary; custody/request
        // construction and callback recovery remain the real canonical owners.
        const { Linking } = await import('react-native');
        const canOpen = vi.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
        const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
        try {
            const { TokenStorage: currentTokens } = await import('@/auth/storage/tokenStorage');
            await currentTokens.clearPendingExternalAuth();
            await act(async () => { await home.screen.findByTestId('settings-account-encryption-mode-switch')?.props.onValueChange(true); });
            const pending = await currentTokens.readPendingExternalAuthStateForServerUrl(home.account.home.serverUrl, { serverId: home.account.serverId });
            expect(pending.value?.provider, home.requests.map(({ method, path }) => `${method} ${path}`).join('\n')).toBe('github');
            expect(pending.value?.accountEncryptionFirstKey).toMatchObject({ accountId: 'account-a', requestJson: expect.any(String) });
            expect(home.migrations).toEqual([]);
            home.rejectNextCredentialWrite();
            const { getCurrentAuth } = await import('@/auth/context/currentAuth');
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected real mounted Auth');
            const { resumeAccountEncryptionFirstKeyExternalAuth: resumeCurrent } = await import('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth');
            await expect(resumeCurrent({ provider: 'github', pending: 'oauth-pending', currentCredentials: home.credentials,
                target: { serverId: home.account.serverId, serverUrl: home.account.home.serverUrl }, persistCredentials: auth.loginWithCredentials })).rejects.toThrow('Failed to save credentials');
            expect(home.migrations, home.requests.map(({ method, path }) => `${method} ${path}`).join('\n')).toHaveLength(1);
            expect(home.credentialWrites).toHaveLength(1);
            const beforeRemount = home.requests.length;
            await home.remount();
            await vi.waitFor(() => expect(home.credentialWrites).toHaveLength(2));
            expect(home.migrations).toHaveLength(2);
            expect(home.migrations[1]).toEqual(home.migrations[0]);
            expect(home.requests.slice(beforeRemount).some(row => row.path.startsWith('/v1/auth/external/') || row.path === '/v1/auth/mtls')).toBe(false);
            await vi.waitFor(async () => expect(await currentTokens.readPendingExternalAuthStateForServerUrl(home.account.home.serverUrl,
                { serverId: home.account.serverId })).toEqual({ value: null, serverMismatch: false }));
            expect(home.mode).toBe('e2ee');
            expect(home.alert).not.toHaveBeenCalled();
        } finally { canOpen.mockRestore(); open.mockRestore(); await home.dispose(); }
    });

    it('aborts before the migration request when e2ee content-key binding construction fails', async () => {
        const home = await mountCurrentEncryptionHome({ mode: 'plain' });
        const hmac = await import('@/platform/hmacSha512');
        // Fault the platform crypto port after hydration. Signing-key
        // preparation remains real; content-key derivation reaches this port.
        const cryptoFailure = vi.spyOn(hmac, 'hmacSha512').mockRejectedValue(new Error('binding unavailable'));
        try {
            await act(async () => { await home.screen.findByTestId('settings-account-encryption-mode-switch')?.props.onValueChange(true); });
            expect(cryptoFailure).toHaveBeenCalled();
            expect(home.migrations).toEqual([]);
            expect(home.mode).toBe('plain');
            expect(home.alert).toHaveBeenCalled();
        } finally { cryptoFailure.mockRestore(); await home.dispose(); }
    });
});

describe('Account encryption recovery through the current Home boundary', () => {
    it.each([
        { title: 'offers Secret Key recovery for a saved legacy credential with Account opt-out disabled', legacy: true, optOut: false },
        { title: 'opens manual Secret Key recovery only when Account encryption explicitly requires it', legacy: false, optOut: true },
    ])('$title', async ({ legacy, optOut }) => {
        // The remaining incumbent migration/mock family is a distinct P2 lane;
        // these changed recovery-policy cases run no internal authority mocks.
        let account: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness')['restoreServerAccountForTest']>> | undefined;
        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            await import('fake-indexeddb/auto');
            const { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
            installDisconnectedServerSocketBoundary();
            const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
            await loadSyncSingletonForTests();
            const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
            const token = createAccountTokenForTests('account-a', { currentAccount: !legacy });
            const credentials = legacy ? { token, secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') } : { token };
            let requireRecovery = false;
            const requests: Array<{ path: string; method: string }> = [];
            account = await restoreServerAccountForTest({
                serverUrl: 'https://recovery-' + crypto.randomUUID() + '.example.test', accountId: 'account-a', credentials,
                request: async (input, init) => {
                    const path = new URL(String(input)).pathname;
                    requests.push({ path, method: init?.method ?? 'GET' });
                    if (path === '/health') return Response.json({});
                    if (path === '/v1/features') return Response.json(createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: optOut }));
                    if (path === '/v1/account/encryption') return requireRecovery
                        ? Response.json({ error: 'account-encryption-recovery-required' }, { status: 400 })
                        : Response.json({ mode: legacy ? 'e2ee' : 'plain', updatedAt: 1 });
                    if (path === '/v1/account/encryption/currentness') return Response.json({ mode: legacy ? 'e2ee' : 'plain',
                        version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null });
                    if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                    if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-a' });
                    if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], hasNext: false, nextCursor: null });
                    if (path === '/v1/account/security') return Response.json({ v: 1, encryptionMode: legacy ? 'e2ee' : 'plain',
                        nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
                    return Response.json({ error: 'not_found' }, { status: 404 });
                },
            });
            const { sync } = await import('@/sync/sync');
            const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
            await queue.awaitQueue();
            const { storage: currentStorage } = await import('@/sync/domains/state/storage');
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const restoredScope = { serverId: account.serverId, accountId: 'account-a' };
            await vi.waitFor(() => expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual(restoredScope));
            currentStorage.setState({ isDataReady: true });
            requireRecovery = true;
            const modeOwner = await import('@/sync/api/account/apiAccountEncryptionMode');
            modeOwner.invalidateAccountEncryptionModeCache();
            await import('expo-router');
            const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
            const { AccountEncryptionSettingsSection } = await import('@/components/settings/account/AccountEncryptionSettingsSection');
            const { renderSettingsView: renderCurrentSettings } = await import('@/dev/testkit');
            screen = await renderCurrentSettings(<InjectedAuthProvider credentials={credentials}><AccountEncryptionSettingsSection /></InjectedAuthProvider>);
            await vi.waitFor(() => expect(screen!.findByTestId('settings-account-encryption-recovery')).not.toBeNull());
            // Recovery is the only usable control: with the Account mode unreadable the mode Switch is absent
            // (opt-out hidden) or rendered disabled (opt-out shown), never an actionable E2EE toggle.
            await vi.waitFor(() => {
                const modeSwitch = screen!.findByTestId('settings-account-encryption-mode-switch');
                expect(modeSwitch === null || modeSwitch.props.disabled === true).toBe(true);
            });
            await screen.pressByTestIdAsync('settings-account-encryption-recovery');
            expect(routerMockRef.current.spies.push).toHaveBeenCalledWith('/restore/manual');
            expect(requests.some(({ path, method }) => path === '/v1/account/encryption/migrate' && method === 'POST')).toBe(false);
        } finally {
            await screen?.unmount();
            await account?.dispose();
        }
    });
});
