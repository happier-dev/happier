import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createPluginReloadController } from './reload/controller';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createPackedTestConnectedAccountsRuntime } from '@/plugins/daemon/packedTestConnectedAccounts';
import { logger } from '@/ui/logger';
import { evaluateManifestPluginDevelopmentCandidate } from '@/plugins/authoring/sourceModule';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { bindPluginRuntimeSourceAuthority } from './sourceAuthority';
import { registerDaemonContributionRegistryProjectionHandler, invalidateDaemonContributionRegistryProjectionCache } from '@/rpc/handlers/daemonContributionRegistryProjection';
import type { StoredCredentials } from '@/persistence';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readAccountNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

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
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import { resolveExecutablePluginRuntimeRegistry as resolveExecutablePluginRuntimeRegistryProduction } from './resolveExecutablePluginRuntimeRegistry';

// These Account boundary fixtures serve the installed test declarations, not
// every bundled plugin's distinct Account/service requirements. Discovery,
// declaration normalization, activation and storage remain the real owners.
async function resolveExecutablePluginRuntimeRegistry(
    params: NonNullable<Parameters<typeof resolveExecutablePluginRuntimeRegistryProduction>[0]>,
) {
    return resolveExecutablePluginRuntimeRegistryProduction({
        ...params,
        contributes: params.contributes ?? createResolvedContributionRegistry(
            await resolvePluginContributes({ happyHomeDir: params.happyHomeDir, existingAgentIds: new Set() }),
        ),
    });
}

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
            recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
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
                            absenceEpoch: 0,
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
    includePage?: boolean;
    pluginId?: string;
    includeAvailability?: boolean;
    includeNestedAction?: boolean;
    providerPluginId?: string;
    contributeToPluginId?: string;
}>): Promise<void> {
    const nestedTarget = params.includeNestedAction ? definePlugin({
        id: params.pluginId ?? PLUGIN_ID, version: '1.0.0',
        contributionPoints: { providers: defineContributionProtocol({
            id: 'fixture-provider', version: 1,
            operations: { poll: { required: true, input: { kind: 'contributorDefined' },
                resultSchema: defineProtocolObject({ marker: defineProtocolString() }, { policy: 'closed' }),
                action: { surfaces: ['plugin'], dangerLevel: 'safe' },
            } },
        }).point() },
    }) : undefined;
    await mkdir(join(params.pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(params.pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: params.pluginId ?? PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Account Collections fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs', ...(params.includePage ? { development: './daemon.mjs' } : {}) },
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
            ...(params.includeNestedAction ? { backgroundServices: [{ id: 'poll-source' }] } : {}),
            ...(nestedTarget ? {
                pluginContributionPoints: nestedTarget.manifest.contributes?.pluginContributionPoints,
                targetedPluginContributions: params.providerPluginId ? [] : [
                    { id: 'self-provider', target: { pluginId: params.pluginId ?? PLUGIN_ID, pointId: 'providers' },
                        protocol: { id: 'fixture-provider', version: 1 }, operations: { poll: 'read-channel-state' } },
                    ...(params.contributeToPluginId ? [{ id: 'outer-provider', target: { pluginId: params.contributeToPluginId, pointId: 'providers' },
                        protocol: { id: 'fixture-provider', version: 1 }, operations: { poll: 'read-channel-state' } }] : []),
                ],
            } : {}),
            ...(params.includePage ? { ui: {
                renderers: [{ id: 'page-renderer', kind: 'declarative', root: { kind: 'text', text: 'Account page' } }],
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'page-renderer', title: 'Account page' }],
            } } : {}),
            actions: [{
                id: 'read-channel-state',
                title: 'Read channel state',
                scopes: ['global'],
                surfaces: params.includeNestedAction ? ['cli', 'plugin'] : ['cli'],
                execution: { target: 'daemon' },
                placementBindings: ['primary'],
                dangerLevel: 'safe',
                ...(params.includeNestedAction ? { inputSchema: { type: 'object' }, resultSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } } : {}),
                ...(params.declareAccountStorage === false
                    ? {}
                    : { hostAccess: [ACCOUNT_STORAGE_HOST_ACCESS_ID] }),
            }, ...(params.includeNestedAction ? [{
                id: 'poll-provider', title: 'Poll provider', scopes: ['global'],
                surfaces: ['cli'], execution: { target: 'daemon' },
                placementBindings: ['primary'], dangerLevel: 'safe',
            }] : [])],
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
    await writeFile(join(params.pluginRoot, 'daemon.mjs'), `${params.includePage ? `export const collectionMigrations = { '${COLLECTION_ID}': [] };` : ''}
    let backgroundOutcome = null;
    let wakeBackground;
    async function poll(context, routingOverride) {
        const observation = context.services.targetedContributions.observeForSelf(
            ${JSON.stringify(nestedTarget?.contributionPoints.providers ?? null)}, { onInvalidated() {} },
        );
        try {
            const current = await observation.readCurrent({ signal: context.signal });
            return await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
                current.contributions[0].operations.poll, ${params.providerPluginId ? '{ nest: true }' : '{}'},
                { expectedExecutionRouting: routingOverride ?? { serverIdentityId: 'srv_page',
                    pluginId: '${params.providerPluginId ?? params.pluginId ?? PLUGIN_ID}', machineId: 'machine-page',
                } },
            );
        } finally { observation.dispose(); }
    }
    export function activate(api) {
        ${params.includeNestedAction ? `api.actions.register('poll-provider', async (input, context) => {
            if (input.background) return backgroundOutcome;
            if (input.wake) { backgroundOutcome = null; wakeBackground?.(); return {}; }
            return await poll(context, input.routingOverride);
        });
        api.backgroundServices.register('poll-source', async context => {
            while (!context.signal.aborted) {
                await new Promise(resolve => {
                    wakeBackground = resolve;
                    context.signal.addEventListener('abort', resolve, { once: true });
                });
                context.signal.removeEventListener('abort', wakeBackground);
                if (context.signal.aborted) break;
                try { backgroundOutcome = await poll(context); }
                catch (error) { backgroundOutcome = { code: error.code, message: error.message }; }
            }
        });` : ''}
        api.actions.register('read-channel-state', async (_input, context) => {
            ${params.includeNestedAction ? 'if (_input.nest) return (await poll(context)).result;' : ''}
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
        pluginId: params.pluginId ?? PLUGIN_ID,
        manifestVersion: '1.0.0',
        ...(params.includePage ? { devWatch: true } : {}),
        ...(params.includeAvailability ? { includeAvailability: true } : {}),
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
                ...(input.itemId ? { itemId: input.itemId, type: 'update', channelIds: [] } : {}),
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

    it('reports each refused Account declaration with its plugin id and typed reason through the daemon owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-publication-refusals-home-'));
        const pluginRoots = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'happier-publication-refusals-plugin-'))));
        const pluginIds = [PLUGIN_ID, 'acme.publication-peer'];
        const attempted: string[] = [];
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let controller: ReturnType<typeof createPluginReloadController> | null = null;
        let owner: ReturnType<typeof createDaemonPluginRuntimeOwner> | null = null;
        const debug = vi.spyOn(logger, 'debug');
        try {
            for (const [index, pluginRoot] of pluginRoots.entries()) {
                await seedAccountCollectionsActionFixture({ happyHomeDir, pluginRoot, pluginId: pluginIds[index], includePage: true, includeAvailability: true });
            }
            const loaded = projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external', existingAgentIds: new Set(),
            });
            const graphs = await Promise.all((loaded.activationTargets ?? []).map(async (target) => {
                if (!target.devDaemonEntryPath) throw new Error('Expected development fixture entry');
                const source = await resolveLocalPathPluginSource({ locator: dirname(target.devDaemonEntryPath) });
                if (!source.ok) throw new Error('Expected development fixture source');
                const authority = bindPluginRuntimeSourceAuthority({
                    custody: { kind: 'development', registeredRootId: source.pluginRootPath },
                    resolvedRoot: source.pluginRootPath, observedRevision: 1,
                });
                if (authority.kind !== 'development') throw new Error('Expected development fixture authority');
                const candidate = await evaluateManifestPluginDevelopmentCandidate({ source, sourceAuthority: authority });
                return [target.pluginId, candidate.graph] as const;
            }));
            const dependencies = createFixtureAccountStorageDependencies({ token: 'publication-refusal-token', encryption: null });
            const http = dependencies.http;
            if (!http) throw new Error('Expected the Account Data HTTP fixture');
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir, contributes: createResolvedContributionRegistry(loaded),
                preparedDevelopmentActivationGraphsByPluginId: new Map(graphs),
                accountStorageDependencies: {
                    ...dependencies,
                    http: { ...http, async post(_url, body) {
                        const request = JSON.parse(body) as { manifest: { id: string } };
                        attempted.push(request.manifest.id);
                        return { status: 409, data: { error: 'plugin_collection_contract_conflict' } };
                    } },
                },
            });
            expect(runtime.readPluginSourceCustody?.(PLUGIN_ID)).toMatchObject({ kind: 'development' });
            controller = createPluginReloadController({ resolveRuntimeRegistry: async () => runtime! });
            const initialLease = await controller.acquireRuntimeRegistry();
            await initialLease.release();
            owner = createDaemonPluginRuntimeOwner({
                happyHomeDir, reloadController: controller, staleCandidateCleanup: 'disabled',
                connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId: PLUGIN_ID }).owner,
                availabilityReporter: { report: async () => undefined },
            });
            owner.reportCurrentAvailability();
            await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(
                '[PLUGIN RUNTIME] Plugin availability report failed (non-fatal)',
                expect.objectContaining({ failures: pluginIds.map(pluginId => ({ pluginId, code: 'plugin_collection_contract_conflict' })) }),
            ));
            expect(attempted).toEqual(pluginIds);
        } finally {
            debug.mockRestore();
            await owner?.changeService.shutdown();
            await controller?.shutdown();
            await runtime?.dispose();
            for (const path of [happyHomeDir, ...pluginRoots]) await rm(path, { recursive: true, force: true });
        }
    }, 60_000);

    it('keeps release-less Account declaration identity out of app-page origin selection and uses source custody for background provider calls', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-release-less-page-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-release-less-page-plugin-'));
        const providerRoot = await mkdtemp(join(tmpdir(), 'happier-release-less-provider-plugin-'));
        const providerPluginId = 'acme.email-transport';
        let originMachineId = 'machine-page';
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        const controller = createPluginReloadController();
        try {
            await seedAccountCollectionsActionFixture({ happyHomeDir, pluginRoot, includePage: true, includeNestedAction: true, providerPluginId });
            await seedAccountCollectionsActionFixture({ happyHomeDir, pluginRoot: providerRoot, pluginId: providerPluginId, includePage: true, includeNestedAction: true, contributeToPluginId: PLUGIN_ID });
            accountDataBoundary.readStoredCredentials.mockResolvedValue({ token: 'fixture-account-token', encryption: null });
            const loaded = await resolvePluginContributes({ happyHomeDir, existingAgentIds: new Set() });
            const target = loaded.activationTargets?.find((entry) => entry.pluginId === PLUGIN_ID);
            if (!target?.devDaemonEntryPath) throw new Error('Expected the fixture development entry');
            const source = await resolveLocalPathPluginSource({ locator: dirname(target.devDaemonEntryPath) });
            if (!source.ok) throw new Error('Expected the fixture development source');
            const sourceAuthority = bindPluginRuntimeSourceAuthority({
                custody: { kind: 'development', registeredRootId: source.pluginRootPath },
                resolvedRoot: source.pluginRootPath, observedRevision: 1,
            });
            if (sourceAuthority.kind !== 'development') throw new Error('Expected development custody');
            const development = await evaluateManifestPluginDevelopmentCandidate({ source, sourceAuthority });
            const providerTarget = loaded.activationTargets?.find(entry => entry.pluginId === providerPluginId);
            if (!providerTarget?.devDaemonEntryPath) throw new Error('Expected the provider development entry');
            const providerSource = await resolveLocalPathPluginSource({ locator: dirname(providerTarget.devDaemonEntryPath) });
            if (!providerSource.ok) throw new Error('Expected provider development source');
            const providerAuthority = bindPluginRuntimeSourceAuthority({
                custody: { kind: 'development', registeredRootId: providerSource.pluginRootPath },
                resolvedRoot: providerSource.pluginRootPath, observedRevision: 1,
            });
            if (providerAuthority.kind !== 'development') throw new Error('Expected provider development custody');
            const providerDevelopment = await evaluateManifestPluginDevelopmentCandidate({ source: providerSource, sourceAuthority: providerAuthority });
            // A daemon-selected development declaration has no install materialization.
            // Keep the real manifest, activation graph and Account storage below this input.
            const contributes = createResolvedContributionRegistry({ ...loaded, materializationIdsByPluginId: {} });
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir, contributes,
                preparedDevelopmentActivationGraphsByPluginId: new Map([[PLUGIN_ID, development.graph], [providerPluginId, providerDevelopment.graph]]),
                resolveCurrentMachineId: () => 'machine-page',
                targetedContributions: controller.getTargetedContributionsOwner(),
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_page', machineId: originMachineId }),
                accountStorageDependencies: createFixtureAccountStorageDependencies({ token: 'fixture-account-token', encryption: null }),
            });
            const lease = await controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => runtime! });
            await lease.release();
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
            invalidateDaemonContributionRegistryProjectionCache();
            registerDaemonContributionRegistryProjectionHandler(registrar, {
                resolveRuntimeRegistry: async () => runtime!,
                resolveGeneration: async () => 1,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: async () => ({ serverIdentityId: 'srv_page', machineId: 'machine-page' }),
            });
            const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handlers.get(
                RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            )!({ machineId: 'machine-page' }));
            const page = response.projection.familiesById.pluginUi?.entriesById[`surfacePlacement:${PLUGIN_ID}:page`];
            expect(page).toMatchObject({ contributionKind: 'surfacePlacement', availability: { state: 'available' } });
            expect(page).not.toHaveProperty('materializationRef');
            expect(page).not.toHaveProperty('serverIdentityId');

            await runtime.activateContributionsOnDemand([{ pluginId: PLUGIN_ID, family: 'actions', localId: 'read-channel-state' }]);
            expect(runtime.resolveCurrentPluginMaterializationRef?.(PLUGIN_ID)).toEqual({
                pluginId: PLUGIN_ID, machineId: 'machine-page', materializationId: `daemon-selected:${PLUGIN_ID}`,
            });
            await expect(runtime.targetActionInvocations?.invoke({ pluginId: PLUGIN_ID, localId: 'read-channel-state', input: {}, surface: 'cli' }))
                .resolves.toEqual({ status: 'executed', value: { marker: HOST_MARKER } });
            await runtime.activateContributionsOnDemand([{ pluginId: PLUGIN_ID, family: 'actions', localId: 'poll-provider' }]);
            expect(runtime.pluginDiagnosticsByPluginId[PLUGIN_ID] ?? []).toEqual([]);
            await expect(runtime.targetActionInvocations?.invoke({ pluginId: PLUGIN_ID, localId: 'poll-provider', input: {}, surface: 'cli' }))
                .resolves.toEqual({ status: 'executed', value: {
                    result: { marker: HOST_MARKER },
                    executionOrigin: { serverIdentityId: 'srv_page', sourceRef: { pluginId: providerPluginId, machineId: 'machine-page', sourceCustody: runtime.readPluginSourceCustody?.(providerPluginId) } },
                } });
            for (const override of [
                { serverIdentityId: 'srv_other', machineId: 'machine-page', pluginId: providerPluginId },
                { serverIdentityId: 'srv_page', machineId: 'other-machine', pluginId: providerPluginId },
                { serverIdentityId: 'srv_page', machineId: 'machine-page', pluginId: 'acme.other' },
            ]) {
                await expect(runtime.targetActionInvocations?.invoke({
                    pluginId: PLUGIN_ID, localId: 'poll-provider', input: { routingOverride: override }, surface: 'cli',
                })).resolves.toMatchObject({ status: 'failed', code: 'plugin_action_execution_origin_mismatch' });
            }
            runtime.startAdoptedBackgroundServices?.();
            await runtime.targetActionInvocations?.invoke({ pluginId: PLUGIN_ID, localId: 'poll-provider', input: { wake: true }, surface: 'cli' });
            await vi.waitFor(async () => {
                const background = await runtime?.targetActionInvocations?.invoke({ pluginId: PLUGIN_ID, localId: 'poll-provider', input: { background: true }, surface: 'cli' });
                expect(background).toEqual({ status: 'executed', value: {
                    result: { marker: HOST_MARKER },
                    executionOrigin: { serverIdentityId: 'srv_page', sourceRef: { pluginId: providerPluginId, machineId: 'machine-page', sourceCustody: runtime?.readPluginSourceCustody?.(providerPluginId) } },
                } });
            });
            originMachineId = 'different-machine';
            await expect(runtime.targetActionInvocations?.invoke({ pluginId: PLUGIN_ID, localId: 'poll-provider', input: {}, surface: 'cli' }))
                .resolves.toMatchObject({ status: 'failed', code: 'plugin_action_caller_unavailable' });
            runtime.retireConsumers();
            expect(runtime.resolveCurrentPluginMaterializationRef?.(PLUGIN_ID)).toBeNull();
        } finally {
            invalidateDaemonContributionRegistryProjectionCache();
            await controller.shutdown();
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(providerRoot, { recursive: true, force: true });
        }
    }, 60_000);

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
        accountDataBoundary.post.mockImplementation(async (url: string, body: string) => {
            if (url.endsWith('/v1/plugins/data/query')) {
                return { status: 200, data: { rows: [], changeCursor: 0 } };
            }
            if (!url.endsWith('/v1/plugins/data/get')) {
                throw new Error(`Unexpected Account Data POST: ${url}`);
            }
            expect(JSON.parse(body)).toEqual({
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: 'connection-1',
                readerContext: expect.objectContaining({
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    schemaVersion: 1,
                    contractDigest: runtime?.contributes.accountCollections?.find(entry => entry.pluginId === PLUGIN_ID)?.definition.contractDigest,
                }),
            });
            return {
                status: 200,
                data: {
                    absenceEpoch: 0,
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
            // The host hands the transport an already-encoded body, so the
            // exact request is asserted through the wire bytes it sent.
            const collectionGetCall = accountDataBoundary.post.mock.calls.find(
                (call: readonly unknown[]) => /\/v1\/plugins\/data\/get$/.test(String(call[0])),
            );
            expect(collectionGetCall).toBeDefined();
            expect(JSON.parse(String(collectionGetCall?.[1]))).toMatchObject({
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: 'connection-1',
            });
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

    it('writes an installed external plugin notice through the production Account Artifact binding', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-notice-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-account-notice-plugin-'));
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'notice-owner' })).toString('base64url')}.signature`, encryption: null };
        accountDataBoundary.readStoredCredentials.mockResolvedValue(credentials);
        const written: Array<{ header: unknown; body: unknown }> = [];
        accountDataBoundary.get.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (new URL(url).pathname === '/v1/artifacts') return { status: 200, data: [] };
            if (url.includes('/v1/artifacts/')) return { status: 404, data: {} };
            throw new Error(`Unexpected notice GET: ${url}`);
        });
        accountDataBoundary.post.mockImplementation(async (url: string, input: { id: string; header: string; body: string }) => {
            if (!url.endsWith('/v1/artifacts')) throw new Error(`Unexpected notice POST: ${url}`);
            written.push({ header: decodePlainArtifactStoredContent(input.header), body: decodePlainArtifactStoredContent(input.body) });
            return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
        });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            await seedAccountNotificationChannelFixture({ happyHomeDir, pluginRoot, hostAccess: 'optional' });
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            await runtime.activateContributionsOnDemand([{ pluginId: PLUGIN_ID, family: 'actions', localId: NOTIFICATION_ACTION_ID }]);
            await expect(runtime.targetActionInvocations?.invoke({ pluginId: PLUGIN_ID, localId: NOTIFICATION_ACTION_ID,
                input: { clientRequestId: 'notice-request', itemId: 'work-1' }, surface: 'cli' }))
                .resolves.toMatchObject({ status: 'executed', value: { replayed: false, deliveries: [] } });
            expect(written).toHaveLength(1);
            const value = written[0]!;
            expect(readAccountNoticeArtifactV1({ header: value.header,
                body: value.body && typeof value.body === 'object' && 'body' in value.body ? value.body.body : null }))
                .toMatchObject({ source: { kind: 'plugin', pluginId: PLUGIN_ID, itemId: 'work-1' }, type: 'update', status: 'open' });
        } finally {
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('fences a held notification sender from Account mutation after its occurrence retires', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-notification-currentness-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-account-notification-currentness-plugin-'));
        const credentials = { token: 'notification-account-token', encryption: null } satisfies StoredCredentials;
        const credentialsReadStarted = deferred<void>();
        const releaseCredentials = deferred<StoredCredentials>();
        let holdCredentials = false;
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
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
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
            runtime.fencePluginConsumers?.([PLUGIN_ID]);
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
