import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';

import {
    type AccountPluginDataStorageHostDependencies,
} from './context/accountPluginDataStorage';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    readPluginRegistryCommitRecord,
    replacePluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import {
    persistInstallationStateRevision,
    readCurrentCommittedPluginGenerations,
    readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const accountDataBoundary = vi.hoisted(() => ({
    readStoredCredentials: vi.fn<() => Promise<StoredCredentials | null>>(async () => null),
    get: vi.fn(),
    post: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: accountDataBoundary.readStoredCredentials,
}));

vi.mock('axios', async (importOriginal) => {
    const actual = await importOriginal<typeof import('axios')>();
    return {
        ...actual,
        default: new Proxy(actual.default, {
            get(target, property, receiver) {
                if (property === 'get') return accountDataBoundary.get;
                if (property === 'post') return accountDataBoundary.post;
                return Reflect.get(target, property, receiver);
            },
        }),
    };
});

const PLUGIN_ID = 'acme.channels-account-data';
const COLLECTION_ID = 'channel-state';
const HOST_MARKER = 'account-data-host-bound';
const ACCOUNT_STORAGE_HOST_ACCESS_ID = 'account-state';
const NOTIFICATION_ACTION_ID = 'send-account-state';
const NOTIFICATION_CATEGORY_ID = 'account-state';
const NOTIFICATION_CHANNEL_ID = 'account-data';

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolvePromise!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return Object.freeze({
        promise,
        resolve: (value: T) => { resolvePromise(value); },
    });
}

function createFixtureAccountStorageDependencies(
    credentials: StoredCredentials | null,
): AccountPluginDataStorageHostDependencies {
    return Object.freeze({
        readCredentials: async () => credentials,
        isCurrentAccount: () => credentials !== null,
        resolveAccountScopeKey: () => credentials ? resolveAccountSettingsScopeKey(credentials) : null,
        resolveBaseUrl: () => 'https://data.example.test',
        resolveAccountEncryptionCurrentness: async () => ({
            mode: 'plain' as const,
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        }),
        http: {
            async get(url: string) {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                }
                if (url.includes('/v1/account/plugin-storage/')) {
                    return { status: 200, data: { status: 'absent' } };
                }
                throw new Error(`Unexpected fixture Account Data GET: ${url}`);
            },
            async post(url: string) {
                if (url.endsWith('/v1/plugins/data/query')) {
                    return { status: 200, data: { rows: [], changeCursor: 0 } };
                }
                if (url.endsWith('/v1/plugins/data/get')) {
                    return {
                        status: 200,
                        data: {
                            row: {
                                rowId: 'connection-1',
                                revision: 1,
                                content: { t: 'plain', v: {} },
                                projection: { id: 'connection-1', marker: HOST_MARKER },
                            },
                        },
                    };
                }
                if (url.includes('/v1/account/plugin-storage/')) {
                    return { status: 200, data: { status: 'updated', revision: 1 } };
                }
                throw new Error(`Unexpected fixture Account Data POST: ${url}`);
            },
        },
    });
}

async function seedAccountCollectionsActionFixture(params: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    declareAccountStorage?: boolean;
}>): Promise<void> {
    await mkdir(join(params.pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(params.pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Account Collections fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        hostAccess: params.declareAccountStorage === false
            ? { required: [], optional: [] }
            : {
                required: [{
                    id: ACCOUNT_STORAGE_HOST_ACCESS_ID,
                    capability: 'storage.account',
                    reason: 'Read the plugin Account collection state.',
                    scope: { enabled: true },
                }],
                optional: [],
            },
        contributes: {
            actions: [{
                id: 'read-channel-state',
                title: 'Read channel state',
                scopes: ['global'],
                surfaces: ['cli'],
                execution: { target: 'daemon' },
                placementBindings: ['primary'],
                dangerLevel: 'safe',
                ...(params.declareAccountStorage === false
                    ? {}
                    : { hostAccess: [ACCOUNT_STORAGE_HOST_ACCESS_ID] }),
            }],
            accountCollections: [{
                id: COLLECTION_ID,
                schemaVersion: 1,
                schema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', maxLength: 256 },
                        marker: { type: 'string', maxLength: 256 },
                    },
                    required: ['id', 'marker'],
                    additionalProperties: false,
                },
                serverReadable: ['id', 'marker'],
                indexes: [],
            }],
        },
    }), 'utf8');
    await writeFile(join(params.pluginRoot, 'daemon.mjs'), `export function activate(api) {
        api.actions.register('read-channel-state', async (_input, context) => {
            const accountStorage = context.services.storage.account;
            if (!accountStorage) return { marker: null, accountStorage: 'absent' };
            const row = await accountStorage.collection({
                id: '${COLLECTION_ID}',
                schemaVersion: 1,
                schema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', maxLength: 256 },
                        marker: { type: 'string', maxLength: 256 },
                    },
                    required: ['id', 'marker'],
                    additionalProperties: false,
                },
                rowIdField: 'id',
                serverReadable: ['id', 'marker'],
                indexes: [],
            }).get('connection-1');
            return { marker: row?.value?.marker ?? null };
        });
    }`, 'utf8');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir: params.happyHomeDir,
        pluginRoot: params.pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
    });
}

async function setFixtureOptionalAccountStorageSelection(params: Readonly<{
    happyHomeDir: string;
    selected: boolean;
}>): Promise<void> {
    const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
    const commit = await readPluginRegistryCommitRecord(paths);
    if (!commit) throw new Error('Expected current plugin registry fixture commit');
    const revision = await readInstallationStateRevision({
        paths,
        reference: commit.installationState,
        commit,
    });
    const installation = revision.plugins[PLUGIN_ID];
    const catalog = revision.runtimeCatalog?.plugins[PLUGIN_ID];
    if (!installation || !catalog || !revision.runtimeCatalog) {
        throw new Error('Expected complete Account Data notification fixture installation');
    }
    const selection = createDefaultPluginAccessScopeRegistry().createSelection({
        pluginId: PLUGIN_ID,
        accessId: ACCOUNT_STORAGE_HOST_ACCESS_ID,
        capability: 'storage.account',
        scope: { enabled: true },
        selectedAtMs: 1,
    });
    const optionalAccess = params.selected ? [selection] : [];
    const createdAtMs = Date.now();
    const installationState = await persistInstallationStateRevision({
        paths,
        state: {
            ...revision,
            revisionId: `state-${randomUUID()}`,
            createdAtMs,
            plugins: {
                ...revision.plugins,
                [PLUGIN_ID]: {
                    ...installation,
                    optionalAccess,
                },
            },
            runtimeCatalog: {
                ...revision.runtimeCatalog,
                plugins: {
                    ...revision.runtimeCatalog.plugins,
                    [PLUGIN_ID]: {
                        ...catalog,
                        install: {
                            ...catalog.install,
                            optionalAccess,
                        },
                    },
                },
            },
        },
    });
    await replacePluginRegistryCommitRecord({
        paths,
        expectedCurrent: commit,
        next: {
            ...commit,
            revision: commit.revision + 1,
            transactionId: `fixture-optional-account-storage-${randomUUID()}`,
            baseRevision: commit.revision,
            installationState,
            createdAtMs,
        },
    });
}

async function seedAccountNotificationChannelFixture(params: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    hostAccess: 'required' | 'optional';
    optionalSelected?: boolean;
    mutateAccountStorage?: boolean;
}>): Promise<void> {
    const accountStorageRequest = {
        id: ACCOUNT_STORAGE_HOST_ACCESS_ID,
        capability: 'storage.account',
        reason: 'Read the plugin Account collection state before delivery.',
        scope: { enabled: true },
    };
    const channelBody = params.mutateAccountStorage === true
        ? `
            const accountStorage = context.services.storage.account;
            if (!accountStorage) return {
                deliveryId: request.deliveryId,
                channelId: request.channelId,
                status: 'failed',
                code: 'plugin_account_storage_unavailable',
            };
            await accountStorage.kv.set('notification-state', { saved: true }, { expectedVersion: 'absent' });
            return {
                deliveryId: request.deliveryId,
                channelId: request.channelId,
                status: 'accepted',
                evidence: 'provider',
            };`
        : `let daemonStorageWorked = false;
            try {
                await context.services.storage.daemon.set('notification-local-state', true);
                daemonStorageWorked = await context.services.storage.daemon.get('notification-local-state') === true;
                const accountStorage = context.services.storage.account;
                if (!accountStorage) return {
                    deliveryId: request.deliveryId,
                    channelId: request.channelId,
                    status: 'failed',
                    code: 'plugin_account_storage_unavailable',
                };
                const row = await accountStorage.collection({
                    id: '${COLLECTION_ID}',
                    schemaVersion: 1,
                    schema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', maxLength: 256 },
                            marker: { type: 'string', maxLength: 256 },
                        },
                        required: ['id', 'marker'],
                        additionalProperties: false,
                    },
                    rowIdField: 'id',
                    serverReadable: ['id', 'marker'],
                    indexes: [],
                }).get('connection-1');
                return daemonStorageWorked && row?.value?.marker === '${HOST_MARKER}'
                    ? { deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted', evidence: 'provider' }
                    : { deliveryId: request.deliveryId, channelId: request.channelId, status: 'failed', code: 'notification_channel_state_unavailable' };
            } catch (error) {
                return {
                    deliveryId: request.deliveryId,
                    channelId: request.channelId,
                    status: 'failed',
                    code: daemonStorageWorked && typeof error?.code === 'string'
                        ? error.code
                        : 'notification_channel_local_storage_unavailable',
                };
            }`;
    await mkdir(join(params.pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(params.pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Account notification fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        hostAccess: params.hostAccess === 'required'
            ? { required: [accountStorageRequest], optional: [] }
            : { required: [], optional: [accountStorageRequest] },
        contributes: {
            actions: [{
                id: NOTIFICATION_ACTION_ID,
                title: 'Send account state',
                scopes: ['global'],
                surfaces: ['cli'],
                execution: { target: 'daemon' },
                placementBindings: ['primary'],
                dangerLevel: 'safe',
            }],
            events: [{
                id: 'account-state-event',
                kind: 'event',
                title: 'Account state event',
            }],
            notifications: [{
                id: NOTIFICATION_CATEGORY_ID,
                kind: 'activity',
                title: 'Account state',
                eventIds: ['account-state-event'],
                defaultChannels: [NOTIFICATION_CHANNEL_ID],
            }],
            notificationChannels: [{
                id: NOTIFICATION_CHANNEL_ID,
                // This fixture is delivered by its registered plugin sender;
                // external channel policy must not suppress the sender before
                // the Account Data boundary is exercised.
                kind: 'plugin',
                title: 'Account data channel',
                defaultEnabled: true,
            }],
            accountCollections: [{
                id: COLLECTION_ID,
                schemaVersion: 1,
                schema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', maxLength: 256 },
                        marker: { type: 'string', maxLength: 256 },
                    },
                    required: ['id', 'marker'],
                    additionalProperties: false,
                },
                serverReadable: ['id', 'marker'],
                indexes: [],
            }],
        },
    }), 'utf8');
    await writeFile(join(params.pluginRoot, 'daemon.mjs'), `export function activate(api) {
        api.actions.register('${NOTIFICATION_ACTION_ID}', async (input, context) => (
            await context.services.notifications.send({
                clientRequestId: input.clientRequestId,
                categoryId: '${NOTIFICATION_CATEGORY_ID}',
                title: 'Account state',
            })
        ));
        api.notifications.registerChannel('${NOTIFICATION_CHANNEL_ID}', async (request, context) => {
            ${channelBody}
        });
    }`, 'utf8');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir: params.happyHomeDir,
        pluginRoot: params.pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
    });
    if (params.hostAccess === 'optional') {
        await setFixtureOptionalAccountStorageSelection({
            happyHomeDir: params.happyHomeDir,
            selected: params.optionalSelected === true,
        });
    }
}

describe('executable plugin Account Collections binding', () => {
    beforeEach(() => {
        accountDataBoundary.readStoredCredentials.mockReset();
        accountDataBoundary.readStoredCredentials.mockResolvedValue(null);
        accountDataBoundary.get.mockReset();
        accountDataBoundary.post.mockReset();
    });

    afterEach(() => {
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('makes the canonical Account Data scope available to an activated action', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-collections-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-account-collections-plugin-'));
        const credentials = { token: 'fixture-account-token', encryption: null } satisfies StoredCredentials;
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            await seedAccountCollectionsActionFixture({ happyHomeDir, pluginRoot });

            const registryParams = Object.freeze({
                happyHomeDir,
                accountStorageDependencies: createFixtureAccountStorageDependencies(credentials),
            });
            runtime = await resolveExecutablePluginRuntimeRegistry(registryParams);
            await expect(runtime.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'actions',
                localId: 'read-channel-state',
            }])).resolves.toEqual([expect.objectContaining({
                pluginId: PLUGIN_ID,
                diagnostics: [],
            })]);

            await expect(runtime.targetActionInvocations?.invoke({
                pluginId: PLUGIN_ID,
                localId: 'read-channel-state',
                input: {},
                surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: { marker: HOST_MARKER },
            });
        } finally {
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('omits Account Data from an activated action that omits its HostAccess declaration', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-collections-undeclared-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-account-collections-undeclared-plugin-'));
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            await seedAccountCollectionsActionFixture({
                happyHomeDir,
                pluginRoot,
                declareAccountStorage: false,
            });
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                accountStorageDependencies: createFixtureAccountStorageDependencies({
                    token: 'fixture-account-token',
                    encryption: null,
                }),
            });
            await expect(runtime.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'actions',
                localId: 'read-channel-state',
            }])).resolves.toEqual([expect.objectContaining({
                pluginId: PLUGIN_ID,
                diagnostics: [],
            })]);

            await expect(runtime.targetActionInvocations?.invoke({
                pluginId: PLUGIN_ID,
                localId: 'read-channel-state',
                input: {},
                surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: { marker: null, accountStorage: 'absent' },
            });
        } finally {
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('binds the default live Account Data host to an activated action', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-collections-live-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-account-collections-live-plugin-'));
        const credentials = { token: 'live-account-token', encryption: null } satisfies StoredCredentials;
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        accountDataBoundary.readStoredCredentials.mockResolvedValue(credentials);
        accountDataBoundary.get.mockImplementation(async (url: string) => {
            if (!url.endsWith('/v1/account/encryption/currentness')) {
                throw new Error(`Unexpected Account Data GET: ${url}`);
            }
            return {
                status: 200,
                data: {
                    mode: 'plain',
                    version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: 1,
                },
            };
        });
        accountDataBoundary.post.mockImplementation(async (url: string, body: unknown) => {
            if (url.endsWith('/v1/plugins/data/query')) {
                return { status: 200, data: { rows: [], changeCursor: 0 } };
            }
            if (!url.endsWith('/v1/plugins/data/get')) {
                throw new Error(`Unexpected Account Data POST: ${url}`);
            }
            expect(body).toEqual({
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: 'connection-1',
            });
            return {
                status: 200,
                data: {
                    row: {
                        rowId: 'connection-1',
                        revision: 1,
                        content: { t: 'plain', v: {} },
                        projection: { id: 'connection-1', marker: HOST_MARKER },
                    },
                },
            };
        });
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });

        try {
            await seedAccountCollectionsActionFixture({ happyHomeDir, pluginRoot });

            // Omit dependency overrides: this exercises the registry's live default.
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            await expect(runtime.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'actions',
                localId: 'read-channel-state',
            }])).resolves.toEqual([expect.objectContaining({
                pluginId: PLUGIN_ID,
                diagnostics: [],
            })]);

            await expect(runtime.targetActionInvocations?.invoke({
                pluginId: PLUGIN_ID,
                localId: 'read-channel-state',
                input: {},
                surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: { marker: HOST_MARKER },
            });
            expect(accountDataBoundary.get).toHaveBeenCalledWith(
            expect.stringMatching(/\/v1\/account\/encryption\/currentness$/),
                expect.any(Object),
            );
            expect(accountDataBoundary.post).toHaveBeenCalledWith(
                expect.stringMatching(/\/v1\/plugins\/data\/get$/),
                expect.objectContaining({
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: 'connection-1',
                }),
                expect.any(Object),
            );
        } finally {
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('binds notification channels through required or exactly selected Account Data HostAccess while preserving ordinary local storage', async () => {
        const scenarios = [
            {
                name: 'required Account Data',
                hostAccess: 'required' as const,
                accountStorage: 'bound' as const,
                expectedStatus: 'accepted' as const,
            },
            {
                name: 'exactly selected optional Account Data',
                hostAccess: 'optional' as const,
                optionalSelected: true,
                accountStorage: 'bound' as const,
                expectedStatus: 'accepted' as const,
            },
            {
                name: 'unselected optional Account Data',
                hostAccess: 'optional' as const,
                optionalSelected: false,
                accountStorage: 'bound' as const,
                expectedStatus: 'failed' as const,
            },
        ];

        for (const scenario of scenarios) {
            const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-notification-home-'));
            const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-account-notification-plugin-'));
            let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

            try {
                await seedAccountNotificationChannelFixture({
                    happyHomeDir,
                    pluginRoot,
                    hostAccess: scenario.hostAccess,
                    ...(scenario.hostAccess === 'optional'
                        ? { optionalSelected: scenario.optionalSelected }
                        : {}),
                });
                runtime = await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    accountStorageDependencies: createFixtureAccountStorageDependencies(
                        { token: 'fixture-account-token', encryption: null },
                    ),
                });
                await expect(runtime.activateContributionsOnDemand([{
                    pluginId: PLUGIN_ID,
                    family: 'actions',
                    localId: NOTIFICATION_ACTION_ID,
                }])).resolves.toEqual([expect.objectContaining({
                    pluginId: PLUGIN_ID,
                    diagnostics: [],
                })]);

                const result = await runtime.targetActionInvocations?.invoke({
                    pluginId: PLUGIN_ID,
                    localId: NOTIFICATION_ACTION_ID,
                    input: {
                        clientRequestId: `notification-${scenario.hostAccess}-${scenario.accountStorage}-${
                            scenario.optionalSelected === true ? 'selected' : 'unselected'
                        }`,
                    },
                    surface: 'cli',
                });
                expect(result).toMatchObject({
                    status: 'executed',
                    value: {
                        replayed: false,
                        deliveries: [expect.objectContaining({
                            channelId: `${PLUGIN_ID}/${NOTIFICATION_CHANNEL_ID}`,
                            status: scenario.expectedStatus,
                            ...(scenario.expectedStatus === 'accepted'
                                ? { evidence: 'provider' }
                                : { code: 'plugin_account_storage_unavailable' }),
                        })],
                    },
                });
            } finally {
                await runtime?.dispose();
                await rm(happyHomeDir, { recursive: true, force: true });
                await rm(pluginRoot, { recursive: true, force: true });
            }
        }
    }, 60_000);

    it('fences a held notification sender from Account mutation after committed authority flips', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-notification-currentness-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-account-notification-currentness-plugin-'));
        const credentials = { token: 'notification-account-token', encryption: null } satisfies StoredCredentials;
        const credentialsReadStarted = deferred<void>();
        const releaseCredentials = deferred<StoredCredentials>();
        let holdCredentials = false;
        let committedGenerationCurrent = true;
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        accountDataBoundary.readStoredCredentials.mockImplementation(async () => {
            if (!holdCredentials) return credentials;
            credentialsReadStarted.resolve(undefined);
            return await releaseCredentials.promise;
        });
        accountDataBoundary.get.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/encryption/currentness')) {
                return {
                    status: 200,
                    data: {
                        mode: 'plain',
                        version: 1,
                        signingKeyFingerprint: null,
                        contentKeyFingerprint: null,
                        updatedAt: 1,
                    },
                };
            }
            if (url.endsWith(`/v1/account/plugin-storage/${encodeURIComponent(PLUGIN_ID)}`)) {
                return { status: 200, data: { status: 'absent' } };
            }
            throw new Error(`Unexpected Account Data GET: ${url}`);
        });
        accountDataBoundary.post.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/plugins/data/query')) {
                return { status: 200, data: { rows: [], changeCursor: 0 } };
            }
            if (!url.endsWith(`/v1/account/plugin-storage/${encodeURIComponent(PLUGIN_ID)}`)) {
                throw new Error(`Unexpected Account Data POST: ${url}`);
            }
            return { status: 200, data: { status: 'updated', revision: 1 } };
        });
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });

        try {
            await seedAccountNotificationChannelFixture({
                happyHomeDir,
                pluginRoot,
                hostAccess: 'required',
                mutateAccountStorage: true,
            });
            const authority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                { bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS },
            );
            if (!authority) throw new Error('Expected notification fixture generation authority');
            const generationAuthority = Object.freeze({
                ...authority,
                isCurrent: async () => committedGenerationCurrent,
            });
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, generationAuthority });
            await expect(runtime.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'actions',
                localId: NOTIFICATION_ACTION_ID,
            }])).resolves.toEqual([expect.objectContaining({
                pluginId: PLUGIN_ID,
                diagnostics: [],
            })]);

            const credentialReadsBeforeDispatch = accountDataBoundary.readStoredCredentials.mock.calls.length;
            const accountGetsBeforeDispatch = accountDataBoundary.get.mock.calls.length;
            const accountPostsBeforeDispatch = accountDataBoundary.post.mock.calls.length;
            holdCredentials = true;
            const pending = runtime.targetActionInvocations?.invoke({
                pluginId: PLUGIN_ID,
                localId: NOTIFICATION_ACTION_ID,
                input: { clientRequestId: 'notification-currentness-held-sender' },
                surface: 'cli',
            });
            if (!pending) throw new Error('Expected an activated notification action invoker');
            await vi.waitFor(() => {
                expect(accountDataBoundary.readStoredCredentials).toHaveBeenCalledTimes(
                    credentialReadsBeforeDispatch + 1,
                );
            });
            await credentialsReadStarted.promise;
            committedGenerationCurrent = false;
            releaseCredentials.resolve(credentials);

            await expect(pending).resolves.toMatchObject({
                status: 'executed',
                value: {
                    deliveries: [expect.objectContaining({
                        channelId: `${PLUGIN_ID}/${NOTIFICATION_CHANNEL_ID}`,
                        status: 'outcomeUnknown',
                        code: 'plugin_notification_outcome_unknown',
                    })],
                },
            });
            expect(accountDataBoundary.get).toHaveBeenCalledTimes(accountGetsBeforeDispatch);
            expect(accountDataBoundary.post).toHaveBeenCalledTimes(accountPostsBeforeDispatch);
        } finally {
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
});
