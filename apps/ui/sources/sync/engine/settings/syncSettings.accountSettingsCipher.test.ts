import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Settings } from '@/sync/domains/settings/settings';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { Encryption } from '@/sync/encryption/encryption';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    createDataKeyAccountEncryptionCurrentnessFixture,
    createLegacyAccountEncryptionCurrentnessFixture,
    createPlainAccountEncryptionCurrentnessFixture,
} from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import {
    decryptSecretStringV1,
    deriveSettingsSecretsKeyV1,
    encryptSecretStringV1} from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import {
    deriveAccountMachineKeyFromRecoverySecret,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext} from '@happier-dev/protocol/crypto/accountScopedCipher';
import {
    type AccountSettingsStoredContentEnvelope,
} from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';

const mocks = vi.hoisted(() => {
    const serverFetch = vi.fn();
    const currentnessFetch = vi.fn();
    const pushProjectionFetch = vi.fn();
    const runtimeFetchWithServerReachability = vi.fn();
    return {
        getRandomBytes: vi.fn((length: number) => new Uint8Array(length).fill(4)),
        serverFetch,
        currentnessFetch,
        pushProjectionFetch,
        runtimeFetchWithServerReachability,
    };
});

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: mocks.getRandomBytes,
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { getPersistenceStorage, clearPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { loadAccountSettings, loadPendingAccountSettings, savePendingAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { syncSettings, applySettingsLocalDelta } = await import('./syncSettings');
const { normalizeVoiceSettingsLocalDelta, normalizeVoiceSettingsServerDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');

const TEST_MACHINE_KEY = new Uint8Array(32).fill(11);
const TEST_PUBLIC_KEY = tweetnacl.box.keyPair.fromSecretKey(TEST_MACHINE_KEY).publicKey;
const credentials: AuthCredentials = {
    token: 'token',
    encryption: {
        publicKey: Buffer.from(TEST_PUBLIC_KEY).toString('base64'),
        machineKey: Buffer.from(TEST_MACHINE_KEY).toString('base64'),
    },
};

let accountCurrentness = createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: TEST_MACHINE_KEY, publicKey: TEST_PUBLIC_KEY });
const initialState = storage.getState();
const persistence = getPersistenceStorage();
const initialSettingsVersion = 0;

async function createEncryption(machineKey: Uint8Array = TEST_MACHINE_KEY): Promise<Encryption> {
    const encryption = await Encryption.createFromContentKeyPair({ publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey, machineKey });
    // Observe the retired raw-cipher route without replacing cryptographic behavior.
    vi.spyOn(encryption, 'encryptRaw');
    vi.spyOn(encryption, 'decryptRaw');
    return encryption;
}

function importMarkers() {
    return persistence.getAllKeys().filter(key => key.startsWith('session-organization:legacy-import:v1:'))
        .map(key => [key, persistence.getString(key)]);
}

function persistedValues() {
    return persistence.getAllKeys().sort().map(key => [key, persistence.getString(key)]);
}

async function activateIdentityScope() {
    await setServerProfileIdentityForUrl('http://localhost:52753', 'srv_identity');
    const scope = { serverId: 'srv_identity', accountId: 'account-a' };
    storage.setState({ settingsScope: scope });
    return scope;
}

describe('syncSettings account settings ciphertext', () => {
    beforeEach(async () => {
        clearPersistenceStorage();
        storage.setState({ ...initialState, settings: settingsParse({}), settingsVersion: initialSettingsVersion }, true);
        installHomeGovernanceBoundaries(homes);
        await homes.addHome({ name: 'Cipher Settings', serverUrl: 'http://localhost:52753', accountId: 'account-a', credentials });
        invalidateAccountEncryptionModeCache();
        accountCurrentness = createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: TEST_MACHINE_KEY, publicKey: TEST_PUBLIC_KEY });
        mocks.serverFetch.mockReset();
        mocks.currentnessFetch.mockReset();
        mocks.currentnessFetch.mockImplementation(async () => Response.json(accountCurrentness));
        mocks.pushProjectionFetch.mockReset();
        mocks.pushProjectionFetch.mockImplementation(async () => new Response(JSON.stringify({ tokens: [] })));
        setRuntimeFetch(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.origin !== 'http://localhost:52753') throw new Error(`Unexpected test Home origin: ${url.origin}`);
            const path = url.pathname + url.search;
            if (path === '/v1/account/encryption/currentness') return await mocks.currentnessFetch(path, init);
            if (path === '/v1/push-tokens?projectionVersion=2') return await mocks.pushProjectionFetch(path, init);
            if (path.startsWith('/v2/session-organization')) {
                return await mocks.runtimeFetchWithServerReachability({
                    url: url.href,
                    init,
                });
            }
            const response = await mocks.serverFetch(path, init);
            if (!(response instanceof Response)) throw new Error(`Missing HTTP fixture for ${init?.method ?? 'GET'} ${path}`);
            return response;
        });
        mocks.runtimeFetchWithServerReachability.mockReset();
        mocks.getRandomBytes.mockClear();
    });

    afterEach(async () => { vi.restoreAllMocks(); await homes.reset(); });

    it('refuses plaintext Account settings when the trusted local client pin requires E2EE', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        storage.setState({ settings: settingsParse({
            analyticsOptOut: false,
            clientEncryptionRequirementLocalV1: 'require_e2ee',
            clientEncryptionRequirementV1: 'follow_account',
        }) });
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v2/account/settings') {
                return new Response(JSON.stringify({
                    content: { t: 'plain', v: { analyticsOptOut: false } },
                    version: 10,
                }));
            }
            throw new Error(`Unexpected request ${path}`);
        });

        await expect(syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
        expect(storage.getState().settingsVersion).toBe(initialSettingsVersion);
        expect(storage.getState().settings.clientEncryptionRequirementLocalV1).toBe('require_e2ee');
    });

    it('rederives disclosed policy from every merged CAS winner after positive negotiation', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        mocks.pushProjectionFetch.mockImplementation(async () => new Response(JSON.stringify({
            v: 2, accountRemoteAlerts: { settingsVersion: 4, status: 'stale' }, tokens: [],
        })));
        let posts = 0;
        const bodies: Array<{ remoteAlertPolicy?: { channels: { expo_push: { enabled: boolean } } }; expectedVersion: number }> = [];
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') return new Response(JSON.stringify({
                content: { t: 'plain', v: { sessionRemoteAlertsEnabled: true } }, version: 4,
            }));
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                bodies.push(JSON.parse(String(init.body)));
                posts += 1;
                return new Response(JSON.stringify(posts === 1 ? {
                    success: false, error: 'version-mismatch', currentVersion: 5,
                    currentContent: { t: 'plain', v: { sessionRemoteAlertsEnabled: true,
                        attentionDeliveryPolicyV1: { channels: { expo_push: { enabled: false } } } } },
                } : { success: true, version: 6 }));
            }
            throw new Error(`Unexpected request ${path}`);
        });
        await syncSettings({ credentials: { token: 'token-only' }, encryption: null,
            pendingSettings: { analyticsOptOut: true }, clearPendingSettings: vi.fn() });
        expect(bodies.map((body) => body.expectedVersion)).toEqual([4, 5]);
        expect(bodies.map((body) => body.remoteAlertPolicy?.channels.expo_push.enabled)).toEqual([true, false]);
    });

    it('does not promote an opted-in stale remote-alert policy into a Settings intent', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        mocks.pushProjectionFetch.mockImplementation(async () => new Response(JSON.stringify({
            v: 2, accountRemoteAlerts: { settingsVersion: 3, status: 'stale' }, tokens: [],
        })));
        const posts: Array<{ expectedVersion: number; remoteAlertPolicy?: { channels: { expo_push: { enabled: boolean } } } }> = [];
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') return new Response(JSON.stringify({
                content: { t: 'plain', v: { sessionRemoteAlertsEnabled: true } }, version: 4,
            }));
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                posts.push(JSON.parse(String(init.body)));
                return new Response(JSON.stringify({ success: true, version: 5 }));
            }
            throw new Error(`Unexpected request ${path}`);
        });

        await syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(posts).toHaveLength(0);
    });

    it('does not rewrite settings when the remote-alert policy is already current', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        mocks.pushProjectionFetch.mockImplementation(async () => new Response(JSON.stringify({
            v: 2, accountRemoteAlerts: { settingsVersion: 4, status: 'current' }, tokens: [],
        })));
        let settingsPosts = 0;
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') return new Response(JSON.stringify({
                content: { t: 'plain', v: { sessionRemoteAlertsEnabled: true } }, version: 4,
            }));
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                settingsPosts += 1;
                return new Response(JSON.stringify({ success: true, version: 5 }));
            }
            throw new Error(`Unexpected request ${path}`);
        });

        await syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(settingsPosts).toBe(0);
    });

    it('does not repeatedly publish a disabled projection for an opted-out account', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        mocks.pushProjectionFetch.mockImplementation(async () => new Response(JSON.stringify({
            v: 2, accountRemoteAlerts: { settingsVersion: 4, status: 'disabled' }, tokens: [],
        })));
        let settingsPosts = 0;
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') return new Response(JSON.stringify({
                content: { t: 'plain', v: { sessionRemoteAlertsEnabled: false } }, version: 4,
            }));
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                settingsPosts += 1;
                return new Response(JSON.stringify({ success: true, version: 5 }));
            }
            throw new Error(`Unexpected request ${path}`);
        });

        await syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(settingsPosts).toBe(0);
    });

    it('fails closed instead of persisting plaintext-account settings locally without device secret custody', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        const settingsBefore = storage.getState().settings;
        const persistedBefore = persistedValues();
        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    content: {
                        t: 'plain',
                        v: {
                            analyticsOptOut: true,
                            secrets: [{
                                id: 'secret-1',
                                name: 'Plain account secret',
                                kind: 'apiKey',
                                encryptedValue: {
                                    _isSecretValue: true,
                                    value: 'must-not-persist-locally',
                                },
                                createdAt: 1,
                                updatedAt: 1,
                            }],
                        },
                    },
                    version: 4,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await expect(syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            settingsSecretsKey: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        })).rejects.toMatchObject({
            code: 'local_secret_unavailable',
            message: 'Local settings secret key is unavailable',
        });

        expect(storage.getState().settingsVersion).toBe(initialSettingsVersion);
        expect(storage.getState().settings).toBe(settingsBefore);
        expect(persistedValues()).toEqual(persistedBefore);
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    });

    it('does not retry a CAS write when the conflict winner cannot be normalized for local persistence', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        const settingsBefore = storage.getState().settings;
        const persistedBefore = persistedValues();
        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    content: { t: 'plain', v: { analyticsOptOut: false } },
                    version: 4,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: 5,
                    currentContent: {
                        t: 'plain',
                        v: {
                            analyticsOptOut: false,
                            secrets: [{
                                id: 'secret-1',
                                name: 'Concurrent plain secret',
                                kind: 'apiKey',
                                encryptedValue: {
                                    _isSecretValue: true,
                                    value: 'must-not-cross-the-local-boundary',
                                },
                                createdAt: 1,
                                updatedAt: 1,
                            }],
                        },
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 6 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await expect(syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            settingsSecretsKey: null,
            pendingSettings: { analyticsOptOut: true },
            clearPendingSettings: vi.fn(),
        })).rejects.toMatchObject({
            code: 'local_secret_unavailable',
            message: 'Local settings secret key is unavailable',
        });

        const postCalls = mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
        expect(postCalls).toHaveLength(1);
        expect(storage.getState().settingsVersion).toBe(initialSettingsVersion);
        expect(storage.getState().settings).toBe(settingsBefore);
        expect(persistedValues()).toEqual(persistedBefore);
    });

    it('settles opposite one-shot mutations from the same version as one applied and one conflict without replay', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        const firstMutation = vi.fn((raw: Readonly<Record<string, unknown>>) => ({
            settings: {
                ...raw,
                voiceSettingsV1: { selectedSource: 'savedSecret' },
            },
            value: 'savedSecret',
        }));
        const secondMutation = vi.fn((raw: Readonly<Record<string, unknown>>) => ({
            settings: {
                ...raw,
                voiceSettingsV1: { selectedSource: 'connectedAccount' },
            },
            value: 'connectedAccount',
        }));
        let serverVersion = 4;
        let serverRaw: Record<string, unknown> = {
            voiceSettingsV1: { selectedSource: 'none' },
        };
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') {
                return new Response(JSON.stringify({
                    content: { t: 'plain', v: serverRaw },
                    version: serverVersion,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as {
                    content: { t: 'plain'; v: Record<string, unknown> };
                    expectedVersion: number;
                };
                if (body.expectedVersion !== serverVersion) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'version-mismatch',
                        currentVersion: serverVersion,
                        currentContent: { t: 'plain', v: serverRaw },
                    }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                serverRaw = body.content.v;
                serverVersion += 1;
                return new Response(JSON.stringify({ success: true, version: serverVersion }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected settings request: ${path}`);
        });

        const common = {
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        } as const;
        const [first, second] = await Promise.all([
            syncSettings({
                ...common,
                oneShotServerSettingsMutation: {
                    expectedSettingsVersion: 4,
                    mutate: firstMutation,
                },
            }),
            syncSettings({
                ...common,
                oneShotServerSettingsMutation: {
                    expectedSettingsVersion: 4,
                    mutate: secondMutation,
                },
            }),
        ]);

        expect([first, second].map((result) => result?.status).sort()).toEqual([
            'applied',
            'conflict',
        ]);
        expect(firstMutation).toHaveBeenCalledOnce();
        expect(secondMutation).toHaveBeenCalledOnce();
        expect(mocks.serverFetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(2);
        expect(storage.getState().settingsVersion).toBe(5);
        expect(serverRaw.voiceSettingsV1).toMatchObject({ selectedSource: expect.stringMatching(/savedSecret|connectedAccount/u) });
    });

    it('rebases independent field mutations after a concurrent Account Settings write', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        let serverVersion = 4;
        let serverRaw: Record<string, unknown> = { analyticsOptOut: false, pluginEndpoint: 'https://initial.example.test' };
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') {
                return Response.json({ content: { t: 'plain', v: serverRaw }, version: serverVersion });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as {
                    content: { t: 'plain'; v: Record<string, unknown> };
                    expectedVersion: number;
                };
                if (body.expectedVersion !== serverVersion) {
                    return Response.json({
                        success: false,
                        error: 'version-mismatch',
                        currentVersion: serverVersion,
                        currentContent: { t: 'plain', v: serverRaw },
                    });
                }
                serverRaw = body.content.v;
                serverVersion += 1;
                return Response.json({ success: true, version: serverVersion });
            }
            throw new Error(`Unexpected settings request: ${path}`);
        });

        const common = {
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        } as const;
        const [first, second] = await Promise.all([
            syncSettings({
                ...common,
                oneShotServerSettingsMutation: {
                    rebaseOnConflict: true,
                    expectedSettingsVersion: 4,
                    mutate: (raw) => ({ settings: { ...raw, analyticsOptOut: true }, value: 'analytics' }),
                },
            }),
            syncSettings({
                ...common,
                oneShotServerSettingsMutation: {
                    rebaseOnConflict: true,
                    expectedSettingsVersion: 4,
                    mutate: (raw) => ({ settings: { ...raw, pluginEndpoint: 'https://concurrent.example.test' }, value: 'endpoint' }),
                },
            }),
        ]);

        expect([first, second].map((result) => result?.status)).toEqual(['applied', 'applied']);
        expect(serverRaw).toMatchObject({ analyticsOptOut: true, pluginEndpoint: 'https://concurrent.example.test' });
    });

    it('reports a response-lost one-shot Account Settings write as outcomeUnknown after one safe readback without replaying', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        let serverVersion = 4;
        let serverRaw: Record<string, unknown> = { analyticsOptOut: false };
        const mutate = vi.fn((raw: Readonly<Record<string, unknown>>) => ({
            settings: { ...raw, pluginEndpoint: 'https://possibly-applied.example.test' },
            value: 'secret-write',
        }));
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') {
                return new Response(JSON.stringify({
                    content: { t: 'plain', v: serverRaw },
                    version: serverVersion,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as {
                    content: { t: 'plain'; v: Record<string, unknown> };
                    expectedVersion: number;
                };
                expect(body.expectedVersion).toBe(4);
                // The server committed, but the acknowledgement never reached
                // the caller. A later GET is the sole safe reconciliation.
                serverRaw = body.content.v;
                serverVersion += 1;
                throw new Error('response lost after commit');
            }
            throw new Error(`Unexpected settings request: ${path}`);
        });

        const result = await syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
            oneShotServerSettingsMutation: {
                expectedSettingsVersion: 4,
                mutate,
            },
        });

        expect(result).toEqual({
            status: 'outcomeUnknown',
            lastKnownSettingsVersion: 5,
            safeSnapshotVersion: 5,
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        expect(mocks.serverFetch.mock.calls.filter(([path, init]) => (
            path === '/v2/account/settings' && init?.method !== 'POST'
        ))).toHaveLength(2);
        expect(storage.getState().settingsVersion).toBe(5);
        expect(serverRaw.pluginEndpoint).toBe('https://possibly-applied.example.test');
    });

    it('lets one external transaction commit the canonically prepared Settings envelope', async () => {
        accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
        const commitPrepared = vi.fn(async (prepared: Readonly<{
            content: AccountSettingsStoredContentEnvelope;
            expectedSettingsVersion: number;
            accountMode: 'plain' | 'e2ee';
        }>) => ({ status: 'applied' as const, settingsVersion: 8 }));
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method !== 'POST') {
                return Response.json({ content: { t: 'plain', v: { keep: true } }, version: 7 });
            }
            throw new Error(`Unexpected settings request: ${path}`);
        });

        const result = await syncSettings({
            credentials: { token: 'token-only' },
            encryption: null,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
            oneShotServerSettingsMutation: {
                expectedSettingsVersion: 7,
                mutate: (raw) => ({ settings: { ...raw, promoted: true }, value: 'resource-a' }),
                commitPrepared,
            },
        });

        expect(result).toEqual({ status: 'applied', settingsVersion: 8, value: 'resource-a' });
        expect(commitPrepared).toHaveBeenCalledWith({
            content: { t: 'plain', v: { keep: true, promoted: true } },
            expectedSettingsVersion: 7,
            accountMode: 'plain',
        });
        expect(mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
        expect(storage.getState().settingsVersion).toBe(8);
    });

    it('reapplies an immutable account-settings mutation after a CAS conflict', async () => {
        const encryptionStub = await createEncryption();
        const initialCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                providerSettingsV1: {
                    schemaVersion: 1,
                    connections: [{ id: 'pc-a' }],
                    machineGrants: [{ machineId: 'revoked', connectionId: 'pc-a' }],
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const concurrentCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                providerSettingsV1: {
                    schemaVersion: 1,
                    connections: [{ id: 'pc-a' }],
                    machineGrants: [{ machineId: 'revoked', connectionId: 'pc-a' }],
                    manualModelsByConnectionId: { 'pc-a': [{ id: 'concurrent/model', addedAt: 9 }] },
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        mocks.serverFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({
                content: { t: 'encrypted', c: initialCiphertext }, version: 4,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: false,
                error: 'version-mismatch',
                currentVersion: 5,
                currentContent: { t: 'encrypted', c: concurrentCiphertext },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, version: 6 }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }));

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
            accountSettingsMutation: {
                operations: [{ op: 'set', key: 'analyticsOptOut', value: true }],
            },
        });

        const postBodies = mocks.serverFetch.mock.calls
            .filter((call) => call[1]?.method === 'POST')
            .map((call) => JSON.parse(String(call[1]?.body)) as { content: { c: string }; expectedVersion: number });
        expect(postBodies.map((body) => body.expectedVersion)).toEqual([4, 5]);
        const committed = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: postBodies[1]!.content.c,
        })?.value as Record<string, any>;
        expect(committed.analyticsOptOut).toBe(true);
        expect(committed.providerSettingsV1.machineGrants).toEqual([
            { machineId: 'revoked', connectionId: 'pc-a' },
        ]);
        expect(committed.providerSettingsV1.manualModelsByConnectionId).toEqual({
            'pc-a': [{ id: 'concurrent/model', addedAt: 9 }],
        });
    });

    it.each(['current edit', 'recovered queue'] as const)('persists an encrypted pending canonical Voice edit over its retired legacy carrier (%s)', async source => {
        const encryptionStub = await createEncryption();
        const scope = await activateIdentityScope();
        let raw: Record<string, unknown> = {
            favoriteMachines: ['machine-a'],
            voice: { assistantLanguage: 'fr', privacy: { shareSessionSummary: true } },
        };
        let version = 1;
        let pending: Partial<Settings> = {};
        storage.setState({ settingsScope: scope, settingsVersion: version, settings: settingsParse(raw) });
        savePendingAccountSettings(scope, {});
        const written: Record<string, unknown>[] = [];
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path !== '/v2/account/settings') throw new Error(`Unexpected request ${path}`);
            if (init?.method === 'POST') {
                const request = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                expect(request.expectedVersion).toBe(version);
                if (request.content?.t !== 'encrypted') throw new Error('Expected encrypted Account settings');
                const opened = openAccountScopedBlobCiphertext({
                    kind: 'account_settings',
                    material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
                    ciphertext: request.content.c,
                });
                expect(opened?.format).toBe('account_scoped_v1');
                if (!opened || !opened.value || typeof opened.value !== 'object' || Array.isArray(opened.value)) {
                    throw new Error('Expected an Account settings object');
                }
                raw = Object.fromEntries(Object.entries(opened.value));
                written.push(raw);
                return Response.json({ success: true, version: ++version });
            }
            const ciphertext = sealAccountScopedBlobCiphertext({
                kind: 'account_settings',
                material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
                payload: raw,
                randomBytes: mocks.getRandomBytes,
            });
            return Response.json({ content: { t: 'encrypted', c: ciphertext }, version });
        });

        const current = storage.getState().settings;
        const delta = { voice: { ...current.voice, privacy: { ...current.voice.privacy, shareSessionSummary: false } } };
        if (source === 'recovered queue') {
            // Persist and recover the exact canonical-only queue produced before this fix.
            const queued = normalizeVoiceSettingsServerDelta(normalizeVoiceSettingsLocalDelta(delta, current), current);
            expect(queued).not.toHaveProperty('voice');
            expect(settingsParse(queued).voice.privacy.shareSessionSummary).toBe(false);
            savePendingAccountSettings(scope, queued);
            pending = loadPendingAccountSettings(scope);
        } else {
            applySettingsLocalDelta({
                expectedSettingsScope: scope, delta,
                settingsSecretsKey: deriveSettingsSecretsKeyV1(TEST_MACHINE_KEY),
                getPendingSettings: () => pending,
                setPendingSettings: next => { pending = next; savePendingAccountSettings(scope, next); },
                schedulePendingSettingsFlush: () => {},
            });
        }
        await syncSettings({
            credentials, encryption: encryptionStub, settingsScope: scope, pendingSettings: pending,
            getPendingSettings: () => pending,
            clearPendingSettings: next => { pending = next; savePendingAccountSettings(scope, next); },
        });

        expect(written).toHaveLength(1);
        expect(raw).not.toHaveProperty('voice');
        expect(raw.favoriteMachines).toEqual(['machine-a']);
        const reread = settingsParse(raw);
        expect(reread.voice.privacy.shareSessionSummary).toBe(false);
        expect(reread.voice.assistantLanguage).toBe('fr');
        expect(pending).toEqual({});
        expect(loadPendingAccountSettings(scope)).toEqual({});
    });

    it('preserves canonical Voice settings and diagnostics across a crash-recovered sparse delta and CAS retry', async () => {
        const encryptionStub = await createEncryption();
        const initialDiagnostics = {
            v: 1,
            enabled: true,
            consentVersion: 1,
            captureSttInput: true,
            captureTtsOutput: false,
            maxAgeMs: 12 * 60 * 60 * 1_000,
            maxFiles: 7,
            maxBytes: 4 * 1024 * 1024,
            maxDurationMs: 60_000,
        } as const;
        const concurrentDiagnostics = {
            ...initialDiagnostics,
            maxFiles: 8,
        } as const;
        const canonicalVoice = {
            providerId: 'happier.agent.codex/realtime-codex',
            providers: {
                'happier.agent.codex/realtime-codex': {
                    schemaVersion: 2,
                    config: {
                        globalConnectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                'openai-codex': {
                                    source: 'connected',
                                    selection: 'profile',
                                    profileId: 'codex-work-profile',
                                },
                            },
                        },
                    },
                },
            },
        } as const;
        const initialCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                voiceDiagnosticsV1: initialDiagnostics,
                voiceSettingsV1: canonicalVoice,
                voice: { assistantLanguage: 'en' },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const concurrentCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                voiceDiagnosticsV1: concurrentDiagnostics,
                voiceSettingsV1: canonicalVoice,
                voice: { assistantLanguage: 'fr' },
            },
            randomBytes: mocks.getRandomBytes,
        });
        mocks.serverFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({
                content: { t: 'encrypted', c: initialCiphertext }, version: 4,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: false,
                error: 'version-mismatch',
                currentVersion: 5,
                currentContent: { t: 'encrypted', c: concurrentCiphertext },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, version: 6 }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }));

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            // Historical crash-recovered pending shape from before the top-level owner existed.
            pendingSettings: {
                voice: { assistantLanguage: 'de' },
            } as unknown as Parameters<typeof syncSettings>[0]['pendingSettings'],
            clearPendingSettings: vi.fn(),
        });

        const committed = mocks.serverFetch.mock.calls
            .filter((call) => call[1]?.method === 'POST')
            .map((call) => {
                const body = JSON.parse(String(call[1]?.body)) as { content: { c: string } };
                return openAccountScopedBlobCiphertext({
                    kind: 'account_settings',
                    material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
                    ciphertext: body.content.c,
                })?.value as Record<string, unknown>;
            });

        expect(committed).toHaveLength(2);
        expect(committed[0]?.voiceDiagnosticsV1).toEqual(initialDiagnostics);
        expect(committed[1]?.voiceDiagnosticsV1).toEqual(concurrentDiagnostics);
        expect(committed[1]?.voiceSettingsV1).toMatchObject({
            providerId: 'happier.agent.codex/realtime-codex',
            assistantLanguage: 'de',
            providers: canonicalVoice.providers,
        });
        // The carrier held nothing the canonical root does not, so this write retires it.
        expect(committed[1]).not.toHaveProperty('voice');
    });

    it('POSTs settings as a canonical account_scoped_v1 ciphertext (no encryptRaw)', async () => {
        const encryptionStub = await createEncryption();
        const serverCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                untouchedRawField: { preserved: true },
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 9 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 10 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { crashReportsOptOut: true },
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch).toHaveBeenCalled();
        const [url, init] = mocks.currentnessFetch.mock.calls[0];
        expect(url).toBe('/v1/account/encryption/currentness');
        expect(init?.method).toBe('GET');
        expect(mocks.currentnessFetch.mock.calls.map(([path]) => path)).toEqual([
            '/v1/account/encryption/currentness',
            '/v1/account/encryption/currentness',
        ]);

        const [url2, init2] = mocks.serverFetch.mock.calls[0];
        expect(url2).toBe('/v2/account/settings');
        expect(init2?.method ?? 'GET').toBe('GET');

        const [url3, init3] = mocks.serverFetch.mock.calls[1];
        expect(url3).toBe('/v2/account/settings');
        expect(init3?.method).toBe('POST');
        expect(typeof init3?.body).toBe('string');

        const body = JSON.parse(String(init3?.body)) as { content?: { t?: unknown; c?: unknown } };
        expect(body.content?.t).toBe('encrypted');
        expect(typeof body.content?.c).toBe('string');

        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: body.content!.c as string,
        });
        expect(opened?.format).toBe('account_scoped_v1');
        expect(opened?.value).toEqual(
            expect.objectContaining({
                analyticsOptOut: false,
                crashReportsOptOut: true,
            }),
        );

        expect((encryptionStub.encryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('preserves raw server fields not touched by a pending setting', async () => {
        const encryptionStub = await createEncryption();
        const serverCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                profiles: 'malformed-known-field',
                futureServerOnly: { keep: true },
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 15 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 16 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { crashReportsOptOut: true },
            clearPendingSettings: vi.fn(),
        });

        const post = mocks.serverFetch.mock.calls.find(
            ([url, init]) => url === '/v2/account/settings' && init?.method === 'POST',
        );
        expect(post).toBeTruthy();
        const body = JSON.parse(String(post?.[1]?.body ?? 'null')) as { content?: { t?: unknown; c?: unknown } };
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(body.content?.c ?? ''),
        });
        expect(opened?.value).toEqual(expect.objectContaining({
            profiles: 'malformed-known-field',
            futureServerOnly: { keep: true },
            crashReportsOptOut: true,
        }));
    });

    it('prefers protocol decryption for canonical ciphertext (no decryptRaw)', async () => {
        const encryptionStub = await createEncryption();

        const ciphertext = (await import('@happier-dev/protocol/crypto/accountScopedCipher')).sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: true },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
            new Response(JSON.stringify({ content: { t: 'encrypted', c: ciphertext }, version: 12 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect((encryptionStub.decryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(storage.getState().settings.analyticsOptOut).toBe(true);
        expect(storage.getState().settingsVersion).toBe(12);
    });

    it('falls back to v1 settings POST when v2 settings is not supported (e2ee)', async () => {
        const encryptionStub = await createEncryption();

        mocks.serverFetch
            // GET /v2/account/settings -> 404 (old server)
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
            // GET /v1/account/settings -> empty
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ settings: null, settingsVersion: 8 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            // POST /v1/account/settings -> success
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 10 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { crashReportsOptOut: true },
            clearPendingSettings: vi.fn(),
        });

        const calls = mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET']);
        expect(calls).toEqual([
            ['/v2/account/settings', 'GET'],
            ['/v1/account/settings', 'GET'],
            ['/v1/account/settings', 'POST'],
        ]);

        const [, initV1] = mocks.serverFetch.mock.calls[2];
        expect(initV1?.method).toBe('POST');
        const body = JSON.parse(String(initV1?.body)) as { settings?: unknown; expectedVersion?: unknown };
        expect(typeof body.settings).toBe('string');
        expect(body.expectedVersion).toBe(8);
    });

    it('imports legacy session organization settings and strips them on a deliberate settings write', async () => {
        await activateIdentityScope();
        // The identity alias changed; bind this Home's real credential to the identified scope.
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.setCredentialsForServerUrl('http://localhost:52753', { serverId: 'srv_identity' }, credentials)).toBe(true);
        const encryptionStub = await createEncryption();
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                pinnedSessionKeysV1: ['localhost-52753:session-a', 'srv_identity:session-b'],
                sessionTagsV1: {
                    'localhost-52753:session-a': ['legacy-tag'],
                    'srv_identity:session-b': ['identity-tag'],
                },
                sessionListGroupOrderV1: {
                    'server:localhost-52753:active:project:p1': ['localhost-52753:session-a'],
                    'server:192.168.1.115-52753:active:project:p2': ['192.168.1.115-52753:session-c'],
                    'pinned-v1': ['localhost-52753:session-a'],
                },
                sessionWorkspaceOrderV1: {
                    'server:localhost-52753:workspaces': ['workspace:legacy'],
                },
                serverSelectionGroups: [{
                    id: 'group-a',
                    name: 'Group A',
                    serverIds: ['localhost-52753', '192.168.1.115-52753', 'srv_identity'],
                    presentation: 'grouped',
                }],
                workspaceLabelsV1: {
                    'server:srv_identity:workspaces': 'Legacy Workspace',
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const emptySnapshot = {
            snapshot: {
                schemaVersion: 1,
                version: 0,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        };

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(Response.json({ success: true, version: 13 }));
        mocks.runtimeFetchWithServerReachability
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    imported: {
                        pins: 2,
                        folders: 0,
                        tags: 2,
                        orderEntries: 4,
                        labels: 1,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'srv_identity', accountId: 'account-a' },
            pendingSettings: { analyticsOptOut: true },
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v2/account/settings', 'GET'],
            ['/v2/account/settings', 'POST'],
        ]);
        expect(mocks.runtimeFetchWithServerReachability.mock.calls.map(([params]) => [
            new URL(params.url).pathname + new URL(params.url).search,
            params.init?.method ?? 'GET',
        ])).toEqual([
            [
                '/v2/session-organization?projectionVersion=2&includeFolders=true&includeTags=true&includeLabels=true&includeAllFolderAssignments=true&includeAllTagAssignments=true',
                'GET',
            ],
            ['/v2/session-organization/import', 'POST'],
            [
                '/v2/session-organization?projectionVersion=2&includeFolders=true&includeTags=true&includeLabels=true&includeAllTagAssignments=true',
                'GET',
            ],
        ]);
        const importCall = mocks.runtimeFetchWithServerReachability.mock.calls.find(([params]) => {
            return String(params.url).endsWith('/v2/session-organization/import');
        });
        expect(importCall).toBeTruthy();
        const importBody = JSON.parse(String(importCall?.[0].init?.body ?? 'null'));
        expect(importBody.pins).toEqual([
            { sessionId: 'session-a', sortKey: '00000001' },
            { sessionId: 'session-b', sortKey: '00000002' },
        ]);
        expect(importBody.tags).toEqual([
            {
                tagId: 'legacy-tag',
                tagKey: 'legacy-tag',
                sortKey: '00000001',
                display: expect.objectContaining({ t: 'encrypted' }),
            },
            {
                tagId: 'identity-tag',
                tagKey: 'identity-tag',
                sortKey: '00000002',
                display: expect.objectContaining({ t: 'encrypted' }),
            },
        ]);
        expect(importBody.tagAssignments).toEqual([
            { sessionId: 'session-a', tagIds: ['legacy-tag'] },
            { sessionId: 'session-b', tagIds: ['identity-tag'] },
        ]);
        expect(importBody.orderEntries).toEqual(expect.arrayContaining([
            {
                scopeKind: 'group',
                scopeKey: 'server:srv_identity:active:project:p1',
                itemKind: 'session',
                itemKey: 'session-a',
                sortKey: '00000001',
            },
            {
                scopeKind: 'group',
                scopeKey: 'server:srv_identity:active:project:p2',
                itemKind: 'session',
                itemKey: 'session-c',
                sortKey: '00000001',
            },
            {
                scopeKind: 'pinned',
                scopeKey: 'pins',
                itemKind: 'session',
                itemKey: 'session-a',
                sortKey: '00000001',
            },
            {
                scopeKind: 'workspace',
                scopeKey: 'srv_identity',
                itemKind: 'workspace',
                itemKey: 'legacy',
                sortKey: '00000001',
            },
        ]));
        expect(importBody.labels).toEqual([
            {
                labelKind: 'workspace',
                scopeKey: 'server:srv_identity:workspaces',
                display: expect.objectContaining({ t: 'encrypted' }),
            },
        ]);
        expect(importMarkers()).toEqual([
            [expect.stringMatching(/^session-organization:legacy-import:v1:/), '1'],
        ]);
        expect(storage.getState().sessionOrganizationSnapshotVersionByServerId.srv_identity).toBe(0);

        const migrateBody = JSON.parse(String(mocks.serverFetch.mock.calls[1]?.[1]?.body)) as {
            content?: { t?: unknown; c?: unknown };
            expectedVersion?: unknown;
        };
        expect(migrateBody.expectedVersion).toBe(12);
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(migrateBody.content?.c ?? ''),
        });
        const postedSettings = opened?.value as Record<string, unknown> | undefined;
        expect(postedSettings).toEqual(expect.objectContaining({ analyticsOptOut: true }));
        expect(postedSettings?.pinnedSessionKeysV1).toBeUndefined();
        expect(postedSettings?.sessionTagsV1).toBeUndefined();
        expect(postedSettings?.sessionListGroupOrderV1).toBeUndefined();
        expect(postedSettings?.sessionWorkspaceOrderV1).toBeUndefined();
        expect(postedSettings?.sessionFoldersV1).toBeUndefined();
        expect(postedSettings?.workspaceLabelsV1).toBeUndefined();
        expect(postedSettings?.serverSelectionGroups).toBeUndefined();
        expect(storage.getState().settingsScope).toEqual({ serverId: 'srv_identity', accountId: 'account-a' });
        expect(storage.getState().settingsVersion).toBe(13);
        const appliedSettings = loadAccountSettings({ serverId: 'srv_identity', accountId: 'account-a' }).settings;
        expect(appliedSettings).not.toHaveProperty('pinnedSessionKeysV1');
        expect(appliedSettings).not.toHaveProperty('sessionTagsV1');
        expect(appliedSettings).not.toHaveProperty('sessionListGroupOrderV1');
        expect(appliedSettings).not.toHaveProperty('sessionWorkspaceOrderV1');
        expect(appliedSettings).not.toHaveProperty('sessionFoldersV1');
        expect(appliedSettings).not.toHaveProperty('workspaceLabelsV1');
    });

    it('preserves other-server legacy organization settings while cleaning the imported scope', async () => {
        const encryptionStub = await createEncryption();
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                pinnedSessionKeysV1: ['localhost-52753:session-a', 'other-server:session-b'],
                sessionFoldersV1: {
                    v: 1,
                    folders: [
                        {
                            id: 'folder-current',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'localhost-52753',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Current',
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            id: 'folder-other',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'other-server',
                                machineId: 'machine-b',
                                rootPath: '/other',
                            },
                            parentId: null,
                            name: 'Other',
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
                sessionTagsV1: {
                    'localhost-52753:session-a': ['current-tag'],
                    'other-server:session-b': ['other-tag'],
                },
                sessionListGroupOrderV1: {
                    'pinned-v1': ['localhost-52753:session-a', 'other-server:session-b', 'folder:folder-current'],
                    'server:localhost-52753:active:project:p1': ['localhost-52753:session-a'],
                    'server:other-server:active:project:p2': ['other-server:session-b'],
                },
                sessionWorkspaceOrderV1: {
                    'server:localhost-52753:workspaces': ['workspace:/repo'],
                    'server:other-server:workspaces': ['workspace:/other'],
                },
                workspaceLabelsV1: {
                    'server:localhost-52753:workspaces': 'Current Workspace',
                    'server:other-server:workspaces': 'Other Workspace',
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const emptySnapshot = {
            snapshot: {
                schemaVersion: 1,
                version: 0,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        };

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 41 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 42 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        mocks.runtimeFetchWithServerReachability
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    imported: {
                        pins: 1,
                        folders: 1,
                        tags: 1,
                        orderEntries: 4,
                        labels: 1,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'localhost-52753', accountId: 'account-a' },
            pendingSettings: { analyticsOptOut: true },
            clearPendingSettings: vi.fn(),
        });

        const cleanupBody = JSON.parse(String(mocks.serverFetch.mock.calls[1]?.[1]?.body)) as {
            content?: { t?: unknown; c?: unknown };
        };
        const openedCleanup = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(cleanupBody.content?.c ?? ''),
        });

        expect(openedCleanup?.value).toEqual(expect.objectContaining({
            analyticsOptOut: true,
            pinnedSessionKeysV1: ['other-server:session-b'],
            sessionFoldersV1: {
                v: 1,
                folders: [
                    {
                        id: 'folder-other',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'other-server',
                            machineId: 'machine-b',
                            rootPath: '/other',
                        },
                        parentId: null,
                        name: 'Other',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            sessionTagsV1: {
                'other-server:session-b': ['other-tag'],
            },
            sessionListGroupOrderV1: {
                'pinned-v1': ['other-server:session-b'],
                'server:other-server:active:project:p2': ['other-server:session-b'],
            },
            sessionWorkspaceOrderV1: {
                'server:other-server:workspaces': ['workspace:/other'],
            },
            workspaceLabelsV1: {
                'server:other-server:workspaces': 'Other Workspace',
            },
        }));
    });

    it('applies an already-imported session organization snapshot before marking legacy settings consumed', async () => {
        await activateIdentityScope();
        // The Organization store admits only the credential this Home still holds.
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.setCredentialsForServerUrl('http://localhost:52753', { serverId: 'srv_identity' }, credentials)).toBe(true);
        const encryptionStub = await createEncryption();
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                pinnedSessionKeysV1: ['srv_identity:session-a'],
            },
            randomBytes: mocks.getRandomBytes,
        });
        const existingSnapshot = {
            schemaVersion: 1,
            version: 4,
            pins: [{
                sessionId: 'session-a',
                sortKey: '00000001',
                pinnedAt: 123,
                listPinned: true,
                railPinned: false,
            }],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        };

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 51 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 52 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(
            new Response(JSON.stringify({ snapshot: existingSnapshot }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        const persist = persistence.set.bind(persistence);
        const snapshotsAtImportMarker: Array<number | undefined> = [];
        vi.spyOn(persistence, 'set').mockImplementation((key, value) => {
            if (key.startsWith('session-organization:legacy-import:v1:')) {
                snapshotsAtImportMarker.push(storage.getState().sessionOrganizationSnapshotVersionByServerId.srv_identity);
            }
            persist(key, value);
        });

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'srv_identity', accountId: 'account-a' },
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.runtimeFetchWithServerReachability.mock.calls.map(([params]) => [
            new URL(params.url).pathname + new URL(params.url).search,
            params.init?.method ?? 'GET',
        ])).toEqual([
            [
                '/v2/session-organization?projectionVersion=2&includeFolders=true&includeTags=true&includeLabels=true&includeAllFolderAssignments=true&includeAllTagAssignments=true',
                'GET',
            ],
        ]);
        expect(storage.getState().sessionOrganizationSnapshotVersionByServerId.srv_identity).toBe(4);
        expect(snapshotsAtImportMarker).toEqual([4]);
        expect(Object.values(storage.getState().sessionOrganizationPinsBySessionKey)).toEqual(existingSnapshot.pins);
        expect(importMarkers()).toEqual([
            [expect.stringMatching(/^session-organization:legacy-import:v1:/), '1'],
        ]);
    });

    it('does not rewrite payload-discovered aliases when the active scope is still host-derived', async () => {
        const encryptionStub = await createEncryption();
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                sessionListGroupOrderV1: {
                    'server:192.168.1.115-52753:active:project:p2': ['192.168.1.115-52753:session-c'],
                },
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'localhost-52753', accountId: 'account-a' },
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v2/account/settings', 'GET'],
        ]);
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
        expect(importMarkers()).toEqual([
            [expect.stringMatching(/^session-organization:legacy-import:v1:/), '1'],
        ]);
        const appliedHost = loadAccountSettings({ serverId: 'localhost-52753', accountId: 'account-a' });
        expect(appliedHost.version).toBe(12);
        // Retired organization projections are never persisted locally. The
        // untouched server baseline above remains their migration source.
        expect(appliedHost.settings).not.toHaveProperty('sessionListGroupOrderV1');
    });

    it('migrates legacy-sealed saved secrets to canonical machine-key sealing on a deliberate settings write', async () => {
        const recoverySecret = new Uint8Array(32).fill(6);
        const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
        const legacySettingsKey = deriveSettingsSecretsKeyV1(recoverySecret);
        const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);
        const legacyCredentials: AuthCredentials = {
            token: 'token',
            secret: Buffer.from(recoverySecret).toString('base64url'),
        };

        accountCurrentness = createLegacyAccountEncryptionCurrentnessFixture({ secret: recoverySecret });
        const encryptionStub = await Encryption.create(recoverySecret);

        const legacyEncryptedSecret = encryptSecretStringV1(
            'sk-legacy',
            legacySettingsKey,
            mocks.getRandomBytes,
        );
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            payload: {
                analyticsOptOut: true,
                secrets: [
                    {
                        id: 'sec1',
                        name: 'Legacy Secret',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, encryptedValue: legacyEncryptedSecret },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials: legacyCredentials,
            encryption: encryptionStub,
            pendingSettings: { analyticsOptOut: false },
            settingsSecretsKey: canonicalSettingsKey,
            settingsSecretsReadKeys: [canonicalSettingsKey, legacySettingsKey],
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toBe('/v2/account/settings');
        expect(mocks.serverFetch.mock.calls[1]?.[1]?.method).toBe('POST');

        const migrateBody = JSON.parse(String(mocks.serverFetch.mock.calls[1]?.[1]?.body)) as {
            content?: { t?: unknown; c?: unknown };
            expectedVersion?: unknown;
        };
        expect(migrateBody.expectedVersion).toBe(12);
        expect(migrateBody.content?.t).toBe('encrypted');

        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            ciphertext: String(migrateBody.content?.c ?? ''),
        });
        const migratedSecret = ((opened?.value as any)?.secrets?.[0]?.encryptedValue?.encryptedValue);
        expect(decryptSecretStringV1(migratedSecret, canonicalSettingsKey)).toBe('sk-legacy');
    });
});
