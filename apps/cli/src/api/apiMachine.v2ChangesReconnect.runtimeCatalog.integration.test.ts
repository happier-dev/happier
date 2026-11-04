import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';
import { buildConnectedServiceCredentialRecord, FeaturesResponseSchema, QualifiedConnectedAccountCredentialHealthPatchV4Schema } from '@happier-dev/protocol';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { QualifiedConnectedAccountGroupResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '@happier-dev/plugins-claude/agent';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { buildProfilePhysicalKey, ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { refreshActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import { refreshActivePromptLibraryCatalog } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { buildPromptLibraryPhysicalKeyV1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import * as persistence from '@/persistence';
import { ApiClient } from '@/api/api';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { hydrateSavedSecretCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';

import type { Machine } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';
import { configuration } from '@/configuration';
import { readProjectAccountRows, getActiveProjectAccountRowsSnapshot, subscribeActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
    clearActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { bindApiSessionSocketMock } from '@/testkit/backends/apiSessionSocketHarness';
import { createApiMachineSocketFixture as createMachineSocket } from '@/testkit/apiMachineTransport';
import { createDeferred } from '@/testkit/async/deferred';
import { logger } from '@/ui/logger';
import { getConnectedServiceStateSharingDescriptor, resolveConnectedServiceMaterializedHomeRoot } from '@/daemon/connectedServices/catalogHooks';
import { readCurrentCatalogHook } from '@/agent/catalog/runtimeEntry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { ConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { bootstrapMachineSyncRuntime } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { ApiMachineClient, type ManagedMachinePolicyInvalidation } from './apiMachine';
import { createDaemonTeamCredentialDirectMaterialReconciler, subscribeTeamCredentialDirectMaterialAccountChanges, subscribeTeamCredentialDirectMaterialSourceChanges } from '@/daemon/connectedServices/directMaterial/daemonTeamCredentialDirectMaterialReconciler';
import { attachPluginWebhookDaemonWakeV1 } from '@/plugins/runtime/webhooks/pluginWebhookDaemonWake';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/accountUsage';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import { buildSessionFollowReceiverChangeEntityIdV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { createLightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../server/sources/storage/db';
import { inTx } from '../../../server/sources/storage/inTx';
import { markAccountChanged } from '../../../server/sources/app/changes/markAccountChanged';
import { eventRouter } from '../../../server/sources/app/events/connectionEventRouter';
import { getAccountStoredContentV3SocketRoom } from '../../../server/sources/app/api/socketRooms';
import { createAuthenticatedTestApp } from '../../../server/sources/app/api/testkit/sqliteFastify';
import { changesRoutes } from '../../../server/sources/app/api/routes/changes/changesRoutes';
import { registerProviderConnectionsRoutes } from '../../../server/sources/app/account/providers/registerProviderConnectionsRoutes';
import { mutateProviderConnectionsRowInTx } from '../../../server/sources/app/account/providers/connectionRows';
import { registerSavedSecretResourceRoutes } from '../../../server/sources/app/api/routes/account/registerSavedSecretResourceRoutes';
import { registerAccountSettingsRoutes } from '../../../server/sources/app/api/routes/account/registerAccountSettingsRoutes';
import { createSavedSecretResourceInTx } from '../../../server/sources/app/account/savedSecrets/savedSecretResourceService';
import { writeAccountSettingsInTx } from '../../../server/sources/app/accountSettings/writeAccountSettingsInTx';
import { publishAccountTeamMembershipsChangedInTx } from '../../../server/sources/app/teams/teamChanges';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { recordConnectedServiceAccountProfileChange } from '../../../server/sources/app/api/routes/connect/connectedServicesAccountProfileChange';
import { listQualifiedConnectedAccounts, mutateQualifiedConnectedServiceCredential, mutateQualifiedConnectedServiceCredentialHealth, readQualifiedConnectedServiceCredential } from '../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { ConnectedServiceRefreshCoordinator } from '@/daemon/connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { homeDomainActionTransportV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams';
import { createHttpTeamCredentialDirectMaterialClient } from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { registerTeamRoutes } from '../../../server/sources/app/teams/registerTeamRoutes';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from '../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4';
import { readQualifiedConnectedAccountSourceIdentityInTx } from '../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { listQualifiedConnectedAccountsV4, listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { QualifiedConnectedAccountServiceRefSchema, QualifiedConnectedAccountServiceListV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { writeSessionTeamCredentialBindingsInTx } from '../../../server/sources/app/teams/credentials/sessionBinding';
import {
    publishPluginAccountCollectionWatchInvalidation as publishCollectionChange,
    readPluginAccountAvailabilityChangeKey,
    retirePluginAccountCollectionWatchScope,
    subscribePluginAccountCollectionWatchInvalidation,
    subscribePluginAccountSettingsWatchInvalidation,
} from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';

const { claudeProvenanceReplaceCount } = vi.hoisted(() => ({
    claudeProvenanceReplaceCount: { current: 0 },
}));
const checkpointIo = vi.hoisted(() => ({
    publications: [] as string[],
    refuseCheckpoint: false,
}));
// Observe/interfere only at the OS publication boundary; persistence stays real.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        renameSync: (oldPath: Parameters<typeof actual.renameSync>[0], newPath: Parameters<typeof actual.renameSync>[1]) => {
            const destination = String(newPath);
            if (destination.endsWith('changes-cursors.json') && checkpointIo.refuseCheckpoint) {
                throw Object.assign(new Error('checkpoint publication interrupted'), { code: 'EIO' });
            }
            actual.renameSync(oldPath, newPath);
            checkpointIo.publications.push(destination);
        },
    };
});
const {
    mockIo,
    axiosGet,
    axiosPost,
    axiosPut,
    axiosDelete,
    axiosIsAxiosError,
        readAccountChangesCursor,
        writeAccountChangesCursor,
} = vi.hoisted(() => {
    return {
        mockIo: vi.fn(),
        axiosGet: vi.fn(),
        axiosPost: vi.fn(),
        axiosPut: vi.fn(),
        axiosDelete: vi.fn(),
        axiosIsAxiosError: vi.fn((error: unknown) => (
            typeof error === 'object' && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true
        )),
        readAccountChangesCursor: vi.fn(async () => 0),
        writeAccountChangesCursor: vi.fn(async (_accountId: string, _cursor: number) => {}),
    };
});

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        rename: async (
            oldPath: Parameters<typeof actual.rename>[0],
            newPath: Parameters<typeof actual.rename>[1],
        ) => {
            const destination = String(newPath);
            if (String(newPath).endsWith('.happier-claude-connected-service-home.json')) {
                claudeProvenanceReplaceCount.current += 1;
            }
            await actual.rename(oldPath, newPath);
            checkpointIo.publications.push(destination);
        },
    };
});

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('axios', () => ({
    default: {
        get: axiosGet,
        post: axiosPost,
        put: axiosPut,
        delete: axiosDelete,
        isAxiosError: axiosIsAxiosError,
    },
    isAxiosError: axiosIsAxiosError,
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readAccountChangesCursor,
    writeAccountChangesCursor,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        infoFile: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debugLargeJson: vi.fn(),
        warnLocalFile: vi.fn(),
    },
}));

// Observe real consumer notifications; parsing, coalescing and retention remain real.
const publishPluginAccountCollectionWatchInvalidation = vi.fn();
const publishPluginAccountSettingsWatchInvalidation = vi.fn();
let unsubscribeCollection: () => void;
let unsubscribeSettings: () => void;
function admitAccountSnapshot(token = 'token') {
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken(token) });
}

async function createRefreshingMachineClient(token: string, machine: Machine) {
    if (machine.encryptionMode === 'plain' || machine.encryptionVariant !== 'legacy') {
        throw new Error('The refresh fixture requires its legacy Account credential');
    }
    return (await ApiClient.create({ token, encryption: { type: 'legacy', secret: machine.encryptionKey } })).machineSyncClient(machine);
}

// These are neighboring Home HTTP routes used by the real Account hydrator
// and connection supervisor. Keep each test's change-feed response independent.
function mockAccountGet(implementation: (url: string, options?: Readonly<{ signal?: AbortSignal; params?: unknown }>) => unknown) {
    axiosGet.mockImplementation(async (url: string, options?: Readonly<{ signal?: AbortSignal; params?: unknown }>) => {
        if (url.endsWith('/v1/account/saved-secrets/resources/materials')) {
            return { status: 200, data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [] }) };
        }
        if (url.endsWith('/v1/auth/ping')) return { status: 200, data: {} };
        return await implementation(url, options);
    });
}

beforeEach(() => {
    axiosGet.mockReset();
    mockAccountGet(async url => { throw new Error(`Unexpected Account HTTP read: ${url}`); });
    axiosPost.mockReset();
    axiosPut.mockReset();
    axiosDelete.mockReset();
    readAccountChangesCursor.mockReset().mockResolvedValue(0);
    writeAccountChangesCursor.mockReset().mockResolvedValue(undefined);
    withdrawActiveProjectAccountRowsSnapshot();
    admitAccountSnapshot();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} })));
    const accountScopeKey = resolveAccountSettingsScopeKeyForToken('token');
    retirePluginAccountCollectionWatchScope(accountScopeKey);
    publishPluginAccountCollectionWatchInvalidation.mockClear();
    publishPluginAccountSettingsWatchInvalidation.mockClear();
    unsubscribeCollection = subscribePluginAccountCollectionWatchInvalidation({
        accountScopeKey, pluginId: 'example.tasks', collectionId: 'tasks', contractDigest: 'a'.repeat(43),
    }, publishPluginAccountCollectionWatchInvalidation);
    unsubscribeSettings = subscribePluginAccountSettingsWatchInvalidation(publishPluginAccountSettingsWatchInvalidation);
});
afterEach(() => {
    unsubscribeCollection();
    unsubscribeSettings();
    retirePluginAccountCollectionWatchScope(resolveAccountSettingsScopeKeyForToken('token'));
    clearActiveAccountSettingsSnapshot();
    vi.mocked(globalThis.fetch).mockRestore();
    vi.useRealTimers();
});


describe('ApiMachineClient /v2/changes reconnect', () => {

    async function withRealCheckpoint(run: (storage: typeof persistence) => Promise<void>) {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-cursor-coalesce-'));
        const original = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile };
        Object.assign(configuration, { happyHomeDir: homeDir, settingsFile: join(homeDir, 'settings.json') });
        const storage = await vi.importActual<typeof persistence>('@/persistence');
        readAccountChangesCursor.mockImplementation(storage.readAccountChangesCursor);
        writeAccountChangesCursor.mockImplementation(storage.writeAccountChangesCursor);
        try {
            await storage.updateSettings(settings => ({ ...settings, chromeMode: true }));
            await storage.writeAccountChangesCursor('coalesce-account', 10);
            checkpointIo.publications.length = 0;
            await run(storage);
        } finally {
            checkpointIo.refuseCheckpoint = false;
            Object.assign(configuration, original);
            await rm(homeDir, { recursive: true, force: true });
        }
    }

    it.each(['complete', 'failed-tail', 'cancelled-tail', 'cursor-gone'] as const)(
        'publishes one real checkpoint at catch-up exit with the last materialized page (%s)', async mode => {
            await withRealCheckpoint(async storage => {
                const machine: Machine = { id: 'coalesce-machine', encryptionMode: 'plain', metadata: null,
                    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
                const controller = new AbortController();
                const requested: number[] = [];
                const persistedWhilePaging: number[] = [];
                let idle = true;
                mockAccountGet(async (url, options) => {
                    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'coalesce-account' } };
                    if (url.includes('/v1/machines/')) return { status: 200, data: { machine } };
                    if (url.includes('/v2/changes')) {
                        const after = Number((options?.params as { after: number }).after);
                        requested.push(after);
                        persistedWhilePaging.push(await storage.readAccountChangesCursor('coalesce-account'));
                        if (idle) return { status: 200, data: { changes: [], nextCursor: after } };
                        if (after === 1010 && mode === 'cursor-gone') {
                            return { status: 410, data: { error: 'cursor-gone', currentCursor: 8 } };
                        }
                        const changes = Array.from({ length: after < 1010 ? 200 : 1 }, (_, index) => ({
                            cursor: after + index + 1, kind: 'session', entityId: `coalesce-${after + index + 1}`, changedAt: 1,
                        }));
                        return { status: 200, data: { changes, nextCursor: changes.at(-1)!.cursor } };
                    }
                    throw new Error(`Unexpected coalesce route: ${new URL(url).pathname}`);
                });
                const socket = createMachineSocket();
                bindApiSessionSocketMock(mockIo, socket);
                admitAccountSnapshot(admitAccountSnapshot.name);
                const client = new ApiMachineClient(admitAccountSnapshot.name, machine);
                client.onConnectedServicesProjection(async () => {});
                client.onSessionChanged(async change => {
                    if (change.cursor !== 1011) return;
                    if (mode === 'failed-tail') throw new Error('tail materialization failed');
                    if (mode === 'cancelled-tail') controller.abort();
                });
                const retryOwner = (client as unknown as {
                    connectedServicesProjectionRetry: { waitForIdle(): Promise<void> };
                }).connectedServicesProjectionRetry;
                const sync = () => (client as unknown as {
                    syncChangesOnConnect(options: { reason: 'live' }, signal: AbortSignal): Promise<void>;
                }).syncChangesOnConnect({ reason: 'live' }, controller.signal);
                try {
                    if (mode === 'complete') {
                        // Exercise the real socket registration and catch-up scheduler.
                        client.connect();
                        await vi.waitFor(() => expect(requested).toHaveLength(1));
                        await retryOwner.waitForIdle();
                        expect(checkpointIo.publications).toEqual([]);
                        requested.length = 0;
                        persistedWhilePaging.length = 0;
                    }
                    idle = false;
                    if (mode === 'complete') {
                        socket.trigger('update', { id: 'coalesce-wake', seq: 1011, createdAt: 1, body: { t: 'account-change' } });
                        await vi.waitFor(() => expect(requested).toHaveLength(6));
                        await retryOwner.waitForIdle();
                    } else if (mode === 'failed-tail') {
                        await expect(sync()).rejects.toThrow('tail materialization failed');
                    } else if (mode === 'cancelled-tail') {
                        await expect(sync()).rejects.toThrow();
                    } else {
                        await sync();
                    }
                    expect(checkpointIo.publications.filter(path => path.endsWith('changes-cursors.json'))).toHaveLength(1);
                    expect(checkpointIo.publications.filter(path => path.endsWith('settings.json'))).toHaveLength(0);
                    expect(requested).toEqual([10, 210, 410, 610, 810, 1010]);
                    expect(persistedWhilePaging).toEqual([10, 10, 10, 10, 10, 10]);
                    expect(await storage.readAccountChangesCursor('coalesce-account')).toBe(
                        mode === 'complete' ? 1011 : mode === 'cursor-gone' ? 8 : 1010,
                    );
                    if (mode === 'complete') {
                        idle = true;
                        checkpointIo.publications.length = 0;
                        await sync();
                        expect(checkpointIo.publications).toEqual([]);
                    }
                } finally { await client.shutdown(); }
            });
        },
    );

    it('replays uncheckpointed materialization idempotently from disk after an interrupted publication', async () => {
        await withRealCheckpoint(async storage => {
            const machine: Machine = { id: 'replay-machine', encryptionMode: 'plain', metadata: null,
                metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
            const requested: number[] = [];
            const materialized = new Set<string>();
            let deliveries = 0;
            let interrupted = true;
            mockAccountGet(async (url, options) => {
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'coalesce-account' } };
                if (url.includes('/v2/changes')) {
                    const after = Number((options?.params as { after: number }).after);
                    requested.push(after);
                    if (after === 210 && interrupted) {
                        // The process has consumed a page, but its only durable
                        // restart position must still be the previous operation.
                        expect(await storage.readAccountChangesCursor('coalesce-account')).toBe(10);
                        checkpointIo.refuseCheckpoint = true;
                        throw new Error('connection interrupted mid-catch-up');
                    }
                    const changes = after === 10 ? Array.from({ length: 200 }, (_, index) => ({
                        cursor: index + 11, kind: 'session', entityId: `replayed-${index}`, changedAt: 1,
                    })) : [];
                    return { status: 200, data: { changes, nextCursor: after === 10 ? 210 : after } };
                }
                throw new Error(`Unexpected replay route: ${new URL(url).pathname}`);
            });
            const start = () => {
                const client = new ApiMachineClient(admitAccountSnapshot.name, machine);
                client.onSessionChanged(async change => { deliveries += 1; materialized.add(change.sessionId); });
                return client;
            };
            const sync = (client: ApiMachineClient) => (client as unknown as {
                syncChangesOnConnect(options: { reason: 'live' }): Promise<void>;
            }).syncChangesOnConnect({ reason: 'live' });
            admitAccountSnapshot(admitAccountSnapshot.name);
            const first = start();
            try {
                await expect(sync(first)).rejects.toThrow();
                expect(await storage.readAccountChangesCursor('coalesce-account')).toBe(10);
                expect(materialized.size).toBe(200);
            } finally { await first.shutdown(); checkpointIo.refuseCheckpoint = false; }
            interrupted = false;
            requested.length = 0;
            const restarted = start();
            try {
                await sync(restarted);
                expect(requested).toEqual([10, 210]);
                expect(deliveries).toBe(400);
                expect(materialized.size).toBe(200);
                expect(await storage.readAccountChangesCursor('coalesce-account')).toBe(210);
                expect(checkpointIo.publications.filter(path => path.endsWith('changes-cursors.json'))).toHaveLength(1);
                expect(checkpointIo.publications.filter(path => path.endsWith('settings.json'))).toHaveLength(0);
            } finally { await restarted.shutdown(); }
        });
    });

    it('consumes Account wake cursor demand once, including hints covered while a real feed read is pending', async () => {
        const machine: Machine = { id: 'cursor-demand-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        let acknowledged = 10;
        let feedCursor = 10;
        let rebased = false;
        let rebaseCursor = 8;
        let failProjection = false;
        let reads = 0;
        let held: ReturnType<typeof createDeferred<void>> | undefined;
        readAccountChangesCursor.mockImplementation(async () => acknowledged);
        writeAccountChangesCursor.mockImplementation(async (_accountId, cursor) => { acknowledged = cursor; });
        mockAccountGet(async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'cursor-demand-account' } };
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine } };
            if (url.includes('/v2/changes')) {
                reads += 1;
                await held?.promise;
                if (rebased) return { status: 410, data: { error: 'cursor-gone', currentCursor: rebaseCursor } };
                return { status: 200, data: { changes: [], nextCursor: reads === 3 ? 52 : feedCursor } };
            }
            throw new Error(`Unexpected cursor demand read: ${new URL(url).pathname}`);
        });
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {
            if (failProjection) { failProjection = false; throw new Error('held rebase projection failed'); }
        });
        const retryOwner = (client as unknown as { connectedServicesProjectionRetry: { waitForIdle(): Promise<void> } }).connectedServicesProjectionRetry;
        const wake = (cursor: number) => socket.trigger('update', { id: `cursor-wake-${cursor}`, seq: cursor, createdAt: 1,
            body: { t: 'account-change' } });
        try {
            client.connect();
            await vi.waitFor(() => expect(reads).toBe(1));
            await retryOwner.waitForIdle();
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            reads = 0;
            for (let index = 0; index < 50; index += 1) wake(10);
            await retryOwner.waitForIdle();
            expect(reads).toBe(0);

            held = createDeferred<void>();
            wake(11);
            await vi.waitFor(() => expect(reads).toBe(1));
            for (let cursor = 12; cursor <= 50; cursor += 1) wake(cursor);
            feedCursor = 50;
            held.resolve();
            await retryOwner.waitForIdle();
            expect(acknowledged).toBe(50);
            expect(reads).toBe(1);

            held = createDeferred<void>();
            wake(51);
            await vi.waitFor(() => expect(reads).toBe(2));
            // Unlike the preceding covered hints, this newer wake must survive
            // an older in-flight page and cause the existing successor drain.
            wake(52);
            feedCursor = 51;
            held.resolve();
            await vi.waitFor(() => expect(reads).toBe(3));
            await retryOwner.waitForIdle();
            expect(reads).toBe(3);
            expect(acknowledged).toBe(52);

            // A smaller wake can signal a restored/rebased cursor domain,
            // not just an old duplicate. It must reach cursor-gone recovery.
            rebased = true;
            wake(8);
            await retryOwner.waitForIdle();
            expect(reads).toBe(4);
            expect(acknowledged).toBe(8);
            rebased = false;
            feedCursor = 8;
            socket.trigger('update', { id: 'legacy-connected-services', seq: 8, createdAt: 1,
                body: { t: 'update-account', connectedServices: [] } });
            await retryOwner.waitForIdle();
            expect(reads).toBe(5);

            // A failed rebase must not be replaced by an equal old-domain
            // hint: only a successful recovery can acknowledge the new cursor.
            held = createDeferred<void>();
            rebased = true;
            rebaseCursor = 7;
            failProjection = true;
            wake(7);
            await vi.waitFor(() => expect(reads).toBe(6));
            wake(8);
            held.resolve();
            await retryOwner.waitForIdle();
            expect(reads).toBe(7);
            expect(acknowledged).toBe(7);

            // The same recovery demand also survives a replacement that
            // arrives after failure, during the incumbent retry backoff.
            rebaseCursor = 6;
            failProjection = true;
            wake(6);
            await vi.waitFor(() => expect(reads).toBe(8));
            wake(7);
            await retryOwner.waitForIdle();
            expect(reads).toBe(9);
            expect(acknowledged).toBe(6);
        } finally { held?.resolve(); await client.shutdown(); }
    });

    it('wakes managed policy for exact Pending and Run controller targets, ignoring raw domain traffic', async () => {
        const machine: Machine = { id: 'accepted-policy-controller', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        mockAccountGet(async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'accepted-policy-account' } };
            if (url.includes('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: 1 } };
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine } };
            throw new Error(`Unexpected accepted policy boundary: ${new URL(url).pathname}`);
        });
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const notified = vi.fn();
        client.onManagedMachinePolicyInvalidated(notified);
        const target = ManagedWakeTargetV1Schema.parse({ homeId: 'home', managedId: 'managed', enrolledMachineId: 'guest',
            expectedIntentRevision: 1, controller: { machineId: machine.id, installationId: 'installation' }, reason: 'admitted-work',
            origin: { kind: 'session-input', session: { homeId: 'home', sessionId: 'session' }, pendingRequestId: 'pending', requestedAt: 1 } });
        const update = async (body: unknown) => {
            socket.trigger('update', { id: 'accepted-work', seq: 1, createdAt: 1, body: UpdateBodySchema.parse(body) });
            await new Promise<void>(resolve => setImmediate(resolve));
        };
        try {
            client.connect();
            await vi.waitFor(() => expect(writeAccountChangesCursor).toHaveBeenCalledWith('accepted-policy-account', 1));
            notified.mockClear();
            for (const body of [
                { t: 'pending-changed', sid: 'session', pendingVersion: 1, pendingCount: 1 },
                { t: 'automation-run-updated', runId: 'run', automationId: null, state: 'queued', scheduledAt: 1, updatedAt: 1 },
            ]) {
                await update(body);
                expect(notified).not.toHaveBeenCalled();
                await update({ ...body, managedWakeTargetV1: { ...target, controller: { ...target.controller, machineId: 'another-controller' } } });
                expect(notified).not.toHaveBeenCalled();
                await update({ ...body, managedWakeTargetV1: target });
                expect(notified).toHaveBeenCalledTimes(1);
                notified.mockClear();
            }
        } finally { await client.shutdown(); }
    });
    it('classifies targeted Machine invalidations and controller policy or completeness wakes', async () => {
        const machine: Machine = { id: 'policy-controller', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        let changes: ChangeEntry[] = [];
        let cursorGone = false;
        let paged = false;
        let policyTail = false;
        mockAccountGet(async (url, options) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'policy-account' } };
            if (url.includes('/v2/changes')) {
                if (cursorGone) return { status: 410, data: { error: 'cursor-gone', currentCursor: 2 } };
                const after = options?.params && typeof options.params === 'object' && 'after' in options.params
                    ? Number(options.params.after) : 0;
                const page = !paged ? changes : after === 0
                    ? Array.from({ length: 200 }, (_, index) => ({ cursor: index + 1, kind: 'account',
                        entityId: `unrelated-${index}`, changedAt: 1, hint: null }))
                    : policyTail ? [{ ...entry, cursor: 201 }] : [];
                return { status: 200, data: { changes: page, nextCursor: paged ? page.at(-1)?.cursor ?? after : 1 } };
            }
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine } };
            throw new Error(`Unexpected policy boundary: ${new URL(url).pathname}`);
        });
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const notifications: (ManagedMachinePolicyInvalidation | undefined)[] = [];
        const detach = client.onManagedMachinePolicyInvalidated(change => { notifications.push(change); });
        const sync = (reason: 'live' | 'reconnect' = 'live') => (
            client as unknown as { syncChangesOnConnect(options: { reason: 'live' | 'reconnect' }): Promise<void> }
        ).syncChangesOnConnect({ reason });
        const entry: ChangeEntry = { cursor: 1, kind: 'account', entityId: 'managed-row', changedAt: 1,
            hint: { managedMachinePolicy: true, machineId: machine.id } };
        try {
            changes = [{ ...entry, hint: null },
                { ...entry, hint: { managedMachinePolicy: true, machineId: 'another-controller' } },
                { ...entry, hint: { managedMachinePolicy: true, machineId: machine.id, unexpected: true } }];
            await sync();
            expect(notifications).toEqual([]);
            // The policy runtime owns its enrolled-Machine set. The feed
            // supplies exact Machine ids rather than an unscoped policy wake.
            changes = [{ ...entry, kind: 'machine', entityId: 'another-controller' }];
            await sync();
            expect(notifications).toEqual([{ kind: 'machines', machineIds: ['another-controller'] }]);
            notifications.length = 0;
            changes = [entry];
            await sync();
            expect(notifications).toEqual([undefined]);
            changes = [{ ...entry, kind: 'machine', entityId: machine.id, hint: null }];
            await sync();
            expect(notifications).toEqual([undefined, { kind: 'currentness' }]);
            changes = [];
            await sync('reconnect');
            expect(notifications).toHaveLength(3);
            cursorGone = true;
            await sync();
            expect(notifications).toHaveLength(4);
            cursorGone = false;
            paged = true;
            await sync();
            expect(notifications).toHaveLength(4);
            policyTail = true;
            await sync();
            expect(notifications).toHaveLength(5);
            detach();
            await sync();
            expect(notifications).toHaveLength(5);
        } finally {
            detach();
            await client.shutdown();
        }
    });
    it('wakes the webhook worker only for its durable domains or completeness recovery', async () => {
        const machine: Machine = { id: 'webhook-observer-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        let changes: ChangeEntry[] = [];
        let cursorGone = false;
        let cursor = 1;
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'webhook-observer-account' } };
            if (url.includes('/v2/changes')) return cursorGone
                ? { status: 410, data: { error: 'cursor-gone', currentCursor: cursor } }
                : { status: 200, data: { changes, nextCursor: cursor } };
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine } };
            throw new Error(`Unexpected webhook observer boundary: ${new URL(url).pathname}`);
        });
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const sourcesInvalidated = vi.fn();
        client.onAutomationEventSourcesInvalidated(sourcesInvalidated);
        // Observe the wake output; HTTP parsing, Account catch-up and attachment stay real.
        const events: string[] = [];
        const detach = attachPluginWebhookDaemonWakeV1({ apiMachine: client,
            getWorker: () => ({ trigger: () => { events.push('wake'); } }) });
        writeAccountChangesCursor.mockImplementation(async () => { events.push('cursor'); });
        const sync = (reason: 'live' | 'reconnect' = 'live') => (
            client as unknown as { syncChangesOnConnect(options: { reason: 'live' | 'reconnect' }): Promise<void> }
        ).syncChangesOnConnect({ reason });
        try {
            client.connect();
            await vi.waitFor(() => expect(writeAccountChangesCursor).toHaveBeenCalledWith('webhook-observer-account', cursor));
            await new Promise<void>(resolve => setImmediate(resolve));
            events.length = 0;
            sourcesInvalidated.mockClear();
            cursor++;
            changes = [{ cursor, kind: 'machine', entityId: 'another-machine', changedAt: 1 }];
            socket.trigger('update', { id: 'unrelated-account-wake', seq: cursor, createdAt: 1,
                body: { t: 'account-change' } });
            await vi.waitFor(() => expect(events).toContain('cursor'));
            expect(events).toEqual(['cursor']);
            expect(sourcesInvalidated).not.toHaveBeenCalled();
            events.length = 0;
            cursor++;
            changes = [{ cursor, kind: 'pluginDomain', entityId: 'pluginDomain/example.tasks/webhook', changedAt: 1,
                hint: { pluginDomain: 'webhook', pluginId: 'example.tasks' } }];
            await sync();
            expect(events).toEqual(['wake', 'cursor']);
            expect(sourcesInvalidated).toHaveBeenCalledTimes(1);
            events.length = 0;
            cursor++;
            changes = [{ cursor, kind: 'pluginDomain', entityId: 'pluginDomain/example.tasks/availability', changedAt: 1,
                hint: { pluginDomain: 'availability', pluginId: 'example.tasks' } }];
            await sync();
            expect(events).toEqual(['wake', 'cursor']);
            events.length = 0;
            changes = [];
            await sync('reconnect');
            expect(events).toEqual(['wake', 'cursor']);
            events.length = 0;
            cursorGone = true;
            await sync();
            expect(events).toEqual(['wake', 'cursor']);
            events.length = 0;
            detach();
            await sync();
            expect(events).toEqual(['cursor']);
        } finally {
            detach();
            await client.shutdown();
        }
    });

    it.each(['single', 'paged', 'failed-tail', 'mixed', 'mixed-catalog', 'mixed-team'] as const)('delivers exact quota Refresh before acknowledging the Account cursor (%s)', async mode => {
        const machine: Machine = { id: 'quota-observer-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const recordId = buildProviderAccountUsageRecordId({ providerId: 'quota-provider', accountSubjectId: 'work',
            subjectKind: 'account', quotaScope: 'account' });
        const { buildProviderAccountUsageRefreshChangeV1 } = await import('@happier-dev/protocol/changes');
        const changes: ChangeEntry[] = [{ cursor: mode === 'single' ? 1 : 201, changedAt: 1,
            ...buildProviderAccountUsageRefreshChangeV1(recordId) }];
        if (mode === 'mixed') changes.push({ cursor: 202, changedAt: 1, kind: 'account', entityId: 'self',
            hint: { connectedServices: true } });
        if (mode === 'mixed-catalog') {
            const { buildConnectedAccountCatalogPhysicalKeyV1 } = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
            changes.push({ cursor: 202, changedAt: 1, kind: 'account', entityId: buildConnectedAccountCatalogPhysicalKeyV1('purposes') });
        }
        if (mode === 'mixed-team') changes.push({ cursor: 202, changedAt: 1, kind: 'account', entityId: 'teams', hint: null });
        const mixed = mode === 'mixed' || mode === 'mixed-catalog';
        let savedCursor = 0;
        let refuseTail = mode === 'failed-tail';
        readAccountChangesCursor.mockImplementation(async () => savedCursor);
        mockAccountGet(async (url: string, options) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'quota-observer-account' } };
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine } };
            if (url.includes('/v2/changes')) {
                const after = options?.params && typeof options.params === 'object' && 'after' in options.params
                    ? Number(options.params.after) : 0;
                const page = mode !== 'single' && after === 0
                    ? Array.from({ length: 200 }, (_, index) => ({ cursor: index + 1, kind: 'machine',
                        entityId: `unrelated-${index}`, changedAt: 1 })) : changes;
                return { status: 200, data: { changes: page, nextCursor: page.at(-1)!.cursor } };
            }
            throw new Error(`Unexpected quota observer boundary: ${new URL(url).pathname}`);
        });
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        const client = new ApiMachineClient('token', machine);
        const events: unknown[] = [];
        const directMaterialWakes: unknown[] = [];
        client.onManagedProviderRetainedCurrentnessInvalidation(change => { directMaterialWakes.push(change); });
        const detach = client.onConnectedServicesProjection(async notification => {
            if (!notification.quotaRefreshRecordIds) return;
            if (refuseTail) throw new Error('quota-refresh-consumer-unavailable');
            events.push({ recordIds: notification.quotaRefreshRecordIds,
                quotaRefreshOnly: 'quotaRefreshOnly' in notification && notification.quotaRefreshOnly });
        });
        writeAccountChangesCursor.mockImplementation(async (_accountId, cursor) => { savedCursor = cursor; events.push('cursor'); });
        try {
            const sync = () => (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> })
                .syncChangesOnConnect({ reason: 'live' });
            if (refuseTail) {
                await expect(sync()).rejects.toThrow('quota-refresh-consumer-unavailable');
                expect(savedCursor).toBe(200);
                refuseTail = false;
                events.length = 0;
            }
            await sync();
            const refresh = { recordIds: [recordId], quotaRefreshOnly: !mixed };
            // Quota-only scopes the Connected Services projection. A Team
            // change on the same page still wakes direct-material admission.
            expect(events).toEqual([refresh, 'cursor']);
            expect(directMaterialWakes).toEqual(mixed || mode === 'mixed-team' ? [{ source: 'changes',
                signal: expect.any(AbortSignal), facts: expect.arrayContaining([mode === 'mixed' ? 'connected-services'
                    : mode === 'mixed-catalog' ? 'connected-catalog' : 'teams']) }] : []);
            expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/profile')))
                // The first catch-up authenticates the opaque token's Account;
                // only a mixed credential change needs a projection read too.
                .toHaveLength(mixed ? 2 : 1);
            expect(savedCursor).toBe(mode === 'single' ? 1 : mixed || mode === 'mixed-team' ? 202 : 201);
        } finally { detach(); await client.shutdown(); }
    });

    it.each(['stalled', 'cancelled'] as const)('does not continue a %s Account catch-up', async mode => {
        const machine: Machine = { id: 'page-observer-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const controller = new AbortController();
        const requestedCursors: number[] = [];
        readAccountChangesCursor.mockResolvedValue(200);
        mockAccountGet(async (url, options) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'page-observer-account' } };
            if (url.includes('/v2/changes')) {
                const after = options?.params && typeof options.params === 'object' && 'after' in options.params
                    ? Number(options.params.after) : 0;
                requestedCursors.push(after);
                if (mode === 'cancelled' && after === 400) controller.abort();
                return { status: 200, data: { changes: Array.from({ length: 200 }, (_, index) => ({
                    cursor: index + 201, kind: 'machine', entityId: `unrelated-${index}`, changedAt: 1,
                })), nextCursor: mode === 'stalled' ? 200 : 400 } };
            }
            throw new Error(`Unexpected page observer boundary: ${new URL(url).pathname}`);
        });
        const client = new ApiMachineClient('token', machine);
        try {
            await expect((client as unknown as {
                syncChangesOnConnect(options: { reason: 'live' }, signal: AbortSignal): Promise<void>;
            }).syncChangesOnConnect({ reason: 'live' }, controller.signal)).rejects.toThrow(
                mode === 'stalled' ? 'account_changes_cursor_not_advanced' : undefined,
            );
            expect(requestedCursors).toEqual(mode === 'stalled' ? [200] : [200, 400]);
            if (mode === 'stalled') expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            else expect(writeAccountChangesCursor).toHaveBeenCalledExactlyOnceWith('page-observer-account', 400);
        } finally { await client.shutdown(); }
    });

    it('invalidates Automation source observers from durable changes and completeness recovery', async () => {
        const machine: Machine = { id: 'source-observer-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        let changes: Array<{ cursor: number; kind: 'automation' | 'account'; entityId: string; changedAt: number; hint: null }> = [];
        let cursorGone = false;
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'source-observer-account' } };
            if (url.includes('/v2/changes')) return cursorGone
                ? { status: 410, data: { error: 'cursor-gone', currentCursor: 2 } }
                : { status: 200, data: { changes, nextCursor: 1 } };
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine: {
                id: machine.id, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            } } };
            throw new Error(`Unexpected source observer request: ${new URL(url).pathname}`);
        });
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const notified = vi.fn();
        client.onAutomationEventSourcesInvalidated(notified);
        const sync = (reason: 'live' | 'reconnect') => (
            client as unknown as { syncChangesOnConnect(options: { reason: 'live' | 'reconnect' }): Promise<void> }
        ).syncChangesOnConnect({ reason });
        await sync('live');
        expect(notified).not.toHaveBeenCalled();
        changes = [{ cursor: 1, kind: 'automation', entityId: 'automation-source-status', changedAt: 1, hint: null }];
        await sync('live');
        expect(notified).not.toHaveBeenCalled();
        changes = [{ cursor: 1, kind: 'automation', entityId: 'automation-a', changedAt: 1, hint: null }];
        await sync('live');
        expect(notified).toHaveBeenCalledTimes(1);
        changes = [];
        await sync('reconnect');
        expect(notified).toHaveBeenCalledTimes(2);
        cursorGone = true;
        await sync('live');
        expect(notified).toHaveBeenCalledTimes(3);
    });

    it('publishes observer currentness only after a supported changes read on the live transport', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        delete process.env.HAPPY_ENABLE_V2_CHANGES;
        const machine: Machine = { id: 'observer-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'observer-account' } };
            if (url.includes('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: 1 } };
            throw new Error(`Unexpected observer transport request: ${new URL(url).pathname}`);
        });
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        try {
            expect(client.hasCurrentAccountChangesObserver()).toBe(false);
            client.connect();
            await vi.waitFor(() => expect(client.hasCurrentAccountChangesObserver()).toBe(true));
            socket.connected = false;
            expect(client.hasCurrentAccountChangesObserver()).toBe(false);
            socket.connected = true;
            process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
            await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> })
                .syncChangesOnConnect({ reason: 'live' });
            expect(client.hasCurrentAccountChangesObserver()).toBe(false);
        } finally {
            await client.shutdown();
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('drains unrelated full pages without catalog or Settings resets and consumes the exact relevant tail hint', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const credentials = { token: 'provider-row-change-token', encryption: null };
        const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } });
        let relevantTail = false;
        let catalogReads = 0;
        mockAccountGet(async (url: string, options) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'provider-row-account' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/entity-rows/provider-connections') {
                catalogReads++;
                return { status: 200, data: { status: 'deleted', revision: 2 } };
            }
            if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
            if (historyResponse) return historyResponse;
            if (path.startsWith('/v1/machines/')) return { status: 200, data: { machine } };
            if (path === '/v2/changes') {
                const after = options?.params && typeof options.params === 'object' && 'after' in options.params
                    ? Number(options.params.after) : 0;
                const changes = after === 0 ? Array.from({ length: 200 }, (_, index) => ({ cursor: index + 1,
                    kind: 'machine', entityId: `unrelated-${index}`, changedAt: 1, hint: null }))
                    : relevantTail ? [{ cursor: 201, kind: 'account', entityId: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
                        changedAt: 1, hint: { providerConnections: true, revision: 2 } }] : [];
                return { status: 200, data: { changes, nextCursor: changes.at(-1)?.cursor ?? after } };
            }
            throw new Error(`Unexpected Provider observer boundary: ${path}`);
        });
        const machine: Machine = { id: 'provider-row-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const client = new ApiMachineClient(credentials.token, machine);
        const settingsHint = vi.fn();
        client.onAccountSettingsVersionHint(settingsHint);
        const projections = vi.fn();
        client.onConnectedServicesProjection(projections);
        const projectRows = vi.fn();
        client.onAccountProjectRowsChanged(projectRows);
        const retainedCatalogRevisions: (number | 'absent' | undefined)[] = [];
        client.onManagedProviderRetainedCurrentnessInvalidation(async () => {
            const catalog = getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog;
            retainedCatalogRevisions.push(catalog?.status === 'ready' ? catalog.revision : undefined);
        });
        try {
            await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> }).syncChangesOnConnect({ reason: 'live' });
            expect(catalogReads).toBe(0);
            expect(settingsHint).not.toHaveBeenCalled();
            expect(projectRows).not.toHaveBeenCalled();
            expect(projections).not.toHaveBeenCalled();
            expect(retainedCatalogRevisions).toEqual([]);
            expect(publishPluginAccountSettingsWatchInvalidation).not.toHaveBeenCalled();
            expect(publishPluginAccountCollectionWatchInvalidation).not.toHaveBeenCalled();
            relevantTail = true;
            await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> }).syncChangesOnConnect({ reason: 'live' });
            expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision: 2 });
            expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
            expect(settingsHint).not.toHaveBeenCalled();
            // Revision-only replacement of an empty ready catalog consumes
            // the same credential facts, so retained material remains current.
            expect(retainedCatalogRevisions).toEqual([]);
        } finally {
            await client.shutdown(); stored.mockRestore(); clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
        }
    });
        async function createMaterialChangeHarness(accountId: string, token: string,
            registerRoutes?: (app: ReturnType<typeof createAuthenticatedTestApp>) => void) {
            const app = createAuthenticatedTestApp();
            changesRoutes(app);
            registerProviderConnectionsRoutes(app);
            registerSavedSecretResourceRoutes(app);
            registerAccountSettingsRoutes(app);
            registerRoutes?.(app);
            await app.ready();
            const machine: Machine = { id: 'material-cost-machine', encryptionMode: 'plain', metadata: null,
                metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
            let acknowledged = 0;
            readAccountChangesCursor.mockImplementation(async () => acknowledged);
            writeAccountChangesCursor.mockImplementation(async (_accountId, cursor) => { acknowledged = cursor; });
            const reads = { providerRows: 0, settings: 0, savedSecrets: 0 };
            const changePages: { after: number; entries: ChangeEntry[] }[] = [];
            const headers = { 'x-test-user-id': accountId, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() };
            axiosGet.mockImplementation(async (url: string, options?: { params?: Record<string, unknown>; validateStatus?: (status: number) => boolean }) => {
                const request = new URL(url);
                const path = request.pathname;
                if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
                if (path === '/v1/auth/ping') return { status: 200, data: {} };
                if (path.startsWith('/v1/machines/')) return { status: 200, data: { machine } };
                if (path === '/v1/account/encryption/currentness') {
                    const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
                    return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: account.settingsVersion,
                        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                }
                if (path === '/v1/account/entity-rows/provider-connections') reads.providerRows++;
                if (path === '/v2/account/settings') reads.settings++;
                if (path === '/v1/account/saved-secrets/resources/materials') reads.savedSecrets++;
                for (const [key, value] of Object.entries(options?.params ?? {})) request.searchParams.set(key, String(value));
                const response = await app.inject({ method: 'GET', url: `${path}${request.search}`, headers });
                const data: unknown = response.json();
                if (path === '/v2/changes' && response.statusCode === 200) {
                    changePages.push({ after: Number(request.searchParams.get('after')),
                        entries: response.json<{ changes: ChangeEntry[] }>().changes });
                }
                if (!(options?.validateStatus?.(response.statusCode) ?? (response.statusCode >= 200 && response.statusCode < 300))) {
                    // Preserve Axios's real HTTP refusal shape, including the
                    // expected source-missing response after emergency revoke.
                    throw Object.assign(createHttpStatusError(response.statusCode, `Account HTTP boundary ${path}`), {
                        isAxiosError: true, response: { status: response.statusCode, data },
                    });
                }
                return { status: response.statusCode, data };
            });
            const socket = createMachineSocket();
            bindApiSessionSocketMock(mockIo, socket);
            // Replace only Socket.IO delivery. Publication, room selection,
            // payload construction, client registration and catch-up stay real.
            const wakes: unknown[] = [];
            eventRouter.setIo({ to: room => ({
                emit: (event, payload) => {
                    if (room !== getAccountStoredContentV3SocketRoom(accountId)) return;
                    wakes.push(payload);
                    socket.trigger(event, payload);
                },
                disconnectSockets: () => {},
            }) });
            const client = new ApiMachineClient(token, machine);
            const detachProjection = client.onConnectedServicesProjection(async () => {});
            const settle = async () => {
                const { seq } = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } });
                await vi.waitFor(() => expect(acknowledged).toBe(seq));
            };
            return { client, socket, reads, wakes, changePages, settle, app, headers, detachProjection, getCursor: () => acknowledged,
                start: async () => {
                    client.connect();
                    await vi.waitFor(() => expect(client.hasCurrentAccountChangesObserver()).toBe(true));
                    await settle();
                    reads.providerRows = reads.settings = reads.savedSecrets = 0;
                    wakes.length = 0;
                },
                close: async () => { eventRouter.clearIo(); await client.shutdown(); await app.close(); },
            };
        }

    describe('real Account-change material cost', () => {
        let database: Awaited<ReturnType<typeof createLightSqliteHarness>> | undefined;
        beforeAll(async () => {
            database = await createLightSqliteHarness({ tempDirPrefix: 'happier-material-cost-feed-',
                initAuth: false, initEncrypt: true, initFiles: false });
        });
        afterAll(async () => { await database?.close(); });

        it('materializes only consumed domains at scale, stays idle for 300 seconds, and never rereads acknowledged entries', async () => {
            const account = await db.account.create({ data: { id: 'domain-cost-account', encryptionMode: 'plain' } });
            const session = await db.session.create({ data: { accountId: account.id, tag: 'domain-cost',
                metadata: '{}', encryptionMode: 'plain' } });
            const discardedKinds = ['feed', 'friends', 'friend_request', 'friend_accepted', 'kv', 'pet', 'machinePool'];
            const irrelevantCount = 1_000;
            await db.accountChange.createMany({ data: Array.from({ length: irrelevantCount }, (_, index) => ({
                accountId: account.id, cursor: index + 1, kind: discardedKinds[index % discardedKinds.length]!,
                entityId: `irrelevant-${index}`,
            })) });
            await db.account.update({ where: { id: account.id }, data: { seq: irrelevantCount } });
            admitAccountSnapshot(admitAccountSnapshot.name);
            const harness = await createMaterialChangeHarness(account.id, admitAccountSnapshot.name);
            const delivered: number[] = [];
            const revisions: number[] = [];
            harness.client.onSessionChanged(async change => { delivered.push(change.cursor); });
            harness.client.onSessionTranscriptRevised(async change => { revisions.push(change.cursor); });
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            try {
                await harness.start();
                const initialEntries = harness.changePages.flatMap(page => page.entries);
                expect({ pages: harness.changePages.length, materialized: initialEntries.length,
                    discarded: initialEntries.filter(entry => discardedKinds.includes(entry.kind)).length })
                    .toEqual({ pages: 1, materialized: 0, discarded: 0 });

                harness.changePages.length = 0;
                await vi.advanceTimersByTimeAsync(300_000);
                expect(harness.changePages).toEqual([]);
                for (let index = 0; index < 50; index++) {
                    harness.socket.trigger('update', { id: `settled-domain-wake-${index}`, seq: irrelevantCount,
                        createdAt: 1, body: { t: 'account-change' } });
                }
                await vi.advanceTimersByTimeAsync(0);
                expect(harness.changePages).toEqual([]);

                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id }));
                await harness.settle();
                expect(harness.changePages).toMatchObject([{ after: irrelevantCount,
                    entries: [{ cursor: irrelevantCount + 1, kind: 'session', entityId: session.id }] }]);
                expect(delivered).toEqual([irrelevantCount + 1]);

                harness.changePages.length = 0;
                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'share', entityId: session.id,
                    hint: { updatedMessageSeq: 7, updatedMessageId: 'domain-revision' } }));
                await harness.settle();
                expect(harness.changePages).toMatchObject([{ after: irrelevantCount + 1,
                    entries: [{ cursor: irrelevantCount + 2, kind: 'share', entityId: session.id }] }]);
                expect(revisions).toEqual([irrelevantCount + 2]);

                harness.changePages.length = 0;
                // A genuine reconnect still has to establish currentness once;
                // the existing equal-cursor live wake contract covers zero reads.
                harness.socket.trigger('disconnect');
                harness.socket.trigger('connect');
                await vi.waitFor(() => expect(harness.changePages.length).toBeGreaterThan(0));
                await vi.waitFor(() => expect(harness.client.hasCurrentAccountChangesObserver()).toBe(true));
                expect(harness.changePages.flatMap(page => page.entries)).toEqual([]);
                expect(delivered).toEqual([irrelevantCount + 1]);
            } finally { await harness.close(); }
        });

    it('runs one direct-material pass when a Saved Secret change publishes its snapshot', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const account = await db.account.create({ data: { id: 'saved-secret-material-cost', encryptionMode: 'plain' } });
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('token'),
            savedSecretCatalogState: 'ready', savedSecretResources: [] });
        const harness = await createMaterialChangeHarness(account.id, 'token');
        const { client } = harness;
        const materialPasses = vi.fn();
        const unsubscribeSource = subscribeTeamCredentialDirectMaterialSourceChanges(materialPasses);
        const unsubscribeAccount = subscribeTeamCredentialDirectMaterialAccountChanges(client, materialPasses);
        const retained = vi.fn();
        client.onManagedProviderRetainedCurrentnessInvalidation(retained);
        try {
            await harness.start();
            materialPasses.mockClear();
            retained.mockClear();
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: account.id, resourceId: 'new-secret',
                displayName: 'New credential', kind: 'apiKey', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'New credential', kind: 'apiKey', value: 'fixture-value' } } })))
                .toMatchObject({ ok: true });
            await harness.settle();
            expect(harness.wakes).toEqual([expect.objectContaining({ body: { t: 'account-change',
                changeKinds: ['savedSecretResource'], entityIds: ['new-secret'] } })]);
            expect(getActiveAccountSettingsSnapshot()?.savedSecretResources).toEqual([expect.objectContaining({ resourceId: 'new-secret' })]);
            expect(harness.reads.savedSecrets).toBe(1);
            expect(materialPasses).toHaveBeenCalledTimes(1);
            expect(retained).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ facts: ['saved-secrets'] }));
        } finally {
            unsubscribeSource(); unsubscribeAccount(); await harness.close(); clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
        }
    });

    it('keeps unrelated settings and Provider preferences out of material refresh demand', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const credentials = { token: 'provider-settings-churn', encryption: null };
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/p' },
                role: 'default', displayName: 'A', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }] });
        const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        const account = await db.account.create({ data: { id: 'provider-settings-churn', encryptionMode: 'plain', settingsVersion: 1 } });
        const team = await db.team.create({ data: { name: 'Material currentness' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'owner' } });
        expect(await inTx(tx => mutateProviderConnectionsRowInTx(tx, { accountId: account.id, expectedRevision: 'absent',
            sourceSettingsVersion: 1, referencedSavedSecretIds: [], content: { t: 'plain', v: catalog } })))
            .toMatchObject({ status: 'updated', revision: 0 });
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            providerConnectionsCatalog: { status: 'ready', revision: 0, catalog } });
        let revision = 1;
        let kind: 'settings' | 'preference' | 'material' | 'read-key' | 'team-read-key' = 'settings';
        const harness = await createMaterialChangeHarness(account.id, credentials.token);
        const { client } = harness;
        client.onAccountSettingsVersionHint(async hint => {
            const snapshot = getActiveAccountSettingsSnapshot()!;
            setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: hint.settingsVersion ?? snapshot.settingsVersion,
                settings: accountSettingsParse({ unrelated: revision }), rawSettings: { unrelated: revision },
                ...(kind === 'read-key' || kind === 'team-read-key'
                    ? { settingsSecretsReadKeys: [new Uint8Array([kind === 'read-key' ? 9 : 10])] } : {}) });
        });
        const material = vi.fn(async () => {});
        client.onManagedProviderRetainedCurrentnessInvalidation(material);
        const materialPasses = vi.fn();
        const accountMaterialPasses = vi.fn();
        const unsubscribeSource = subscribeTeamCredentialDirectMaterialSourceChanges(materialPasses);
        const unsubscribeAccount = subscribeTeamCredentialDirectMaterialAccountChanges(client, accountMaterialPasses);
        let catalogRevision = 0;
        let settingsVersion = 1;
        const publish = async () => {
            if (kind === 'preference' || kind === 'material') {
                const result = await inTx(tx => mutateProviderConnectionsRowInTx(tx, { accountId: account.id,
                    expectedRevision: catalogRevision, referencedSavedSecretIds: [], content: { t: 'plain', v: {
                        ...catalog,
                        ...(kind === 'material' ? { connections: catalog.connections.map(connection => ({ ...connection, revision: 1 })) } : {}),
                        modelPickerVisibilityByConnectionId: { pc_a: revision % 2 === 0 },
                    } } }));
                expect(result).toMatchObject({ status: 'updated', revision: catalogRevision + 1 });
                catalogRevision++;
            } else {
                expect(await inTx(async tx => {
                    const result = await writeAccountSettingsInTx({ tx, accountId: account.id,
                        expectedVersion: settingsVersion, next: { kind: 'v2', content: { t: 'plain', v: { unrelated: revision } } } });
                    if (kind === 'team-read-key') await publishAccountTeamMembershipsChangedInTx(tx, {
                        accountId: account.id, additionalAccountIds: [account.id] });
                    return result;
                })).toMatchObject({ status: 'success' });
                settingsVersion++;
            }
            await harness.settle();
        };
        try {
            await harness.start();
            material.mockClear();
            materialPasses.mockClear();
            accountMaterialPasses.mockClear();
            for (let index = 0; index < 25; index++) { revision++; await publish(); }
            expect(harness.wakes).toHaveLength(25);
            expect(harness.reads).toEqual({ providerRows: 0, settings: 0, savedSecrets: 0 });
            expect(material).not.toHaveBeenCalled();
            expect(materialPasses).not.toHaveBeenCalled();
            expect(accountMaterialPasses).not.toHaveBeenCalled();
            kind = 'preference';
            for (let index = 0; index < 25; index++) { revision++; await publish(); }
            expect(harness.reads).toEqual({ providerRows: 25, settings: 0, savedSecrets: 0 });
            expect(material).not.toHaveBeenCalled();
            expect(materialPasses).not.toHaveBeenCalled();
            expect(accountMaterialPasses).not.toHaveBeenCalled();
            kind = 'material'; revision++; await publish();
            expect(material).toHaveBeenCalledTimes(1);
            expect(materialPasses).toHaveBeenCalledTimes(1);
            kind = 'read-key'; revision++; await publish();
            expect(harness.reads.providerRows).toBe(27);
            expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({
                status: 'ready', catalog: { connections: [{ id: 'pc_a', revision: 1 }] },
            });
            expect(accountMaterialPasses).not.toHaveBeenCalled();
            kind = 'team-read-key'; revision++; await publish();
            expect(accountMaterialPasses).toHaveBeenCalledTimes(1);
            expect(material).toHaveBeenLastCalledWith(expect.objectContaining({ facts: ['all', 'teams'] }));
        } finally {
            unsubscribeSource(); unsubscribeAccount();
            await harness.close(); stored.mockRestore(); clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
        }
    });
    });

    it('refreshes demanded prompt catalogs on content-free Account hints without advancing Settings', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'prompt-library-account' })).toString('base64url')}.signature`, encryption: null };
        const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: {} as never, rawSettings: {}, settingsVersion: 7,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });
        let revision = 1;
        mockAccountGet(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'prompt-library-account' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: {
                status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision, content: { t: 'plain', v: key === 'coding' ? { key: 'coding', value: {
                    v: 1, scope: { kind: 'coding' }, entries: [{ id: `entry-${revision}`, ref: { kind: 'doc', artifactId: `doc-${revision}` },
                        enabled: true, placement: 'system_append' }],
                } } : emptyPromptLibraryRecordV1(key) } })),
            } };
            if (path === '/v2/changes') return { status: 200, data: { changes: [{ cursor: 4, kind: 'account',
                entityId: buildPromptLibraryPhysicalKeyV1('coding'), changedAt: 1, hint: { promptLibrary: true, key: 'coding', revision } }], nextCursor: 4 } };
            throw new Error(`Unexpected prompt catalog observer boundary: ${path}`);
        });
        const machine: Machine = { id: 'prompt-library-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const client = new ApiMachineClient(credentials.token, machine);
        const settingsHint = vi.fn();
        client.onAccountSettingsVersionHint(settingsHint);
        try {
            await refreshActivePromptLibraryCatalog({ credentials });
            revision = 2;
            await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> }).syncChangesOnConnect({ reason: 'live' });
            const catalog = getActiveAccountSettingsSnapshot()?.promptLibraryCatalog ?? { status: 'loading' as const };
            expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'coding' })).toMatchObject({ status: 'ready', authority: 'active',
                revision: 2, record: { value: { entries: [{ id: 'entry-2' }] } } });
            expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
            expect(settingsHint).not.toHaveBeenCalled();
        } finally {
            await client.shutdown(); stored.mockRestore(); clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
        }
    });
    it('refreshes a demanded Profile row on its Account hint without any Settings revision advance', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const credentials = { token: 'profile-row-change-token', encryption: null };
        const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: {} as never, settingsVersion: 7,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });
        let revision = 1;
        const control = { status: 'present', revision: 1, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [],
        } } };
        mockAccountGet(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'profile-row-account' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision } };
            if (path.endsWith('/transfer')) return { status: 200, data: control };
            if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: {
                status: 'listed', rows: [{ id: 'focused', revision, content: { t: 'plain', v: ProfileRecordV1Schema.parse({
                    v: 1, id: 'focused', enabled: revision === 1, promptStack: [], secretBindings: {},
                    definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } },
                }) } }], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: revision, transferControl: control } };
            if (path === '/v2/changes') return { status: 200, data: { changes: [{ cursor: 4, kind: 'account',
                entityId: buildProfilePhysicalKey('focused'), changedAt: 1, hint: { profiles: true, id: 'focused', revision } }], nextCursor: 4 } };
            throw new Error(`Unexpected Profile observer boundary: ${path}`);
        });
        const machine: Machine = { id: 'profile-row-machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const client = new ApiMachineClient(credentials.token, machine);
        const settingsHint = vi.fn();
        client.onAccountSettingsVersionHint(settingsHint);
        try {
            await refreshActiveProfileCatalog({ credentials });
            revision = 2;
            await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> }).syncChangesOnConnect({ reason: 'live' });
            expect(getActiveAccountSettingsSnapshot()?.profileCatalog).toMatchObject({ status: 'ready',
                records: [{ revision: 2, record: { enabled: false } }] });
            expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
            expect(settingsHint).not.toHaveBeenCalled();
        } finally {
            await client.shutdown();
            stored.mockRestore();
            clearActiveAccountSettingsSnapshot();
            if (previous) setActiveAccountSettingsSnapshot(previous);
        }
    });
    it('loads keyless Project rows through daemon bootstrap, reads only live changed rows and releases its listener on retirement', async () => {
        const previousSettings = getActiveAccountSettingsSnapshot();
        clearActiveAccountSettingsSnapshot();
        const tempRoot = await mkdtemp(join(tmpdir(), 'project-row-daemon-'));
        const credentials = { token: 'project-row-daemon-token', encryption: null };
        const machine: Machine = { id: 'project-row-daemon-machine', encryptionMode: 'plain',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const key = { kind: 'workspace-ref' as const, serverId: configuration.activeServerId, id: 'project-row-daemon-ref' };
        const ref = { id: key.id, serverId: key.serverId, machineId: machine.id, rootPath: '/daemon-project', createdAtMs: 1 };
        const rows = [createPlainProjectAccountRefRow(ref, 2), ...Array.from({ length: 1024 }, (_, index) => {
            const key = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: `unrelated-${index}` };
            return { key, revision: 0, content: { t: 'plain' as const, v: { key, value: {} } } };
        })];
        const socket = createMachineSocket();
        socket.connect.mockImplementation(() => { socket.connected = true; return socket; });
        bindApiSessionSocketMock(mockIo, socket);
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'project-row-daemon-account' } };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
                mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
            if (url.includes('/v2/changes')) return { status: 200, data: { changes: [
                { cursor: 4, kind: 'account', entityId: buildProjectAccountRowPhysicalKeyV1(key), changedAt: 1, hint: { projectAccountRow: true, key, revision: 2 } },
            ], nextCursor: 4 } };
            if (url.includes('/v2/sessions')) return { status: 200, data: { sessions: [], nextCursor: null } };
            throw new Error(`unexpected url: ${url}`);
        });
        axiosPost.mockImplementation(async (url: string, body: unknown) => {
            if (url.includes('/v1/account/project-rows/')) return projectAccountRowsReadHttpResponse(rows, url, body);
            throw new Error(`unexpected url: ${url}`);
        });
        const client = new ApiMachineClient(credentials.token, machine);
        const bootstrap = await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test', machineId: machine.id, machine, credentials,
            deviceLocalSecretStorage: { sealJson: () => 'sealed', openJson: () => null, deriveOpaqueIdentity: () => 'a'.repeat(64) } as never,
            preferredHost: 'host.local', happyHomeDir: tempRoot, happyLibDir: tempRoot,
            filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
            createConnectedApiMachine: () => client, attachTransferRuntimeStatePublisher: async () => {},
            startAutomationWorkerForMachine: () => ({ liveWorkProducer: { read: () => ({ coverage: 'complete', items: [] }), subscribe: () => () => {} }, stop: () => {}, catchUp: async () => {}, refreshAssignments: async () => {}, pause: () => {}, resume: () => {}, handleServerUpdate: () => {} }),
            startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
            spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
            spawnSessionForInternalResume: async () => { throw new Error('Unexpected internal resume'); },
            stopSession: async () => ({ status: 'stopped' }),
            isSessionAlreadyRunning: async () => false, loadLocalSessionMetadataForHandoff: async () => null,
            beforeShutdown: async () => {}, requestShutdown: () => {}, directPeerServerLifecycle: null,
            directTransferRegistryHost: createCliRegistryHostV1(),
            connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null, daemonServerWorkScheduler: {} as never,
        });
        try {
            // Bootstrap's real Plain Account reader must admit before Profile migration;
            // no daemon-only content key or synthetic empty snapshot substitutes for it.
            await vi.waitFor(() => expect(getActiveAccountSettingsSnapshot()).toMatchObject({
                source: 'network', settingsVersion: 7, scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            }));
            const sync = () => (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> }).syncChangesOnConnect({ reason: 'live' });
            await sync();
            expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([ref]);
            axiosPost.mockClear();
            rows[0] = createPlainProjectAccountRefRow({ ...ref, rootPath: '/daemon-project-moved' }, 3);
            const publishedChanges: unknown[] = [];
            const stopObserving = subscribeActiveProjectAccountRowsSnapshot((_previous, next) => publishedChanges.push(next));
            try {
                await sync();
                expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([{ ...ref, rootPath: '/daemon-project-moved' }]);
                expect(publishedChanges).toHaveLength(1);
                expect(axiosPost.mock.calls.map(([url, body]) => [new URL(url).pathname, body])).toEqual([
                    ['/v1/account/project-rows/list', { kinds: ['workspace-ref', 'relationship-graph'] }],
                ]);
                await sync();
                expect(publishedChanges).toHaveLength(1);
            } finally { stopObserving(); }
            bootstrap.machineConnectionStateCleanup?.();
            const published = getActiveProjectAccountRowsSnapshot();
            axiosPost.mockClear();
            await sync();
            expect(getActiveProjectAccountRowsSnapshot()).toBe(published);
            expect(axiosPost).not.toHaveBeenCalled();
        } finally {
            bootstrap.machineConnectionStateCleanup?.();
            bootstrap.disposeInactiveSessionUsageLimitRecovery();
            bootstrap.automationWorker?.stop();
            await bootstrap.stopPeerMediationLoopbackServer();
            await client.shutdown();
            clearActiveAccountSettingsSnapshot();
            if (previousSettings) setActiveAccountSettingsSnapshot(previousSettings);
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('refetches Project rows for a row-only Account hint without refreshing Account settings', async () => {
        const credentials = { token: 'project-row-token', encryption: null };
        admitAccountSnapshot(credentials.token);
        const machine: Machine = {
            id: 'machine-1', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        };
        const key = { kind: 'workspace-ref' as const, serverId: configuration.activeServerId, id: 'project-row-ref' };
        const ref = { id: key.id, serverId: key.serverId, machineId: machine.id, rootPath: '/project-row', createdAtMs: 1 };
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'project-row-account' } };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.includes('/v2/changes')) return { status: 200, data: { changes: [
                { cursor: 4, kind: 'account', entityId: buildProjectAccountRowPhysicalKeyV1(key), changedAt: 1, hint: { projectAccountRow: true, key, revision: 2 } },
            ], nextCursor: 4 } };
            throw new Error(`unexpected url: ${url}`);
        });
        axiosPost.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/project-rows/list')) return { status: 200, data: {
                status: 'listed', coverage: 'complete', rows: [{ key, revision: 2, content: { t: 'plain', v: { key, value: ref } } }],
            } };
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient(credentials.token, machine);
        const settingsHint = vi.fn();
        client.onAccountSettingsVersionHint(settingsHint);
        client.onAccountProjectRowsChanged(async ({ signal, keys }) => {
            await readProjectAccountRows({ credentials, signal, publication: 'installed', changedKeys: keys });
        });

        await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> })
            .syncChangesOnConnect({ reason: 'live' });

        expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([ref]);
        expect(settingsHint).not.toHaveBeenCalled();
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('project-row-account', 4);
    });

    it('retains the Account cursor when Project-row delivery fails and replays it on retry', async () => {
        const credentials = { token: 'project-row-token', encryption: null };
        admitAccountSnapshot(credentials.token);
        const key = { kind: 'relationship-graph' as const };
        const machine: Machine = {
            id: 'machine-1', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'project-row-account' } };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.includes('/v2/changes')) return { status: 200, data: { changes: [
                { cursor: 4, kind: 'account', entityId: buildProjectAccountRowPhysicalKeyV1(key), changedAt: 1, hint: {
                    projectAccountRow: true, key, revision: 2,
                } },
            ], nextCursor: 4 } };
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient(credentials.token, machine);
        let unavailable = true;
        axiosPost.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/project-rows/list')) return { status: 200, data: unavailable
                ? { status: 'account-mode-mismatch' }
                : { status: 'listed', coverage: 'complete', rows: [] } };
            throw new Error(`unexpected url: ${url}`);
        });
        client.onAccountProjectRowsChanged(async ({ signal, keys }) => {
            await readProjectAccountRows({ credentials, signal, publication: 'installed', changedKeys: keys });
        });
        const sync = () => (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> })
            .syncChangesOnConnect({ reason: 'live' });

        await expect(sync()).rejects.toThrow('project_account_rows_account-mode-mismatch');
        expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        unavailable = false;
        await sync();
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('project-row-account', 4);
    });

    it.each(['reconnect', 'cursor-gone'] as const)('refreshes Project rows when changes completeness is lost: %s', async (recovery) => {
        admitAccountSnapshot('project-row-token');
        const machine: Machine = {
            id: 'machine-1', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'project-row-account' } };
            if (url.includes('/v2/changes')) {
                if (recovery === 'cursor-gone') return { status: 410, data: { error: 'cursor-gone', currentCursor: 9 } };
                return { status: 200, data: { changes: [], nextCursor: 9 } };
            }
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine: {
                id: machine.id, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            } } };
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('project-row-token', machine);
        client.onConnectedServicesProjection(async () => {});
        const notifications: string[] = [];
        client.onAccountProjectRowsChanged(async ({ source }) => { notifications.push(source); });
        await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' | 'reconnect' }): Promise<void> })
            .syncChangesOnConnect({ reason: recovery === 'reconnect' ? 'reconnect' : 'live' });
        expect(notifications).toEqual([recovery]);
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('project-row-account', 9);
    });

    it('hydrates private Saved Secrets once per durable change without an unused feature refresh', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        let changed = true;
        let cursor = 0;
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: changed ? [{
                            cursor: ++cursor,
                            kind: 'savedSecretResource',
                            entityId: 'resource-1',
                            changedAt: 1,
                            hint: null,
                        }] : [],
                        nextCursor: cursor,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json(
            FeaturesResponseSchema.parse({
                features: {
                    teams: {
                        enabled: false,
                        credentialResources: { enabled: true },
                    },
                },
                capabilities: {},
            }),
        ));
        // Compose the real daemon feature store's authenticated-ready hydration
        // with the real feed reader. Only Fetch/Axios are boundary substitutes.
        const features = createServerUrlServerFeaturesSnapshotStore({
            serverUrl: 'https://api.example.test', token: 'token',
            onAuthenticatedReady: async () => {
                await hydrateSavedSecretCatalog({ token: 'token' });
            },
        });
        const client = new ApiMachineClient('token', machine, undefined, {
            resolveServerFeaturesSnapshot: () => features.refresh(),
        });
        const sync = () => (client as unknown as {
            syncChangesOnConnect(options: { reason: 'live' }): Promise<void>;
        }).syncChangesOnConnect({ reason: 'live' });
        const resourceReads = () => axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/saved-secrets/resources/materials')).length;
        try {
            for (let change = 1; change <= 3; change += 1) {
                await sync();
                expect(resourceReads()).toBe(change);
                expect(writeAccountChangesCursor).toHaveBeenLastCalledWith('account-1', change);
            }
            changed = false;
            await sync();
            expect(resourceReads()).toBe(3);

            // Genuine authenticated-ready observations retain their own fresh
            // resource admission, even when the feature values are unchanged.
            await features.refresh();
            await features.refresh();
            expect(resourceReads()).toBe(5);
            expect(features.getSnapshot()).toMatchObject({ status: 'ready', provenance: 'authenticated' });
        } finally { await client.shutdown(); }
    });

    it('resolves an exact Session Resource admission without acknowledging the returned Account cursor', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string, options?: Readonly<{ params?: unknown }>) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }
            expect(options?.params).toEqual({
                after: 0,
                limit: 1,
                sessionAccessSessionId: 'session-1',
            });
            return {
                status: 200,
                data: {
                    changes: [],
                    nextCursor: 44,
                    sessionAccessProbe: {
                        v: 1,
                        sessionId: 'session-1',
                        throughCursor: 44,
                        status: 'available',
                    },
                },
            };
        });
        const client = new ApiMachineClient('token', machine);

        await expect(client.resolvePluginResourceSessionAccess({
            accountId: 'account-1',
            sessionId: 'session-1',
            signal: new AbortController().signal,
        })).resolves.toEqual({
            accountId: 'account-1',
            throughCursor: 44,
            status: 'available',
        });
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('fails only the exact Session Resource admission closed when an older server omits the probe', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => (
            url.endsWith('/v1/account/profile')
                ? { status: 200, data: { id: 'account-1' } }
                : { status: 200, data: { changes: [], nextCursor: 0 } }
        ));
        const client = new ApiMachineClient('token', machine);

        await expect(client.resolvePluginResourceSessionAccess({
            accountId: 'account-1',
            sessionId: 'session-1',
            signal: new AbortController().signal,
        })).rejects.toThrow('plugin_resource_session_access_unavailable');
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('connect uses an http(s) base URL and explicitly connects the socket', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);

        const client = new ApiMachineClient('token', machine);
        client.connect();

        expect(mockIo).toHaveBeenCalled();
        const url = ((mockIo as any).mock?.calls as any[] | undefined)?.[0]?.[0];
        expect(typeof url).toBe('string');
        expect(String(url).startsWith('http')).toBe(true);
        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalled());
        await client.shutdown();
    });

    it('connect does not crash if the socket lacks connect() and uses open() as a fallback', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socketNoConnect = {
            ...createMachineSocket(),
            connect: undefined,
            open: vi.fn(),
        } as any;
        bindApiSessionSocketMock(mockIo, socketNoConnect);

        const client = new ApiMachineClient('token', machine);
        client.connect();

        await vi.waitFor(() => expect(socketNoConnect.open).toHaveBeenCalled());
        await client.shutdown();
    });

    it('refreshes machine snapshot when /v2/changes includes a machine change', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const encryptedMetadata = encodeBase64(
            encrypt(machine.encryptionKey, machine.encryptionVariant, {
                host: 'h',
                platform: 'p',
                happyCliVersion: 'v',
                homeDir: '/home',
                happyHomeDir: '/happy',
                happyLibDir: '/lib',
            }),
        );

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: { changes: [{ cursor: 1, kind: 'machine', entityId: 'machine-1', changedAt: 1, hint: null }], nextCursor: 1 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-1',
                            metadata: encryptedMetadata,
                            metadataVersion: 2,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = await createRefreshingMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        client.connect();

        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalled());

        // First connect
        socket.trigger('connect');

        // Disconnect + reconnect
        socket.trigger('disconnect');
        socket.trigger('connect');
        await vi.waitFor(() => {
            expect(client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadataVersion: 2 });
        });

        expect(client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadata: { host: 'h', platform: 'p' } });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
        await client.shutdown();
    });

    it('reports account settings version hints from /v2/changes to the refresh callback', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                            { cursor: 2, kind: 'account', entityId: 'self', changedAt: 2, hint: { settingsVersion: 3 } },
                        ],
                        nextCursor: 2,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        client.onConnectedServicesProjection(async () => {});
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: 5,
            source: 'changes',
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 2);
    });

    it('retains the Account cursor when Team-change managed Provider revalidation fails', async () => {
        const priorSnapshot = getActiveAccountSettingsSnapshot();
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: {} as never,
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKeyForToken('token'),
        });
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 1,
                            kind: 'account',
                            entityId: 'teams',
                            changedAt: 1,
                            hint: null,
                        }],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const revalidate = vi.fn(async () => {
            throw new Error('managed_provider_revalidation_failed');
        });
        const withdraw = client.onManagedProviderRetainedCurrentnessInvalidation(revalidate);
        const sync = () => (client as unknown as {
            syncChangesOnConnect(options: { reason: 'live' }): Promise<void>;
        }).syncChangesOnConnect({ reason: 'live' });

        try {
            await expect(sync())
                .rejects.toThrow('managed_provider_revalidation_failed');

            expect(revalidate).toHaveBeenCalledWith({
                source: 'changes',
                signal: expect.any(AbortSignal),
                facts: expect.arrayContaining(['teams']),
            });
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            withdraw();
            await sync();
            expect(revalidate).toHaveBeenCalledOnce();
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
        } finally {
            withdraw();
            clearActiveAccountSettingsSnapshot();
            if (priorSnapshot) setActiveAccountSettingsSnapshot(priorSnapshot);
        }
    });

    it('wakes only the matching Account plugin Settings record watcher from the closed settings change arm', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            {
                                cursor: 6,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/settings',
                                changedAt: 6,
                                hint: {
                                    pluginDomain: 'settings',
                                    pluginId: 'example.tasks',
                                    scope: 'account',
                                    revision: 11,
                                },
                            },
                            {
                                cursor: 7,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/data-kv',
                                changedAt: 7,
                                hint: {
                                    pluginDomain: 'dataKv',
                                    pluginId: 'example.tasks',
                                    full: true,
                                },
                            },
                            {
                                cursor: 8,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                                changedAt: 8,
                                hint: {
                                    pluginDomain: 'dataCollection',
                                    pluginId: 'example.tasks',
                                    collectionId: 'tasks',
                                    contractDigest: 'a'.repeat(43),
                                    revision: 4,
                                    full: true,
                                },
                            },
                        ],
                        nextCursor: 8,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        publishPluginAccountCollectionWatchInvalidation.mockClear();
        publishPluginAccountSettingsWatchInvalidation.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledTimes(1);
        expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledWith({
            kind: 'record',
            pluginId: 'example.tasks',
            revision: 11,
        });
        expect(publishPluginAccountCollectionWatchInvalidation).toHaveBeenCalledWith({
            accountScopeKey: resolveAccountSettingsScopeKeyForToken('token'),
            kind: 'collection',
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: 'a'.repeat(43),
            changeCursor: 8,
            full: true,
        });
    });

    it('replays one exact inactive Pending activation before advancing the durable cursor', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return {
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 7,
                            kind: 'session',
                            entityId: 'inactive-session',
                            changedAt: 1,
                            hint: {
                                pendingVersion: 9,
                                pendingCount: 1,
                                pendingActivationRequestId: 'pending-after-ui-death',
                            },
                        }],
                        nextCursor: 7,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        const order: string[] = [];
        const activation = vi.fn(async () => {
            order.push('activation');
        });
        writeAccountChangesCursor.mockImplementationOnce(async () => {
            order.push('cursor');
        });
        const client = new ApiMachineClient('token', machine);
        client.onPendingSessionActivationHint(activation);
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(activation).toHaveBeenCalledWith({
            sessionId: 'inactive-session',
            requestId: 'pending-after-ui-death',
            pendingVersion: 9,
            source: 'changes',
        });
        expect(order).toEqual(['activation', 'cursor']);
    });

    it('accepts only the strict exact-Machine non-content Pending ephemeral carrier without advancing its Account cursor', async () => {
        const machine: Machine = { id: 'machine-1', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        const activation = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onPendingSessionActivationHint(activation);
        client.onConnectedServicesProjection(async () => {});
        client.connect();
        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalled());
        const target = { homeId: 'requester-home', accountId: 'bob', sessionId: 'inactive-session',
            machineId: machine.id, installationId: 'installation-1' };
        const hint = { type: 'pending-activation-requested', target, requestId: 'pending-request', requestedAt: 12, pendingVersion: 9 };
        socket.trigger('ephemeral', { ...hint, target: { ...target, machineId: 'other-machine' } });
        socket.trigger('ephemeral', { ...hint, prompt: 'must-not-be-accepted' });
        socket.trigger('ephemeral', hint);
        await vi.waitFor(() => expect(activation).toHaveBeenCalledExactlyOnceWith({
            sessionId: target.sessionId, target, requestId: hint.requestId, requestedAt: hint.requestedAt,
            pendingVersion: hint.pendingVersion, source: 'live',
        }));
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        await client.shutdown();
    });

    it('surfaces the same exact Pending authorization from a live machine-only update', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        const activation = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onPendingSessionActivationHint(activation);
        client.onConnectedServicesProjection(async () => {});
        client.connect();
        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalled());

        socket.trigger('update', {
            id: 'update-1',
            seq: 7,
            createdAt: 1,
            body: {
                t: 'pending-changed',
                sid: 'inactive-session',
                sessionId: 'inactive-session',
                pendingVersion: 9,
                pendingCount: 1,
                pendingActivationRequestId: 'pending-after-ui-death',
            },
        });

        await vi.waitFor(() => {
            expect(activation).toHaveBeenCalledWith({
                sessionId: 'inactive-session',
                requestId: 'pending-after-ui-death',
                pendingVersion: 9,
                source: 'live',
            });
        });
        await client.shutdown();
    });

    it('advances the durable account cursor while semantic generation deferral remains event-eligible', async () => {
        const admittedRuntime = await createAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.claude'] },
        });
        const tempRoot = await mkdtemp(join(tmpdir(), 'happier-projection-cursor-composition-'));
        const originalActiveServerDir = configuration.activeServerDir;
        const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.assign(configuration, { activeServerDir: join(tempRoot, 'server') });
        admitAccountSnapshot();
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
        }
        claudeProvenanceReplaceCount.current = 0;
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const credentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        const previousCredentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const projection = {
            id: 'acc-1',
            connectedServicesV2: [{
                serviceId: 'claude-subscription',
                profiles: [{ profileId: 'team', status: 'connected', kind: 'oauth' }],
                groups: [{
                    groupId: 'shared',
                    displayName: 'Shared Claude',
                    activeProfileId: 'team',
                    generation: 9,
                    memberProfileIds: ['team'],
                }],
            }, {
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'direct', status: 'connected', kind: 'oauth' }],
                groups: [],
            }],
            connectedServiceCredentialRevisionsV1: [{
                serviceId: 'claude-subscription',
                profileId: 'team',
                credentialRevision,
            }],
        } as const;
        const connectedCredential = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'claude-subscription',
            profileId: 'team',
            kind: 'oauth',
            expiresAt: Date.now() + 60 * 60 * 1_000,
            oauth: {
                accessToken: 'claude-access-placeholder',
                refreshToken: 'claude-refresh-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: 'claude-account',
                providerEmail: 'team@example.com',
            },
        });
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        const targetInput = (pid: number, sessionId: string) => ({
            pid,
            agentId: 'claude' as const,
            sessionId,
            materializationKey: `csm_${sessionId}`,
            connectedServicesBindingsRaw: {
                v: 1,
                bindingsByServiceId: {
                    'claude-subscription': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'shared',
                        profileId: 'team',
                    },
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'direct',
                    },
                },
            },
            connectedServiceSelectionsEnvRaw: JSON.stringify([{
                kind: 'group',
                serviceId: 'claude-subscription',
                groupId: 'shared',
                activeProfileId: 'team',
                fallbackProfileId: 'team',
                generation: 9,
                credentialRevision: previousCredentialRevision,
            }, {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'direct',
            }]),
        });
        runtimeRegistry.registerTarget(targetInput(7101, 'sess-shared-a'));
        let authoritativeProofAvailable = false;
        const materializedRoot = await readCurrentCatalogHook('claude', entry => resolveConnectedServiceMaterializedHomeRoot('claude', {
            activeServerDir: configuration.activeServerDir,
            serviceId: 'claude-subscription', profileId: 'team',
            selection: { kind: 'group', serviceId: 'claude-subscription', groupId: 'shared',
                activeProfileId: 'team', fallbackProfileId: 'team', generation: 9, policy: null },
        }, entry));
        const descriptor = await getConnectedServiceStateSharingDescriptor('claude');
        if (!materializedRoot || !descriptor?.nativeHome) throw new Error('Expected the admitted Claude native home');
        const provenancePath = join(materializedRoot, '.happier-claude-connected-service-home.json');
        const getConnectedServiceAuthGroup = vi.fn(async () => {
            // Currentness is admitted before native mutation. Native epoch proof,
            // not a second Home read, establishes successful adoption afterward.
            if (!authoritativeProofAvailable) return null;
            return { serviceId: 'claude-subscription', groupId: 'shared', activeProfileId: 'team',
                generation: 9, memberProfileIds: ['team'] };
        });
        const trackedLaunch = { directory: tempRoot,
            environmentVariables: { [descriptor.nativeHome.environmentKey]: materializedRoot,
                [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: materializedRoot } };
        const restartRequestedPids = new Set<number>();
        const runtime = await startDaemonSessionControlRuntime({
            machineId: machine.id,
            serverId: 'server-v2-reconnect',
            serverBaseUrl: 'https://account.example.test',
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: machine.encryptionKey },
            },
            daemonSessionMutationCustody: {
                stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
                stageTranscriptMessage: async () => ({ persisted: true, delivered: true }),
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain'),
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            connectedServicesMaterializationBaseDir: join(tempRoot, 'materializations'),
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry: runtimeRegistry,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            pidToTrackedSession: new Map([
                [7101, { pid: 7101, startedBy: 'daemon', happySessionId: 'sess-shared-a',
                    happySessionMetadataFromLocalWebhook: createTestMetadata({ flavor: 'claude' }), spawnOptions: trackedLaunch }],
                [7102, { pid: 7102, startedBy: 'daemon', happySessionId: 'sess-shared-b',
                    happySessionMetadataFromLocalWebhook: createTestMetadata({ flavor: 'claude' }), spawnOptions: trackedLaunch }],
            ]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: restartRequestedPids,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const socket = createMachineSocket();
        socket.connect.mockImplementation(() => {
            socket.connected = true;
            return socket;
        });
        bindApiSessionSocketMock(mockIo, socket);
        const client = new ApiMachineClient('token', machine);
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: projection };
            if (url.includes('/v4/connect/qualified/group?')) {
                const group = await getConnectedServiceAuthGroup();
                if (!group) return { status: 404, data: {} };
                return { status: 200, data: QualifiedConnectedAccountGroupResponseV4Schema.parse({ group: {
                    v: 1, ref: { service: BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID['claude-subscription'].service,
                        groupId: group.groupId }, incarnation: 'fixture-shared', displayName: 'Shared Claude', policy: {},
                    activeConnectedAccountId: group.activeProfileId, generation: group.generation,
                    runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
                    members: group.memberProfileIds.map(connectedAccountId => ({ v: 1, connectedAccountId,
                        state: {}, createdAt: 1, updatedAt: 1 })),
                } }) };
            }
            if (url.includes('/v4/connect/qualified/credential?')) {
                const compatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID['claude-subscription'];
                return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
                    ref: { service: compatibility.service, accountId: 'team' },
                    authenticationModeId: compatibility.authenticationModeByCredentialKind.oauth,
                    revisionSemantics: 'revisioned', credentialRevision, configurationRevision: null,
                    content: { t: 'plain', v: connectedCredential }, metadata: {},
                }) };
            }
            if (url.endsWith('/v1/account/encryption/currentness')) return {
                status: 200, data: createAccountEncryptionCurrentnessFixture(),
            };
            if (url.includes('/v2/sessions/')) return { status: 404, data: {} };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{ cursor: 3, kind: 'account', entityId: 'self', changedAt: 3, hint: { connectedServices: true } }],
                        nextCursor: 3,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();

        const projectionOutcomes: Array<Readonly<{ status: 'converged' }> | Readonly<{ status: 'deferred'; error: unknown }>> = [];
        const bootstrap = await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: machine.id,
            machine,
            preferredHost: 'host.local',
            happyHomeDir: tempRoot,
            happyLibDir: tempRoot,
            filesystemAccessPolicy: { kind: 'osUser' },
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine: () => client,
            attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
            startAutomationWorkerForMachine: vi.fn(() => ({
                liveWorkProducer: { read: () => ({ coverage: 'complete' as const, items: [] }), subscribe: () => () => {} },
                stop: vi.fn(),
                refreshAssignments: vi.fn(async () => {}),
                catchUp: vi.fn(async () => {}),
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async () => null),
            spawnSession: vi.fn(async () => ({ type: 'success', sessionId: 'unused' })) as never,
            spawnSessionForInternalResume: async () => { throw new Error('Unexpected internal resume'); },
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferRegistryHost: createCliRegistryHostV1(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            // Observe the real owner's result delivered to the API cursor owner;
            // no reconciliation or native-file logic is replaced.
            reconcileConnectedServicesProjection: async notification => {
                try {
                    await runtime.reconcileConnectedServicesProjection(notification);
                    projectionOutcomes.push({ status: 'converged' });
                } catch (error) {
                    projectionOutcomes.push({ status: 'deferred', error });
                    throw error;
                }
            },
            startVoiceInferenceWorkerForMachine: vi.fn(async () => null),
        });

        try {
            runtimeRegistry.unregisterPid(7101);
            runtimeRegistry.registerTarget(targetInput(7101, 'sess-shared-a'));
            const retainedBindings = runtimeRegistry.getBySessionId('sess-shared-a')!.connectedServicesBindingsRaw;

            await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
            expect(writeAccountChangesCursor).toHaveBeenCalledOnce();
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 3);

            expect(materializedRoot).toEqual(expect.any(String));
            expect(claudeProvenanceReplaceCount.current).toBe(0);
            await expect(stat(provenancePath)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(projectionOutcomes.length).toBeGreaterThan(0);
            for (const outcome of projectionOutcomes) {
                expect(outcome.status).toBe('deferred');
                if (outcome.status === 'deferred') {
                    expect(outcome.error).toBeInstanceOf(ConnectedServiceGenerationReconciliationNotAcknowledgeableError);
                }
            }

            authoritativeProofAvailable = true;
            projectionOutcomes.length = 0;
            writeAccountChangesCursor.mockClear();
            await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

            // One shared-generation write publishes the full epoch. Replays and
            // additional recipients must verify it without another replacement.
            const effectAfterRecovery = await stat(provenancePath, { bigint: true });
            const recoveredProvenanceBytes = await readFile(provenancePath, 'utf8');
            const recoveredProvenance = JSON.parse(recoveredProvenanceBytes);
            expect(recoveredProvenance).toMatchObject({
                serviceId: 'claude-subscription', credentialProfileId: 'team',
                groupId: 'shared', generation: 9, credentialRevision,
            });
            expect(claudeProvenanceReplaceCount.current).toBe(1);
            expect(projectionOutcomes).toEqual(expect.arrayContaining([{ status: 'converged' }]));
            expect(writeAccountChangesCursor).toHaveBeenCalledOnce();
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 3);

            runtimeRegistry.registerTarget(targetInput(7102, 'sess-shared-b'));
            projectionOutcomes.length = 0;
            writeAccountChangesCursor.mockClear();
            await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

            const finalEffect = await stat(provenancePath, { bigint: true });
            const finalProvenanceBytes = await readFile(provenancePath, 'utf8');
            const finalProvenance = JSON.parse(finalProvenanceBytes);
            expect(finalProvenanceBytes).toBe(recoveredProvenanceBytes);
            expect(finalProvenance).toMatchObject({
                serviceId: 'claude-subscription',
                credentialProfileId: 'team',
                groupId: 'shared',
                generation: 9,
                credentialRevision,
            });
            expect(finalEffect.ino).toBe(effectAfterRecovery.ino);
            expect(finalEffect.mtimeNs).toBe(effectAfterRecovery.mtimeNs);
            expect(claudeProvenanceReplaceCount.current).toBe(1);
            expect(projectionOutcomes).toEqual(expect.arrayContaining([{ status: 'converged' }]));
            expect(writeAccountChangesCursor).toHaveBeenCalledTimes(1);
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 3);
            expect(restartRequestedPids).toEqual(new Set());
            expect(runtimeRegistry.listTargets().map(({ pid, sessionId, connectedServicesBindingsRaw }) =>
                ({ pid, sessionId, connectedServicesBindingsRaw }))).toEqual([
                { pid: 7101, sessionId: 'sess-shared-a', connectedServicesBindingsRaw: retainedBindings },
                { pid: 7102, sessionId: 'sess-shared-b', connectedServicesBindingsRaw: retainedBindings },
            ]);
        } finally {
            await bootstrap.stopPeerMediationLoopbackServer();
            bootstrap.machineConnectionStateCleanup?.();
            await client.shutdown();
            await runtime.stopControlServer();
            await admittedRuntime.dispose();
            Object.assign(configuration, { activeServerDir: originalActiveServerDir });
            if (originalPlatformDescriptor) {
                Object.defineProperty(process, 'platform', originalPlatformDescriptor);
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps the durable account cursor behind when connected-services reconciliation cannot apply or persist', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{ cursor: 4, kind: 'account', entityId: 'self', changedAt: 4, hint: { connectedServices: true } }],
                        nextCursor: 4,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        (client as any).onConnectedServicesProjection(async (notification: { source: string }) => {
            if (notification.source === 'changes') throw new Error('durable disposition failed');
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' }))
            .rejects.toThrow('durable disposition failed');
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('reconciles current connected-services truth before an empty initial changes page', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return {
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
            }
            if (url.includes('/v2/changes')) {
                return { status: 200, data: { changes: [], nextCursor: 8 } };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        const reconcile = vi.fn(async () => {});
        client.onConnectedServicesProjection(reconcile);

        await (client as any).syncChangesOnConnect({ reason: 'connect' });

        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ source: 'startup' }));
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 8);
        expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(writeAccountChangesCursor.mock.invocationCallOrder[0]!);
    });

    it.each([
        ['connect', 'startup'],
        ['reconnect', 'reconnect'],
    ] as const)('reconciles connected-services truth during %s recovery when /v2/changes is disabled', async (reason, source) => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            mockAccountGet(async (url: string) => {
                if (url.includes('/v1/account/profile')) return {
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
                throw new Error(`unexpected url: ${url}`);
            });
            const reconcile = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(reconcile);

            await (client as any).syncChangesOnConnect({ reason });

            expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                source,
                executionAuthority: 'passive_projection',
            }));
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('does not reconcile connected services for a live session-only changes page', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 8,
                            kind: 'session',
                            entityId: 'session-1',
                            changedAt: 8,
                            hint: null,
                        }],
                        nextCursor: 8,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const reconcile = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(reconcile);

        await (client as any).syncChangesOnConnect({ reason: 'live' });

        expect(reconcile).not.toHaveBeenCalled();
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 8);
    });

    describe('service-proportional inventory reads', () => {
        let database: Awaited<ReturnType<typeof createLightSqliteHarness>> | undefined;
        beforeAll(async () => {
            database = await createLightSqliteHarness({ tempDirPrefix: 'happier-scoped-health-feed-',
                initAuth: false, initEncrypt: true, initFiles: false,
                env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' } });
        });
        afterAll(async () => { await database?.close(); });

        it('does not replay an email health commit on unrelated Account wakes or equal/refused health writes', async () => {
            await withRealCheckpoint(async storage => {
                const admitted = await createAdmittedPluginRuntimeFixture();
                let harness: Awaited<ReturnType<typeof createMaterialChangeHarness>> | undefined;
                try {
                    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
                    const service = { pluginId: 'happier.channel.email', localId: 'email-imap-smtp' };
                    const ref = { service, accountId: 'pf25-email' };
                    const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
                        expectedCredentialRevision: null, authenticationModeId: 'password',
                        content: { t: 'plain', v: { token: 'disposable-email-fixture' } }, metadata: { scopes: [] } });
                    if (created.status !== 'written') throw new Error('Email fixture credential was not created');
                    harness = await createMaterialChangeHarness(account.id, 'token', registerQualifiedConnectedAccountCredentialRoutesV4);
                    // Keep the helper's completion witness, while exercising the
                    // real cursor file rather than a cursor held by a test mock.
                    const rememberCursor = writeAccountChangesCursor.getMockImplementation()!;
                    readAccountChangesCursor.mockImplementation(storage.readAccountChangesCursor);
                    writeAccountChangesCursor.mockImplementation(async (accountId, cursor) => {
                        await storage.writeAccountChangesCursor(accountId, cursor);
                        await rememberCursor(accountId, cursor);
                    });
                    await harness.start();
                    const purposeRuntime = createDaemonConnectedAccountPurposeBindingRuntime({
                        reloadController: admitted.controller, coordinatorInventoryIsObserved: () => true,
                        resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                        establishedRuntimeOwner: createQualifiedConnectedAccountEstablishedRuntimeOwner({
                            reloadController: admitted.controller,
                            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
                            getAccountEncryptionMode: async () => 'plain',
                            configuration: { read: async () => null, secrets: {
                                admit: async () => undefined, has: async () => false, read: async () => null,
                            } },
                        }),
                        qualifiedApi: {
                            listAccountsForServices: (services, signal) => listQualifiedConnectedAccountsV4({ token: 'token', services, signal }),
                            listAccounts: currentService => listQualifiedConnectedAccountsV4({ token: 'token', service: currentService }),
                            listGroups: currentService => listQualifiedConnectedAccountGroupsV4({ token: 'token', service: currentService }),
                            readGroup: group => readQualifiedConnectedAccountGroupV4({ token: 'token', group }),
                        },
                    });
                    await purposeRuntime.listCoordinatorAccounts();
                    harness.detachProjection();
                    const projections: import('./apiMachine').ConnectedServicesProjectionNotification[] = [];
                    harness.client.onConnectedServicesProjection(async notification => {
                        projections.push(notification);
                        purposeRuntime.invalidate({ services: notification.connectedServiceRefs });
                        await purposeRuntime.listCoordinatorAccounts();
                    });
                    axiosGet.mockClear();
                    vi.mocked(logger.debug).mockClear();
                    const servicePages = () => vi.mocked(logger.debug).mock.calls
                        .filter(([message]) => message === '[API MACHINE] Connected service Account page')
                        .map(([, diagnostic]) => diagnostic);
                    const health = { v: 1 as const, status: 'needs_reauth' as const, reconnectRequired: true };
                    const patchHealth = (expectedCredentialRevision = created.credentialRevision) => harness!.app.inject({
                        method: 'PATCH', url: '/v4/connect/qualified/credential/health', headers: harness!.headers,
                        payload: QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse({ ref, health,
                            expectedCredentialRevision, expectedConfigurationRevision: created.configurationRevision }),
                    });
                    expect((await patchHealth()).statusCode).toBe(200);
                    await harness.settle();
                    const firstCursor = await storage.readAccountChangesCursor(account.id);
                    expect(projections).toEqual([expect.objectContaining({ source: 'changes', connectedServiceRefs: [service] })]);
                    expect(servicePages()).toEqual([
                        { phase: 'classified', afterCursor: firstCursor - 1, nextCursor: firstCursor,
                            changeCursors: [firstCursor], allServices: false, serviceKinds: ['email-imap-smtp'] },
                        { phase: 'settled', afterCursor: firstCursor - 1, nextCursor: firstCursor,
                            changeCursors: [firstCursor], allServices: false, serviceKinds: ['email-imap-smtp'] },
                    ]);
                    const listServices = () => axiosGet.mock.calls.flatMap(([url]) => {
                        const parsed = new URL(String(url));
                        if (parsed.pathname !== '/v4/connect/qualified/accounts') return [];
                        const service = parsed.searchParams.get('service');
                        return service ? [QualifiedConnectedAccountServiceRefSchema.parse(JSON.parse(service))]
                            : QualifiedConnectedAccountServiceListV4Schema.parse(JSON.parse(parsed.searchParams.get('services') ?? 'null'));
                    });
                    expect(listServices()).toEqual([service]);
                    for (let index = 0; index < 25; index++) {
                        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'account',
                            entityId: 'self', hint: { settingsVersion: index + 2 } }));
                        await harness.settle();
                        await purposeRuntime.listCoordinatorAccounts();
                    }
                    expect(await storage.readAccountChangesCursor(account.id)).toBeGreaterThan(firstCursor);
                    expect(projections).toHaveLength(1);
                    expect(listServices()).toEqual([service]);
                    const beforeRefusal = await storage.readAccountChangesCursor(account.id);
                    expect((await patchHealth()).statusCode).toBe(200);
                    expect((await patchHealth(`csr_${'x'.repeat(22)}`)).statusCode).toBe(409);
                    await harness.settle();
                    await purposeRuntime.listCoordinatorAccounts();
                    expect(await storage.readAccountChangesCursor(account.id)).toBe(beforeRefusal);
                    expect(projections).toHaveLength(1);
                    expect(listServices()).toEqual([service]);
                    expect(servicePages()).toHaveLength(2);
                } finally {
                    try { await harness?.close(); }
                    finally { await admitted.dispose(); }
                }
            });
        });

        it.each(['health', 'emergency-revoke'] as const)('withdraws and restores real direct material through Team feed (%s)', async transition => {
            const admitted = await createAdmittedPluginRuntimeFixture();
            let harness: Awaited<ReturnType<typeof createMaterialChangeHarness>> | undefined;
            let detachMaterial: (() => void) | undefined;
            let drainMaterial: (() => Promise<void>) | undefined;
            try {
                const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
                const recipient = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
                const departed = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
                const service = { pluginId: 'happier.voice.openai', localId: 'openai' };
                const ref = { service, accountId: 'fx206-source' };
                const contribution = admitted.registry.connectedAccountContributions?.describe(service);
                const mode = contribution?.descriptor.authentication.modes.find(candidate => candidate.id === 'api-key');
                if (!contribution || mode?.kind !== 'manual' || !mode.directExport) {
                    throw new Error('Expected the admitted manual OpenAI direct-export contribution');
                }
                const directExportContract = mode.directExport.contractVersion;
                const createCredential = () => mutateQualifiedConnectedServiceCredential({
                    accountId: custodian.id, ref, expectedCredentialRevision: null, authenticationModeId: mode.id,
                    directExportContract,
                    contributionContractVersion: contribution.occurrenceId,
                    content: { t: 'plain', v: { v: 1, values: { token: 'sk-fx206-disposable-fixture' } } },
                    metadata: { scopes: [] },
                });
                const created = await createCredential();
                if (created.status !== 'written') throw new Error('Fixture source credential was not created');
                const identity = await inTx(tx => readQualifiedConnectedAccountSourceIdentityInTx(tx, { accountId: custodian.id, ref }));
                if (!identity) throw new Error('Fixture source has no canonical incarnation');
                expect(identity.directExportContract).toBe(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1);
                const source = { v: 1 as const, kind: 'connected_account' as const,
                    target: { kind: 'account' as const, account: ref }, credentialIncarnation: identity.incarnation };
                const team = await db.team.create({ data: { name: `FX206 ${transition}` } });
                await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
                const recipientMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
                const departedMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: departed.id, role: 'member' } });
                const resource = await db.teamCredentialResource.create({ data: {
                    teamId: team.id, custodianAccountId: custodian.id, displayName: 'FX206 direct source',
                    disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed', sourceBindingJson: JSON.stringify(source),
                    memberGrants: { create: { teamMembershipId: recipientMembership.id, deliveryMode: 'direct' } },
                } });
                // No membership survives for this broker custodian. Its resource
                // keeps it in the real Team publication audience.
                const broker = await db.machine.create({ data: { accountId: departed.id, id: `fx206-broker-${transition}`,
                    metadata: '{}', dataEncryptionKey: null } });
                await db.teamCredentialResource.create({ data: {
                    teamId: team.id, custodianAccountId: departed.id, displayName: 'Departed broker custodian',
                    disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
                    brokerMachineId: broker.id, sourceBindingJson: JSON.stringify(source),
                } });
                await db.teamMembership.delete({ where: { id: departedMembership.id } });
                expect(await db.teamMembership.count({ where: { teamId: team.id, accountId: departed.id } })).toBe(0);
                const session = await db.session.create({ data: { accountId: recipient.id, tag: crypto.randomUUID(),
                    metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted', metadataLayoutVersion: 1,
                    ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }), agentState: null, active: true } });
                const slot = { kind: 'connected_service_purpose' as const,
                    purpose: { consumer: service, purpose: 'voice.client-auth' } };
                const acceptResource = async (revision: number) => {
                    expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                        sessionId: session.id, accountId: recipient.id,
                        intents: [{ v: 1, slot, resourceId: resource.id, expectedResourceRevision: revision, deliveryMode: 'direct' }],
                        authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
                    }))).toEqual({ ok: true });
                };
                await acceptResource(resource.revision);
                harness = await createMaterialChangeHarness(custodian.id, 'token', app => {
                    registerTeamRoutes(app, { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' });
                    registerQualifiedConnectedAccountCredentialRoutesV4(app);
                });
                const { app, headers, client } = harness;
                const request = async (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, actor = custodian.id) => {
                    const response = await app.inject({ method, url: new URL(url, 'http://fixture').pathname + new URL(url, 'http://fixture').search,
                        headers: { ...headers, 'x-test-user-id': actor, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
                        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
                    expect(response.statusCode, `${method} ${new URL(url, 'http://fixture').pathname}: ${response.body}`).toBe(200);
                    return { status: response.statusCode, data: response.json() as unknown };
                };
                axiosPost.mockImplementation((url: string, payload: unknown, options?: { headers?: { Authorization?: string } }) =>
                    request('POST', url, payload, options?.headers?.Authorization === 'Bearer recipient' ? recipient.id : custodian.id));
                axiosPut.mockImplementation((url: string, payload: unknown) => request('PUT', url, payload));
                axiosDelete.mockImplementation((url: string, options?: { data?: unknown }) => request('DELETE', url, options?.data));
                const establishedRuntimeOwner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
                    reloadController: admitted.controller, credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
                    getAccountEncryptionMode: async () => 'plain',
                    configuration: { read: async () => null, secrets: {
                        admit: async () => undefined, has: async () => false, read: async () => null,
                    } },
                });
                const purposeRuntime = createDaemonConnectedAccountPurposeBindingRuntime({
                    reloadController: admitted.controller, establishedRuntimeOwner,
                    coordinatorInventoryIsObserved: () => true, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                    qualifiedApi: {
                        listAccountsForServices: (services, signal) => listQualifiedConnectedAccountsV4({ token: 'token', services, signal }),
                        listAccounts: currentService => listQualifiedConnectedAccountsV4({ token: 'token', service: currentService }),
                        listGroups: currentService => listQualifiedConnectedAccountGroupsV4({ token: 'token', service: currentService }),
                        readGroup: group => readQualifiedConnectedAccountGroupV4({ token: 'token', group }),
                    },
                });
                await purposeRuntime.listCoordinatorAccounts();
                const services = axiosGet.mock.calls.flatMap(([url]) => {
                    const parsed = new URL(String(url));
                    if (parsed.pathname !== '/v4/connect/qualified/accounts') return [];
                    const service = parsed.searchParams.get('service');
                    return service ? [QualifiedConnectedAccountServiceRefSchema.parse(JSON.parse(service))]
                        : QualifiedConnectedAccountServiceListV4Schema.parse(JSON.parse(parsed.searchParams.get('services') ?? 'null'));
                });
                expect(services).toContainEqual(service);
                harness.detachProjection();
                client.onConnectedServicesProjection(async notification => {
                    purposeRuntime.invalidate({ services: notification.connectedServiceRefs });
                    await purposeRuntime.listCoordinatorAccounts();
                });
                const retained = vi.fn();
                client.onManagedProviderRetainedCurrentnessInvalidation(retained);
                const homeDomainAction = vi.fn<NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['homeDomainAction']>>(async action => {
                    const transport = homeDomainActionTransportV1(action.actionId);
                    return (await request('POST', transport.path, action.input)).data;
                });
                const materialOwner = createDaemonTeamCredentialDirectMaterialReconciler({
                    token: 'token', accountId: custodian.id, homeDomainAction, establishedRuntimeOwner,
                    listAccounts: (currentService, signal) => listQualifiedConnectedAccountsV4({ token: 'token', service: currentService, signal }),
                    readGroup: async () => null, resolveProviderSource: async () => null,
                    isAccountChangesObserverCurrent: () => client.hasCurrentAccountChangesObserver(),
                });
                const pending = new Set<Promise<unknown>>();
                drainMaterial = async () => { await Promise.all([...pending]); };
                const passes: Awaited<ReturnType<typeof materialOwner.reconcile>>[] = [];
                const passErrors: unknown[] = [];
                // Match daemon startup: establish a real readable tuple before
                // attaching Account wakes. Subscription mutations must fail on
                // the health/revocation edge, not on baseline fixture setup.
                expect(await materialOwner.reconcile('startup')).toMatchObject({ prepared: 1, failures: [] });
                detachMaterial = subscribeTeamCredentialDirectMaterialAccountChanges(client, wake => {
                    const pass = materialOwner.reconcile(wake).then(result => { passes.push(result); }, error => { passErrors.push(error); })
                        .finally(() => pending.delete(pass));
                    pending.add(pass);
                });
                const settle = async ({ sourceUnavailable = false }: { sourceUnavailable?: boolean } = {}) => {
                    await vi.waitFor(async () => {
                        expect(pending.size).toBe(0);
                        if (sourceUnavailable) {
                            for (const error of passErrors) expect(error).toMatchObject({
                                response: { status: 400, data: { error: 'source_replaced_or_missing' } },
                            });
                        } else expect(passErrors, 'real material reconciler errors').toEqual([]);
                        expect(harness!.getCursor()).toBe((await db.account.findUniqueOrThrow({ where: { id: custodian.id } })).seq);
                    });
                    passErrors.length = 0;
                };
                await harness.start();
                await settle();
                const recipientClient = createHttpTeamCredentialDirectMaterialClient({ token: 'recipient', teamId: team.id,
                    readRecipientEncryptionMaterial: async () => ({ mode: 'plain' }) });
                const open = () => recipientClient.open({ resourceId: resource.id, teamId: team.id,
                    consumer: { kind: 'session', sessionId: session.id }, slot, disclosedMember: ref });
                expect(await open()).toMatchObject({ ok: true, payload: { material: { kind: 'qualified_connected_account' } } });
                const memberKey = computeTeamCredentialSourceMemberKeyV1({ kind: 'connected_account', service, connectedAccountId: ref.accountId });
                const storedBefore = await db.teamCredentialRecipientMaterial.findFirstOrThrow({ where: { resourceId: resource.id, recipientAccountId: recipient.id } });
                const censusCount = () => homeDomainAction.mock.calls.filter(([action]) => action.actionId === 'teams.list').length;
                const checkpoints = async () => Promise.all([custodian, recipient, departed].map(async account => ({
                    accountId: account.id, cursor: (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq,
                })));
                const assertAudience = async (before: Awaited<ReturnType<typeof checkpoints>>) => {
                    for (const account of before) {
                        expect(await db.accountChange.findMany({ where: { accountId: account.accountId, entityId: 'teams', cursor: { gt: account.cursor } } }),
                            `newer Team fact for ${account.accountId === departed.id ? 'departed broker custodian' : 'current member'}`).not.toEqual([]);
                    }
                };
                homeDomainAction.mockClear(); passes.length = 0; retained.mockClear();
                const before = await checkpoints();
                if (transition === 'health') {
                    expect((await mutateQualifiedConnectedServiceCredentialHealth({ accountId: custodian.id, ref,
                        expectedCredentialRevision: created.credentialRevision, expectedConfigurationRevision: created.configurationRevision,
                        health: { v: 1, status: 'needs_reauth', reconnectRequired: true } })).status).toBe('written');
                } else {
                    const query = new URLSearchParams({ ref: JSON.stringify(ref), expectedCredentialRevision: created.credentialRevision,
                        cleanupGroupReferences: 'true', emergencyRevoke: 'true' });
                    await request('DELETE', `/v4/connect/qualified/credential?${query}`);
                    expect(await inTx(tx => readQualifiedConnectedAccountSourceIdentityInTx(tx, { accountId: custodian.id, ref }))).toBeNull();
                }
                await assertAudience(before);
                await settle({ sourceUnavailable: transition === 'emergency-revoke' });
                expect(censusCount(), 'one material census per source transition').toBe(1);
                expect(retained).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.arrayContaining(['connected-services']) }));
                expect(await open()).toMatchObject({ ok: false });
                if (transition === 'health') {
                    expect(await db.teamCredentialRecipientMaterial.count({ where: { id: storedBefore.id } }), 'captured material tuple withdrawn').toBe(0);
                    homeDomainAction.mockClear();
                    const noChange = await checkpoints();
                    expect((await mutateQualifiedConnectedServiceCredentialHealth({ accountId: custodian.id, ref,
                        expectedCredentialRevision: created.credentialRevision, expectedConfigurationRevision: created.configurationRevision,
                        health: { v: 1, status: 'needs_reauth', reconnectRequired: true } })).status).toBe('written');
                    await settle();
                    expect(censusCount(), 'equal-health retry').toBe(0);
                    for (const account of noChange) expect((await db.account.findUniqueOrThrow({ where: { id: account.accountId } })).seq).toBe(account.cursor);
                    const recovering = await checkpoints();
                    expect((await mutateQualifiedConnectedServiceCredentialHealth({ accountId: custodian.id, ref,
                        expectedCredentialRevision: created.credentialRevision, expectedConfigurationRevision: created.configurationRevision,
                        health: { v: 1, status: 'connected', reconnectRequired: false } })).status).toBe('written');
                    await assertAudience(recovering);
                    await settle();
                    expect(censusCount(), 'one material census for connected recovery').toBe(1);
                } else {
                    homeDomainAction.mockClear();
                    const recreated = await createCredential();
                    expect(recreated.status).toBe('written');
                    const nextIdentity = await inTx(tx => readQualifiedConnectedAccountSourceIdentityInTx(tx, { accountId: custodian.id, ref }));
                    if (!nextIdentity) throw new Error('Recreated credential has no incarnation');
                    expect(nextIdentity.incarnation).not.toBe(identity.incarnation);
                    await settle({ sourceUnavailable: true });
                    expect(await open(), 'recreation must not revive the old pinned source').toMatchObject({ ok: false });
                    expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).sourceBindingJson)
                        .toBe(JSON.stringify(source));
                    // Explicit source rebind uses the normal resource update route.
                    const transport = homeDomainActionTransportV1('teams.credentials.update');
                    await request('POST', transport.path, { resourceId: resource.id, expectedRevision: resource.revision,
                        replacement: { enabled: true, displayName: resource.displayName, sessionUsePolicy: 'personal_allowed',
                            requestPolicy: null, allMembersDeliveryMode: null, groupGrants: [],
                            memberGrants: [{ teamMembershipId: recipientMembership.id, deliveryMode: 'direct' }],
                            usageLimitDelta: { upserts: [], deleteIds: [] },
                            custodian: { source: { ...source, credentialIncarnation: nextIdentity.incarnation },
                                disclosureCeiling: 'direct_allowed', brokerPlacement: null } } });
                    // A recipient explicitly accepts the rebound resource revision.
                    const currentResource = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } });
                    await acceptResource(currentResource.revision);
                    await settle();
                }
                expect(await open(), 'freshly admitted material after recovery/rebind').toMatchObject({ ok: true });
                const restored = await db.teamCredentialRecipientMaterial.findFirstOrThrow({ where: { resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey: memberKey } });
                expect(restored.id).not.toBe(storedBefore.id);
                homeDomainAction.mockClear();
                const unrelatedService = services.find(candidate => candidate.pluginId !== service.pluginId || candidate.localId !== service.localId);
                if (!unrelatedService) throw new Error('Direct material fixture needs an unrelated service');
                expect((await mutateQualifiedConnectedServiceCredential({ accountId: custodian.id,
                    ref: { service: unrelatedService, accountId: 'fx206-unrelated' }, expectedCredentialRevision: null,
                    authenticationModeId: 'api-key', content: { t: 'plain', v: { token: 'unrelated-fixture' } }, metadata: { scopes: [] } })).status).toBe('written');
                await settle();
                expect(censusCount(), 'unrelated same-Account service').toBe(0);
                expect(await open()).toMatchObject({ ok: true });
            } finally {
                detachMaterial?.();
                try { await drainMaterial?.(); await harness?.close(); }
                finally { await admitted.dispose(); }
            }
        });

        it('keeps health PATCHes and Account-feed publications at zero across two settled status intervals', async () => {
            const admitted = await createAdmittedPluginRuntimeFixture();
            try {
                const account = await db.account.create({ data: { id: 'acc-settled-health', publicKey: null, encryptionMode: 'plain' } });
                const ref = { service: { pluginId: 'happier.voice.openai', localId: 'openai' }, accountId: 'status-account' };
                const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
                    expectedCredentialRevision: null, authenticationModeId: 'api-key',
                    content: { t: 'plain', v: { v: 1, values: { token: 'sk-status-fixture' } } }, metadata: { scopes: [] } });
                if (created.status !== 'written') throw new Error('Fixture credential did not settle');
                const credentials: persistence.Credentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } };
                const readCredential = async () => {
                    const result = await readQualifiedConnectedServiceCredential({ accountId: account.id, ref });
                    return result.status === 'resolved'
                        ? QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref, ...result.credential }) : null;
                };
                const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ reloadController: admitted.controller,
                    credentials, getAccountEncryptionMode: async () => 'plain', readCredential,
                    readConfiguration: async () => null, configuration: { read: async () => null, secrets: {
                        admit: async () => undefined, has: async () => false, read: async () => null,
                    } } });
                const healthPatches = vi.fn(async ({ patch }: { token: string; patch: unknown }) => {
                    const result = await mutateQualifiedConnectedServiceCredentialHealth({ accountId: account.id,
                        ...QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(patch) });
                    if (result.status !== 'written') throw new Error('Fixture health did not settle');
                    return result;
                });
                let clock = 1_000_000;
                const coordinatorParams: ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0] = {
                    api: { getAccountEncryptionMode: async () => 'plain' } as unknown as ApiClient,
                    credentials, machineIdProvider: () => 'machine-1', activeServerDir: join(admitted.happyHomeDir, 'active'),
                    baseDir: join(admitted.happyHomeDir, 'materialized'), refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: () => clock,
                    qualifiedConnectedAccountRuntime: {
                        resolvePeerClass: () => 'advertised_v4', establishedRuntimeOwner: established, readCredential,
                        mutateCredentialHealth: healthPatches,
                        listScheduledAccounts: async () => await listQualifiedConnectedAccounts({ accountId: account.id, service: ref.service }),
                        acquireRefreshLease: async () => { throw new Error('Status must not acquire a refresh lease'); },
                        mutateCredential: async () => { throw new Error('Status must not replace credentials'); },
                    },
                };
                await new ConnectedServiceRefreshCoordinator(coordinatorParams).tickOnce();
                expect(healthPatches).toHaveBeenCalledOnce();
                const checkpoint = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
                for (let interval = 0; interval < 2; interval++) {
                    clock += 300_000;
                    await new ConnectedServiceRefreshCoordinator(coordinatorParams).tickOnce();
                }
                expect(healthPatches).toHaveBeenCalledOnce();
                expect(await db.accountChange.count({ where: { accountId: account.id, cursor: { gt: checkpoint } } })).toBe(0);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(checkpoint);
            } finally {
                await admitted.dispose();
            }
        });

        it.each(['one', 'two', 'broad', 'legacy', 'team'] as const)('reconciles connected services with one batch inventory read (%s)', async mode => {
            const admitted = await createAdmittedPluginRuntimeFixture();
            let client: ApiMachineClient | undefined;
            try {
                const listAccounts = vi.fn(async (service: { pluginId: string; localId: string }) => ({ service, accounts: [] }));
                const listAccountsForServices = vi.fn(async (services: readonly { pluginId: string; localId: string }[]) => ({ services, accounts: [] }));
                const purposeRuntime = createDaemonConnectedAccountPurposeBindingRuntime({
                    reloadController: admitted.controller,
                    coordinatorInventoryIsObserved: () => true,
                    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                    establishedRuntimeOwner: createQualifiedConnectedAccountEstablishedRuntimeOwner({
                        reloadController: admitted.controller,
                        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
                        getAccountEncryptionMode: async () => 'plain',
                        readCredential: async () => { throw new Error('Inventory must not read credentials'); },
                        readConfiguration: async () => null,
                        configuration: { read: async () => null, secrets: {
                            admit: async () => undefined, has: async () => false, read: async () => null,
                        } },
                    }),
                    qualifiedApi: { listAccountsForServices, listAccounts, listGroups: async () => ({ groups: [] }), readGroup: async () => null },
                });
                await purposeRuntime.listCoordinatorAccounts();
                expect(listAccountsForServices).toHaveBeenCalledOnce();
                expect(listAccounts).not.toHaveBeenCalled();
                const services = listAccountsForServices.mock.calls[0]![0];
                // The contract compares the batch scope with the admitted inventory;
                // bundled membership may change, but the two-service case needs both.
                expect(services[0]).toBeDefined();
                expect(services[1]).toBeDefined();
                const connectedServiceRefs = mode === 'broad' || mode === 'legacy' ? undefined : services.slice(0, mode === 'two' ? 2 : 1);
                const account = await db.account.create({ data: { id: `acc-scope-${mode}`, publicKey: null, encryptionMode: 'plain' } });
                if (mode === 'team') {
                    const team = await db.team.create({ data: { name: 'Credential source health' } });
                    await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'owner' } });
                    await db.teamCredentialResource.create({ data: {
                        teamId: team.id, custodianAccountId: account.id, displayName: 'Health source',
                        disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed',
                        sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_account',
                            target: { kind: 'account', account: { service: services[0], accountId: 'scope-test' } },
                            credentialIncarnation: 'scope-incarnation' }),
                    } });
                }
                const revisions = [];
                for (const service of connectedServiceRefs ?? services.slice(0, 1)) {
                    const ref = { service, accountId: 'scope-test' };
                    const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
                        expectedCredentialRevision: null, authenticationModeId: 'api-key',
                        content: { t: 'plain', v: { token: 'test-credential' } }, metadata: { scopes: [] } });
                    if (created.status !== 'written') throw new Error('Fixture credential creation did not settle');
                    revisions.push({ ref, credentialRevision: created.credentialRevision, configurationRevision: created.configurationRevision });
                    const health = await mutateQualifiedConnectedServiceCredentialHealth({ accountId: account.id, ref,
                        expectedCredentialRevision: created.credentialRevision, expectedConfigurationRevision: created.configurationRevision,
                        health: { v: 1, status: 'needs_reauth', reconnectRequired: true } });
                    expect(health.status).toBe('written');
                }
                if (mode === 'broad') await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id }));
                if (mode === 'legacy') await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'account',
                    entityId: 'self', hint: { connectedServices: true } }));
                let acknowledged = 0;
                readAccountChangesCursor.mockImplementation(async () => acknowledged);
                writeAccountChangesCursor.mockImplementation(async (_accountId, cursor) => { acknowledged = cursor; });
                listAccounts.mockClear();
                listAccountsForServices.mockClear();
                const machine: Machine = {
                    id: 'machine-1',
                    encryptionKey: new Uint8Array(32).fill(7),
                    encryptionVariant: 'legacy',
                    metadata: null,
                    metadataVersion: 0,
                    daemonState: null,
                    daemonStateVersion: 0,
                };
                mockAccountGet(async (url: string) => {
                    if (url.includes('/v1/account/profile')) return { status: 200, data: { id: account.id } };
                    if (url.includes('/v2/changes')) {
                        const changes = await db.accountChange.findMany({ where: { accountId: account.id, cursor: { gt: acknowledged } },
                            orderBy: { cursor: 'asc' } });
                        return {
                            status: 200,
                            data: {
                                changes: changes.map(change => ({
                                    cursor: change.cursor,
                                    kind: 'account',
                                    entityId: change.entityId,
                                    changedAt: change.changedAt.getTime(),
                                    hint: change.hint,
                                })),
                                nextCursor: changes.at(-1)?.cursor ?? acknowledged,
                            },
                        };
                    }
                    throw new Error(`unexpected url: ${url}`);
                });
                const reconcile = vi.fn(async (notification: import('./apiMachine').ConnectedServicesProjectionNotification) => {
                    purposeRuntime.invalidate({ services: notification.connectedServiceRefs });
                    await purposeRuntime.listCoordinatorAccounts();
                });
                const directMaterial = vi.fn(async () => {});
                client = new ApiMachineClient('token', machine);
                client.onConnectedServicesProjection(reconcile);
                client.onManagedProviderRetainedCurrentnessInvalidation(directMaterial);
                // The Action transport is the boundary; feed classification,
                // subscription and the real census owner remain composed.
                const homeDomainAction = vi.fn(async () => ({ items: [], nextCursor: null }));
                const materialOwner = createDaemonTeamCredentialDirectMaterialReconciler({
                    token: 'token', accountId: account.id, homeDomainAction,
                    establishedRuntimeOwner: { readMaterialSnapshot: async () => { throw new Error('Empty Team census must not read material'); } },
                    listAccounts, readGroup: async () => null, resolveProviderSource: async () => null,
                    isAccountChangesObserverCurrent: () => true,
                });
                const materialPasses: Promise<unknown>[] = [];
                const detachMaterial = subscribeTeamCredentialDirectMaterialAccountChanges(client, wake => {
                    materialPasses.push(materialOwner.reconcile(wake));
                });
                await (client as unknown as { syncChangesOnConnect(input: { reason: 'live' }): Promise<void> })
                    .syncChangesOnConnect({ reason: 'live' });
                await Promise.all(materialPasses);
                expect(homeDomainAction).toHaveBeenCalledTimes(mode === 'team' ? 1 : 0);
                expect(listAccountsForServices.mock.calls.map(([services]) => services)).toEqual([connectedServiceRefs ?? services]);
                expect(listAccounts).not.toHaveBeenCalled();
                expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                    source: 'changes', executionAuthority: 'runtime_recovery',
                    ...(connectedServiceRefs ? { connectedServiceRefs } : {}),
                }));
                expect(directMaterial).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ facts: expect.arrayContaining(['connected-services']) }));
                if (mode === 'two' || mode === 'team') {
                    homeDomainAction.mockClear();
                    materialPasses.length = 0;
                    listAccounts.mockClear();
                    listAccountsForServices.mockClear();
                    reconcile.mockClear();
                    const [first] = revisions;
                    if (!first) throw new Error('Missing service A credential revision');
                    expect((await mutateQualifiedConnectedServiceCredentialHealth({ accountId: account.id, ref: first.ref,
                        expectedCredentialRevision: first.credentialRevision, expectedConfigurationRevision: first.configurationRevision,
                        health: { v: 1, status: 'connected', reconnectRequired: false } })).status).toBe('written');
                    await (client as unknown as { syncChangesOnConnect(input: { reason: 'live' }): Promise<void> })
                        .syncChangesOnConnect({ reason: 'live' });
                    await Promise.all(materialPasses);
                    expect(homeDomainAction).toHaveBeenCalledTimes(mode === 'team' ? 1 : 0);
                    expect(listAccountsForServices.mock.calls.map(([services]) => services)).toEqual([[services[0]]]);
                    expect(listAccounts).not.toHaveBeenCalled();
                    expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ connectedServiceRefs: [services[0]] }));
                }
                if (mode === 'team') {
                    homeDomainAction.mockClear();
                    materialPasses.length = 0;
                    const unrelated = await mutateQualifiedConnectedServiceCredential({ accountId: account.id,
                        ref: { service: services[1]!, accountId: 'unshared-account' }, expectedCredentialRevision: null,
                        authenticationModeId: 'api-key', content: { t: 'plain', v: { token: 'unshared-fixture' } },
                        metadata: { scopes: [] } });
                    expect(unrelated.status).toBe('written');
                    await (client as unknown as { syncChangesOnConnect(input: { reason: 'live' }): Promise<void> })
                        .syncChangesOnConnect({ reason: 'live' });
                    await Promise.all(materialPasses);
                    expect(homeDomainAction).not.toHaveBeenCalled();
                }
                listAccounts.mockClear();
                listAccountsForServices.mockClear();
                reconcile.mockClear();
                directMaterial.mockClear();
                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self', hint: { settingsVersion: 2 } }));
                await (client as unknown as { syncChangesOnConnect(input: { reason: 'live' }): Promise<void> })
                    .syncChangesOnConnect({ reason: 'live' });
                await purposeRuntime.listCoordinatorAccounts();
                expect(listAccounts).not.toHaveBeenCalled();
                expect(listAccountsForServices).not.toHaveBeenCalled();
                expect(reconcile).not.toHaveBeenCalled();
                expect(directMaterial).not.toHaveBeenCalled();
                detachMaterial();
            } finally {
                try { await client?.shutdown(); }
                finally { await admitted.dispose(); }
            }
        });
    });

    it('continues /v2/changes catch-up without timer retry when generation reconciliation awaits another domain event', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            mockAccountGet(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    return {
                        status: 200,
                        data: {
                            id: 'acc-1',
                            connectedServicesV2: [],
                            connectedServiceCredentialRevisionsV1: [],
                        },
                    };
                }
                if (url.includes('/v2/changes')) {
                    return { status: 200, data: { changes: [], nextCursor: 9 } };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            axiosGet.mockClear();
            writeAccountChangesCursor.mockClear();
            const reconcile = vi.fn(async () => {
                throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
            });
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(reconcile);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.advanceTimersByTimeAsync(0);

            expect(reconcile).toHaveBeenCalledOnce();
            expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);

            await vi.advanceTimersByTimeAsync(60_000);
            expect(reconcile).toHaveBeenCalledOnce();

            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await vi.advanceTimersByTimeAsync(0);
            expect(reconcile).toHaveBeenCalledTimes(2);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries a transient projection disposition failure without another server event', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            mockAccountGet(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    return {
                        status: 200,
                        data: {
                            id: 'acc-1',
                            connectedServicesV2: [],
                            connectedServiceCredentialRevisionsV1: [],
                        },
                    };
                }
                if (url.includes('/v2/changes')) {
                    return { status: 200, data: { changes: [], nextCursor: 9 } };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            writeAccountChangesCursor.mockClear();
            const reconcile = vi.fn()
                .mockRejectedValueOnce(new Error('transient disposition failure'))
                .mockResolvedValueOnce(undefined);
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(reconcile);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_000);
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));

            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('serializes a newer projection hint behind an in-flight pass and leaves the newer projection applied last', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            const firstProfile = createDeferred<{ status: number; data: unknown }>();
            let activeFetches = 0;
            let maxActiveFetches = 0;
            let profileCalls = 0;
            mockAccountGet(async (url: string) => {
                if (!url.includes('/v1/account/profile')) throw new Error(`unexpected url: ${url}`);
                profileCalls += 1;
                activeFetches += 1;
                maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
                const response = profileCalls === 1
                    ? await firstProfile.promise
                    : {
                        status: 200,
                        data: {
                            id: 'acc-1',
                            connectedServicesV2: [],
                            connectedServiceCredentialRevisionsV1: [{
                                serviceId: 'anthropic',
                                profileId: 'profile-a',
                                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                            }],
                        },
                    };
                activeFetches -= 1;
                return response;
            });
            axiosGet.mockClear();
            const appliedRevisions: string[] = [];
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(async (notification) => {
                const entries = notification.connectedServiceCredentialRevisionsV1 as Array<{ credentialRevision: string }>;
                appliedRevisions.push(entries[0]?.credentialRevision ?? 'none');
            });

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(profileCalls).toBe(1));
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await Promise.resolve();
            expect(profileCalls).toBe(1);

            firstProfile.resolve({
                status: 200,
                data: {
                    id: 'acc-1',
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [{
                        serviceId: 'anthropic',
                        profileId: 'profile-a',
                        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                    }],
                },
            });
            await (client as any).connectedServicesProjectionRetry.waitForIdle();

            expect(maxActiveFetches).toBe(1);
            expect(appliedRevisions).toEqual([
                'csr_aaaaaaaaaaaaaaaaaaaaaa',
                'csr_bbbbbbbbbbbbbbbbbbbbbb',
            ]);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('does not turn repeated projection hints into concurrent work or reset retry backoff', async () => {
        vi.useFakeTimers();
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockResolvedValue({
                status: 200,
                data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
            });
            axiosGet.mockClear();
            let activeListeners = 0;
            let maxActiveListeners = 0;
            const firstDisposition = createDeferred<void>();
            let listenerCalls = 0;
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(async () => {
                listenerCalls += 1;
                activeListeners += 1;
                maxActiveListeners = Math.max(maxActiveListeners, activeListeners);
                try {
                    if (listenerCalls === 1) await firstDisposition.promise;
                } finally {
                    activeListeners -= 1;
                }
            });

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(listenerCalls).toBe(1));
            for (let index = 0; index < 20; index += 1) {
                (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            }
            firstDisposition.reject(new Error('transient disposition failure'));
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_999);
            expect(listenerCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(listenerCalls).toBe(2));
            await (client as any).connectedServicesProjectionRetry.waitForIdle();

            expect(maxActiveListeners).toBe(1);
            expect(listenerCalls).toBe(2);
        } finally {
            vi.useRealTimers();
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('aborts an in-flight projection request and awaits scheduler quiescence on shutdown', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            let requestSignal: AbortSignal | undefined;
            mockAccountGet(async (_url: string, config?: { signal?: AbortSignal }) => {
                requestSignal = config?.signal;
                await new Promise<void>((_resolve, reject) => {
                    config?.signal?.addEventListener('abort', () => reject(config.signal?.reason), { once: true });
                });
                throw new Error('unreachable');
            });
            axiosGet.mockClear();
            const listener = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(listener);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledOnce());
            await client.shutdown();

            expect(requestSignal?.aborted).toBe(true);
            expect(listener).not.toHaveBeenCalled();
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('threads shutdown cancellation through the projection listener before changes or cursor side effects', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockResolvedValue({
            status: 200,
            data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
        });
        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        const listenerSideEffects: string[] = [];
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async (notification) => {
            listenerSideEffects.push('entered');
            await new Promise<void>((resolve) => {
                notification.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            if (!notification.signal.aborted) listenerSideEffects.push('after-abort');
        });

        (client as any).startChangesSyncWithRetry({ reason: 'connect' });
        await vi.waitFor(() => expect(listenerSideEffects).toEqual(['entered']));
        await client.shutdown();

        expect(listenerSideEffects).toEqual(['entered']);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v2/changes'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('awaits an entered cursor write during shutdown instead of reporting false quiescence', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] } };
            }
            if (url.includes('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: 12 } };
            throw new Error(`unexpected url: ${url}`);
        });
        axiosGet.mockClear();
        const cursorWrite = createDeferred<void>();
        writeAccountChangesCursor.mockImplementationOnce(async () => await cursorWrite.promise);
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        (client as any).startChangesSyncWithRetry({ reason: 'connect' });
        await vi.waitFor(() => expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 12));

        let shutdownSettled = false;
        const shutdown = client.shutdown().then(() => { shutdownSettled = true; });
        await Promise.resolve();
        expect(shutdownSettled).toBe(false);

        cursorWrite.resolve();
        await shutdown;
        expect(shutdownSettled).toBe(true);
    });

    it('rejects projection producers that race with or follow terminal shutdown', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockResolvedValue({
                status: 200,
                data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
            });
            axiosGet.mockClear();
            const current = createDeferred<void>();
            let calls = 0;
            const client = new ApiMachineClient('token', machine);
            const socket = createMachineSocket();
            (client as any).socket = socket;
            (client as any).activeTransportGeneration = 1;
            (client as any).installSocketEventHandlers(socket, 1);
            client.onConnectedServicesProjection(async () => {
                calls += 1;
                if (calls === 1) await current.promise;
            });
            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(calls).toBe(1));

            const shutdown = client.shutdown();
            socket.trigger('update', { body: { t: 'update-account', connectedServices: [] } });
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            current.resolve();
            await shutdown;
            socket.trigger('update', { body: { t: 'update-account', connectedServices: [] } });
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await Promise.resolve();

            expect(calls).toBe(1);
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('advances the changes cursor when account settings refresh for a hint fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                        ],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(async () => {
            throw new Error('settings refresh failed');
        });
        client.onConnectedServicesProjection(async () => {});
        const secondListener = vi.fn(async () => {});
        client.onAccountSettingsVersionHint(secondListener);

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
        expect(secondListener).toHaveBeenCalledWith({
            settingsVersion: 5,
            source: 'changes',
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
    });

    it('does not surface an unhandled rejection when a background changes sync fails on connect', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                        ],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            const client = new ApiMachineClient('token', machine);
            client.onAccountSettingsVersionHint(async () => {
                throw new Error('settings refresh failed');
            });
            client.onConnectedServicesProjection(async () => {});
            client.connect();

            await vi.waitFor(() => {
                expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
            });
            await new Promise((resolve) => setImmediate(resolve));

            expect(unhandledRejections).toEqual([]);
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }
    });

    it('refreshes account settings conservatively when the changes cursor is gone', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 410,
                    data: { error: 'cursor-gone', currentCursor: 9 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: { machine: { id: 'machine-1', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();
        publishPluginAccountCollectionWatchInvalidation.mockClear();

        writeAccountChangesCursor.mockImplementationOnce(async () => {
            expect(readPluginAccountAvailabilityChangeKey(resolveAccountSettingsScopeKeyForToken('token'), 'example.tasks')).toBe('9\u0000');
        });

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        client.onConnectedServicesProjection(async () => {});
        const onSessionFollowRulesChanged = vi.fn();
        client.onSessionFollowRulesChanged(onSessionFollowRulesChanged);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onSessionFollowRulesChanged).toHaveBeenCalledExactlyOnceWith({ full: true, workflowRunIds: [] });
        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: null,
            source: 'cursor-gone',
        });
        expect(publishPluginAccountCollectionWatchInvalidation).toHaveBeenCalledExactlyOnceWith({
            accountScopeKey: resolveAccountSettingsScopeKeyForToken('token'),
            kind: 'reset',
            changeCursor: 9,
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
    });

    it('applies a live permanent-removal witness before acknowledging its Account cursor without a Session detail read', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-live',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        let phase: 'initial' | 'live' = 'initial';
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return phase === 'initial'
                    ? {
                        status: 200,
                        data: {
                            changes: [],
                            nextCursor: 0,
                            sessionAccessWitness: { v: 1, throughCursor: 0, entries: [] },
                        },
                    }
                    : {
                        status: 200,
                        data: {
                            changes: [{
                                cursor: 7,
                                kind: 'session',
                                entityId: 'session-removed',
                                changedAt: 7,
                                hint: null,
                            }],
                            nextCursor: 7,
                            sessionAccessWitness: {
                                v: 1,
                                throughCursor: 7,
                                entries: [{
                                    sessionId: 'session-removed',
                                    cursor: 7,
                                    status: 'unavailable',
                                }],
                            },
                        },
                    };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});
        client.connect();
        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalled());
        socket.trigger('connect');
        await vi.waitFor(() => {
            expect(applyResourceSessionAccessWitness).toHaveBeenCalled();
        });
        await (client as unknown as {
            connectedServicesProjectionRetry: { waitForIdle(): Promise<void> };
        }).connectedServicesProjectionRetry.waitForIdle();
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();

        phase = 'live';
        writeAccountChangesCursor.mockClear();
        applyResourceSessionAccessWitness.mockClear();
        order.length = 0;
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        socket.trigger('update', {
            id: 'account-change-resource-session',
            seq: 7,
            createdAt: 7,
            body: { t: 'account-change' },
        });

        await vi.waitFor(() => {
            expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({
                accountId: 'acc-1',
                witness: {
                    v: 1,
                    throughCursor: 7,
                    entries: [{
                        sessionId: 'session-removed',
                        cursor: 7,
                        status: 'unavailable',
                    }],
                },
            });
        });
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/sessions/'))).toBe(false);
        expect(order).toEqual(['witness', 'cursor']);
        await client.shutdown();
    });

    it('forwards a page-saturated witness before acknowledging the cursor without enumerating Resource Sessions', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-page-limit',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        mockAccountGet(async (url: string, options) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                const after = options?.params && typeof options.params === 'object' && 'after' in options.params
                    ? Number(options.params.after) : 0;
                return {
                    status: 200,
                    data: {
                        changes: after === 0 ? Array.from({ length: 200 }, (_unused, index) => ({
                            cursor: index + 1,
                            kind: 'account',
                            entityId: 'self',
                            changedAt: index + 1,
                            hint: null,
                        })) : [],
                        nextCursor: 200,
                        sessionAccessWitness: { v: 1, throughCursor: 200, entries: [] },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(applyResourceSessionAccessWitness).toHaveBeenCalledTimes(2);
        expect(applyResourceSessionAccessWitness).toHaveBeenNthCalledWith(1, {
            accountId: 'acc-1',
            witness: { v: 1, throughCursor: 200, entries: [] },
        });
        expect(order).toEqual(['witness', 'witness', 'cursor']);
        await client.shutdown();
    });

    it('marks Session Resources unavailable before acknowledging a cursor-gone reset', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-cursor-gone',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return { status: 410, data: { error: 'cursor-gone', currentCursor: 11 } };
            }
            if (url.includes('/v1/machines/machine-resource-session-cursor-gone')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-resource-session-cursor-gone',
                            metadata: null,
                            metadataVersion: 0,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({ accountId: 'acc-1' });
        expect(order).toEqual(['witness', 'cursor']);
    });

    it('does not change Session Resource access for a malformed cursor-gone response', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-malformed-cursor-gone',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const applyResourceSessionAccessWitness = vi.fn();
        axiosGet.mockClear();
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) return { status: 410, data: { error: 'not-cursor-gone' } };
            if (url.includes('/v1/machines/machine-resource-session-malformed-cursor-gone')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-resource-session-malformed-cursor-gone',
                            metadata: null,
                            metadataVersion: 0,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        readAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockResolvedValueOnce(17);
        writeAccountChangesCursor.mockClear();
        publishPluginAccountSettingsWatchInvalidation.mockClear();
        publishPluginAccountCollectionWatchInvalidation.mockClear();
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        let failure: unknown = null;
        try {
            await (client as any).syncChangesOnConnect({ reason: 'connect' });
        } catch (error) {
            failure = error;
        }

        expect(applyResourceSessionAccessWitness).not.toHaveBeenCalled();
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/'))).toBe(false);
        expect(publishPluginAccountSettingsWatchInvalidation).not.toHaveBeenCalled();
        expect(publishPluginAccountCollectionWatchInvalidation).not.toHaveBeenCalled();
        // A zero write deletes the prior persisted cursor entry.
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        expect(failure).toBeInstanceOf(Error);
    });

    it('delivers only the durable Session-deletion hint before acknowledging its Account cursor', async () => {
        const machine: Machine = {
            id: 'machine-session-deletion-change',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const order: string[] = [];
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'account-a' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            {
                                cursor: 11,
                                kind: 'session',
                                entityId: 'session-revoked',
                                changedAt: 1,
                                hint: null,
                            },
                            {
                                cursor: 12,
                                kind: 'session',
                                entityId: 'session-deleted',
                                changedAt: 2,
                                hint: { v: 1, lifecycle: 'deleted' },
                            },
                        ],
                        nextCursor: 12,
                        sessionAccessWitness: {
                            v: 1,
                            throughCursor: 12,
                            entries: [
                                { sessionId: 'session-revoked', cursor: 11, status: 'unavailable' },
                                { sessionId: 'session-deleted', cursor: 12, status: 'unavailable' },
                            ],
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        // The deletion notification must pin the authenticated Account whose
        // changes feed delivered the fact, so use a token with a decodable
        // subject.
        const encodeJwtPart = (value: unknown): string =>
            Buffer.from(JSON.stringify(value)).toString('base64url');
        const deletionAccountToken = `${encodeJwtPart({ alg: 'none' })}.${encodeJwtPart({ sub: 'account-deletion-a' })}.`;
        admitAccountSnapshot(deletionAccountToken);
        const client = new ApiMachineClient(deletionAccountToken, machine);
        client.onConnectedServicesProjection(async () => {});
        const deleted = vi.fn(async () => {
            order.push('deleted');
        });
        client.onSessionDeletedChange(deleted);
        const revoked = vi.fn(async () => {});
        client.onSessionAccessRevoked(revoked);
        const changed: unknown[] = [];
        client.onSessionChanged(async change => { changed.push(change); });

        await (client as any).syncChangesOnConnect({ reason: 'connect' });

        expect(deleted).toHaveBeenCalledExactlyOnceWith({
            sessionId: 'session-deleted',
            cursor: 12,
            accountScope: {
                activeServerDir: configuration.activeServerDir,
                accountSubject: 'account-deletion-a',
            },
        });
        expect(revoked).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-revoked', cursor: 11 });
        expect(changed).toEqual([
            { sessionId: 'session-revoked', cursor: 11, removed: true },
            { sessionId: 'session-deleted', cursor: 12, removed: true },
        ]);
        expect(order).toEqual(['deleted', 'cursor']);
    });

    it('delivers exact changed Session ids before cursor acknowledgement and retains failed Follow wake work', async () => {
        const machine: Machine = { id: 'machine-follow-changes', encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'account-follow-changes' } };
            if (url.includes('/v2/changes')) return { status: 200, data: {
                changes: [{ cursor: 12, kind: 'session', entityId: 'follow-destination', changedAt: 2, hint: null },
                    { cursor: 13, kind: 'artifact', entityId: 'unrelated-artifact', changedAt: 3, hint: null },
                    { cursor: 14, kind: 'session', entityId: 'other-destination', changedAt: 4, hint: { pendingVersion: 0 } },
                    { cursor: 15, kind: 'account', entityId: buildSessionFollowReceiverChangeEntityIdV1('follow-destination'), changedAt: 5, hint: null }],
                nextCursor: 15,
                sessionAccessWitness: { v: 1, throughCursor: 15,
                    entries: [{ sessionId: 'follow-destination', cursor: 12, status: 'available' },
                        { sessionId: 'other-destination', cursor: 14, status: 'available' }] },
            } };
            throw new Error(`unexpected url: ${url}`);
        });
        const order: string[] = [];
        const changed: unknown[] = [];
        const followChanges: unknown[] = [];
        let unavailable = true;
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => { order.push('cursor'); });
        const client = new ApiMachineClient('fake-token', machine);
        client.onConnectedServicesProjection(async () => {});
        client.onSessionFollowRulesChanged(async change => { followChanges.push(change); });
        admitAccountSnapshot('fake-token');
        const dispose = client.onSessionChanged(async change => {
            if (unavailable) throw new Error('follow_read_temporarily_unavailable');
            changed.push(change); order.push('changed');
        });
        const sync = () => (client as unknown as { syncChangesOnConnect: (opts: { reason: 'live' }) => Promise<void> })
            .syncChangesOnConnect({ reason: 'live' });
        try {
            await expect(sync()).rejects.toThrow('follow_read_temporarily_unavailable');
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            unavailable = false;
            await sync();
            expect(changed).toEqual([{ sessionId: 'follow-destination', cursor: 12 },
                { sessionId: 'other-destination', cursor: 14 }]);
            expect(order).toEqual(['changed', 'changed', 'cursor']);
            expect(followChanges).toContainEqual({ full: false, workflowRunIds: [], discussionIds: [],
                receiverSessionIds: ['follow-destination'] });
        } finally { dispose(); await client.shutdown(); }
    });

    it('delivers same-sequence transcript revisions before acknowledging the Account cursor', async () => {
        const machine: Machine = { id: 'machine-memory-revision', encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'account-memory-revision' } };
            if (url.includes('/v2/changes')) return { status: 200, data: {
                changes: [{ cursor: 12, kind: 'session', entityId: 'session-edited', changedAt: 2,
                    hint: { updatedMessageSeq: 8, updatedMessageId: 'message-edited' } },
                    { cursor: 13, kind: 'session', entityId: 'session-coalesced', changedAt: 3,
                        hint: { lastMessageSeq: 9 } }], nextCursor: 13,
                sessionAccessWitness: { v: 1, throughCursor: 13,
                    entries: [{ sessionId: 'session-edited', cursor: 12, status: 'available' },
                        { sessionId: 'session-coalesced', cursor: 13, status: 'available' }] },
            } };
            throw new Error(`unexpected url: ${url}`);
        });
        const order: string[] = [];
        const revisions: unknown[] = [];
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => { order.push('cursor'); });
        const client = new ApiMachineClient('fake-token', machine);
        client.onConnectedServicesProjection(async () => {});
        admitAccountSnapshot('fake-token');
        const dispose = client.onSessionTranscriptRevised(async change => {
            revisions.push(change); order.push('revision');
        });
        try {
            await (client as unknown as { syncChangesOnConnect: (opts: { reason: 'live' }) => Promise<void> })
                .syncChangesOnConnect({ reason: 'live' });
            expect(revisions).toEqual([{ sessionId: 'session-edited', seq: 8, messageId: 'message-edited', cursor: 12 },
                { sessionId: 'session-coalesced', seq: 9, cursor: 13 }]);
            expect(order).toEqual(['revision', 'revision', 'cursor']);
        } finally { dispose(); await client.shutdown(); }
    });

    it('retains the Account cursor when authoritative Session cleanup is deferred', async () => {
        vi.useFakeTimers();
        const machine: Machine = {
            id: 'machine-session-deletion-deferred',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'account-a' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 12,
                            kind: 'session',
                            entityId: 'session-deleted',
                            changedAt: 2,
                            hint: { v: 1, lifecycle: 'deleted' },
                        }],
                        nextCursor: 12,
                        sessionAccessWitness: {
                            v: 1,
                            throughCursor: 12,
                            entries: [{ sessionId: 'session-deleted', cursor: 12, status: 'unavailable' }],
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        // Same contract as the notification-shape test: the sync derives the
        // delivering Account's operation scope from its own token.
        const encodeJwtPart = (value: unknown): string =>
            Buffer.from(JSON.stringify(value)).toString('base64url');
        const cleanupAccountToken = `${encodeJwtPart({ alg: 'none' })}.${encodeJwtPart({ sub: 'account-deletion-a' })}.`;
        admitAccountSnapshot(cleanupAccountToken);
        const client = new ApiMachineClient(cleanupAccountToken, machine);
        client.onConnectedServicesProjection(async () => {});
        const cleanup = vi.fn()
            .mockRejectedValueOnce(new Error('operation claim active'))
            .mockResolvedValueOnce(undefined);
        client.onSessionDeletedChange(cleanup);

        try {
            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(2_000);
            await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
            expect(writeAccountChangesCursor).toHaveBeenCalledExactlyOnceWith(
                'account-a',
                12,
            );
        } finally {
            await client.shutdown();
            vi.useRealTimers();
        }
    });

    it('applies an empty first Account-lifetime witness before acknowledging its cursor', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-account-transition',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'account-b' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [],
                        nextCursor: 12,
                        sessionAccessWitness: { v: 1, throughCursor: 12, entries: [] },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        admitAccountSnapshot('account-b-token');
        const client = new ApiMachineClient('account-b-token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'connect' });

        expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({
            accountId: 'account-b',
            witness: { v: 1, throughCursor: 12, entries: [] },
        });
        expect(order).toEqual(['witness', 'cursor']);
    });

    it('retries a transient /v2/changes response without changing Session Resource access before proof arrives', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-resource-session-transient',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            const order: string[] = [];
            const applyResourceSessionAccessWitness = vi.fn(() => {
                order.push('witness');
            });
            let changesAttempts = 0;
            mockAccountGet(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    return {
                        status: 200,
                        data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
                    };
                }
                if (url.includes('/v2/changes')) {
                    changesAttempts += 1;
                    return changesAttempts === 1
                        ? { status: 503, data: { error: 'busy' } }
                        : {
                            status: 200,
                            data: {
                                changes: [{
                                    cursor: 1,
                                    kind: 'session',
                                    entityId: 'session-removed',
                                    changedAt: 1,
                                    hint: null,
                                }],
                                nextCursor: 1,
                                sessionAccessWitness: {
                                    v: 1,
                                    throughCursor: 1,
                                    entries: [{
                                        sessionId: 'session-removed',
                                        cursor: 1,
                                        status: 'unavailable',
                                    }],
                                },
                            },
                        };
                }
                if (url.includes('/v1/machines/machine-resource-session-transient')) {
                    return {
                        status: 200,
                        data: {
                            machine: {
                                id: 'machine-resource-session-transient',
                                metadata: null,
                                metadataVersion: 0,
                                daemonState: null,
                                daemonStateVersion: 0,
                            },
                        },
                    };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            writeAccountChangesCursor.mockClear();
            writeAccountChangesCursor.mockImplementation(async () => {
                order.push('cursor');
            });
            const client = new ApiMachineClient('token', machine, undefined, {
                resourceSessionLifecycle: {
                    applyResourceSessionAccessWitness,
                },
            });
            client.onConnectedServicesProjection(async () => {});

            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await vi.waitFor(() => expect(changesAttempts).toBe(1));

            expect(applyResourceSessionAccessWitness).not.toHaveBeenCalled();
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(2_000);
            await vi.waitFor(() => expect(changesAttempts).toBe(2));

            expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({
                accountId: 'acc-1',
                witness: {
                    v: 1,
                    throughCursor: 1,
                    entries: [{
                        sessionId: 'session-removed',
                        cursor: 1,
                        status: 'unavailable',
                    }],
                },
            });
            expect(order).toEqual(['witness', 'cursor']);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([401, 403] as const)(
        'reports changes-feed auth status %i without changing Session Resource access, cursor advance, or retry',
        async (status) => {
            vi.useFakeTimers();
            let client: ApiMachineClient | null = null;
            try {
                const machine: Machine = {
                    id: 'machine-resource-session-detail-auth',
                    encryptionKey: new Uint8Array(32).fill(7),
                    encryptionVariant: 'legacy',
                    metadata: null,
                    metadataVersion: 0,
                    daemonState: null,
                    daemonStateVersion: 0,
                };
                const applyResourceSessionAccessWitness = vi.fn();
                let changesAttempts = 0;
                mockAccountGet(async (url: string) => {
                    if (url.includes('/v1/account/profile')) {
                        return {
                            status: 200,
                            data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
                        };
                    }
                    if (url.includes('/v2/changes')) {
                        changesAttempts += 1;
                        return {
                            status,
                            data: { error: 'not-authenticated' },
                        };
                    }
                    throw new Error(`unexpected url: ${url}`);
                });
                writeAccountChangesCursor.mockClear();
                const reportProbeResult = vi.fn();
                client = new ApiMachineClient('token', machine, undefined, {
                    resourceSessionLifecycle: {
                        applyResourceSessionAccessWitness,
                    },
                });
                client.onConnectedServicesProjection(async () => {});
                Object.defineProperty(client, 'connectionSupervisor', {
                    configurable: true,
                    value: {
                        getState: () => ({
                            phase: 'online',
                            reason: null,
                            attempt: 0,
                            nextRetryAt: null,
                            lastConnectedAt: Date.now(),
                            lastDisconnectedAt: null,
                            lastErrorMessage: null,
                        }),
                        reportProbeResult,
                        stop: vi.fn(async () => {}),
                    },
                });

                (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
                await vi.advanceTimersByTimeAsync(0);

                expect(reportProbeResult).toHaveBeenCalledWith({
                    status: 'auth_failed',
                    statusCode: status,
                    errorMessage: `Authentication failed while fetching changes (${status})`,
                } satisfies ReadinessProbeResult);
                expect(applyResourceSessionAccessWitness).not.toHaveBeenCalled();
                expect(writeAccountChangesCursor).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(2_000);
                expect(changesAttempts).toBe(1);
                expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
            } finally {
                await client?.shutdown();
                vi.useRealTimers();
            }
        },
    );

    it('advances a cursor-gone cursor when conservative account settings refresh fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 410,
                    data: { error: 'cursor-gone', currentCursor: 9 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: { machine: { id: 'machine-1', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(async () => {
            throw new Error('settings refresh failed');
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
    });

    it('refreshes machine snapshot when /v2/changes is missing while disabling only Session Resource access', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const encryptedMetadata = encodeBase64(
            encrypt(machine.encryptionKey, machine.encryptionVariant, {
                host: 'h',
                platform: 'p',
                happyCliVersion: 'v',
                homeDir: '/home',
                happyHomeDir: '/happy',
                happyLibDir: '/lib',
            }),
        );

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 404,
                    data: { error: 'not-found' },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-1',
                            metadata: encryptedMetadata,
                            metadataVersion: 2,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const applyResourceSessionAccessWitness = vi.fn();
        const api = await ApiClient.create({ token: 'token', encryption: { type: 'legacy', secret: machine.encryptionKey } });
        const client = api.machineSyncClient(machine, undefined, { resourceSessionLifecycle: { applyResourceSessionAccessWitness } });
        client.onConnectedServicesProjection(async () => {});
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadata: { host: 'h', platform: 'p' } });
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({ accountId: 'acc-1' });
    });

    it.each([401, 403] as const)('reports /v2/changes auth status %i to the machine supervisor without snapshot fallback', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('reports profile auth status %i to the machine supervisor before /v2/changes sync', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v2/changes'))).toBe(false);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('reports a scheduled profile auth failure once without cursor advancement or retry spin', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockResolvedValue({ status: 401, data: { error: 'not-authenticated' } });
            axiosGet.mockClear();
            writeAccountChangesCursor.mockClear();
            const reportProbeResult = vi.fn();
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(async () => {});
            Object.defineProperty(client, 'connectionSupervisor', {
                configurable: true,
                value: {
                    getState: () => ({
                        phase: 'online',
                        reason: null,
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: Date.now(),
                        lastDisconnectedAt: null,
                        lastErrorMessage: null,
                    }),
                    reportProbeResult,
                    stop: vi.fn(async () => {}),
                },
            });

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await (client as any).connectedServicesProjectionRetry.waitForIdle();
            await vi.advanceTimersByTimeAsync(60_000);

            expect(reportProbeResult).toHaveBeenCalledOnce();
            expect(axiosGet).toHaveBeenCalledOnce();
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([401, 403] as const)('throws /v2/changes auth status %i without a machine supervisor instead of snapshot fallback', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: null,
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' })).rejects.toMatchObject({
            code: 'not_authenticated',
            response: { status },
        });

        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('reports machine snapshot refresh auth status %i to the machine supervisor', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            throw createHttpStatusError(status, 'Machine authentication failed');
        });
        axiosGet.mockClear();

        const client = await createRefreshingMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).refreshMachineFromServer();

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
    });

    it('redacts axios machine snapshot refresh failures before logging', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const failure = {
            isAxiosError: true,
            name: 'AxiosError',
            message: 'socket hang up',
            code: 'ECONNRESET',
            config: {
                method: 'get',
                url: 'http://localhost:3005/v1/machines/machine-1?token=secret#hash',
                headers: { Authorization: 'Bearer fake-token' },
                data: { encryptionKeyBase64: 'super-secret-key' },
            },
        };
        mockAccountGet(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            throw failure;
        });
        axiosGet.mockClear();
        const debug = vi.mocked(logger.debug);
        debug.mockClear();

        const client = await createRefreshingMachineClient('fake-token', machine);
        await (client as any).refreshMachineFromServer();

        const logged = JSON.stringify(debug.mock.calls);
        expect(logged).not.toContain('fake-token');
        expect(logged).not.toContain('Authorization');
        expect(logged).not.toContain('token=secret');
        expect(logged).not.toContain('super-secret-key');
    });

    it('keeps retryable machine snapshot refresh failures local to the HTTP request', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        mockAccountGet(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            throw createHttpStatusError(503, 'Machine snapshot busy');
        });
        axiosGet.mockClear();

        const client = await createRefreshingMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        const probeScope = { generation: 1 };
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                captureProbeReportScope: () => probeScope,
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        axiosGet.mockClear();
        await (client as any).refreshMachineFromServer();

        expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v1/machines/machine-1'), expect.anything());
        expect(reportProbeResult).not.toHaveBeenCalled();
    });

    it('catches up the existing AccountChange cursor after a live content-free wake', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        let phase: 'initial' | 'live' = 'initial';
        mockAccountGet(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                if (phase === 'initial') {
                    return { status: 200, data: { changes: [], nextCursor: 0 } };
                }
                return {
                    status: 200,
                    data: {
                        changes: [
                            {
                                cursor: 6,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/settings',
                                changedAt: 6,
                                hint: {
                                    pluginDomain: 'settings',
                                    pluginId: 'example.tasks',
                                    scope: 'account',
                                    revision: 11,
                                },
                            },
                            {
                                cursor: 8,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                                changedAt: 8,
                                hint: {
                                    pluginDomain: 'dataCollection',
                                    pluginId: 'example.tasks',
                                    collectionId: 'tasks',
                                    contractDigest: 'a'.repeat(43),
                                    revision: 4,
                                    full: true,
                                },
                            },
                            {
                                cursor: 9,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/availability',
                                changedAt: 9,
                                hint: {
                                    pluginDomain: 'availability',
                                    pluginId: 'example.tasks',
                                },
                            },
                        ],
                        nextCursor: 9,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        client.connect();
        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalled());
        socket.trigger('connect');
        await vi.waitFor(() => {
            expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v2/changes'))).toBe(true);
        });
        await (client as unknown as {
            connectedServicesProjectionRetry: { waitForIdle(): Promise<void> };
        }).connectedServicesProjectionRetry.waitForIdle();
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();

        phase = 'live';
        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        publishPluginAccountSettingsWatchInvalidation.mockClear();
        publishPluginAccountCollectionWatchInvalidation.mockClear();
        socket.trigger('update', {
            id: 'account-change-9',
            seq: 9,
            createdAt: 9,
            body: { t: 'account-change' },
        });

        await vi.waitFor(() => {
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
        });
        expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
        expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledWith({
            kind: 'record',
            pluginId: 'example.tasks',
            revision: 11,
        });
        expect(publishPluginAccountCollectionWatchInvalidation).toHaveBeenCalledWith({
            accountScopeKey: resolveAccountSettingsScopeKeyForToken('token'),
            kind: 'collection',
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: 'a'.repeat(43),
            changeCursor: 8,
            full: true,
        });
        expect(readPluginAccountAvailabilityChangeKey(resolveAccountSettingsScopeKeyForToken('token'), 'example.tasks')).toBe('\u00009');
        await client.shutdown();
    });

    it('retires Collection watch retention only when the ApiMachine Account lifetime shuts down', async () => {
        const machine: Machine = {
            id: 'machine-collection-watch-retirement',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const accountScopeKey = resolveAccountSettingsScopeKeyForToken('account-token-retirement');
        publishCollectionChange({ accountScopeKey, kind: 'reset', changeCursor: 9 });
        expect(readPluginAccountAvailabilityChangeKey(accountScopeKey, 'example.tasks')).toBe('9\u0000');
        const client = new ApiMachineClient('account-token-retirement', machine);

        await client.shutdown();

        expect(readPluginAccountAvailabilityChangeKey(accountScopeKey, 'example.tasks')).toBe('\u0000');
    });

    it('routes durable session-access revocations to listeners before acknowledging the Account cursor', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => (
            url.endsWith('/v1/account/profile')
                ? { status: 200, data: { id: 'account-1' } }
                : {
                    status: 200,
                    data: {
                        changes: [],
                        nextCursor: 12,
                        sessionAccessWitness: {
                            v: 1,
                            throughCursor: 12,
                            entries: [
                                { sessionId: 'revoked-1', cursor: 11, status: 'unavailable' },
                                { sessionId: 'kept-1', cursor: 12, status: 'available' },
                            ],
                        },
                    },
                }
        ));
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const observed: string[] = [];
        client.onSessionAccessRevoked(async (change) => {
            observed.push(change.sessionId);
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(observed).toEqual(['revoked-1']);
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('account-1', 12);
    });

    it('retains the Account cursor when a session-access revocation listener fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => (
            url.endsWith('/v1/account/profile')
                ? { status: 200, data: { id: 'account-1' } }
                : {
                    status: 200,
                    data: {
                        changes: [],
                        nextCursor: 12,
                        sessionAccessWitness: {
                            v: 1,
                            throughCursor: 12,
                            entries: [{ sessionId: 'revoked-1', cursor: 11, status: 'unavailable' }],
                        },
                    },
                }
        ));
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        client.onSessionAccessRevoked(async () => {
            throw new Error('purge_failed');
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' })).rejects.toThrow('purge_failed');
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('reconciles retained Session access before acknowledging a cursor-gone reset', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
            if (url.includes('/v2/changes')) {
                return { status: 410, data: { error: 'cursor-gone', currentCursor: 42 } };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return { status: 200, data: { machine: { ...machine, active: true } } };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const reconciled: number[] = [];
        client.onSessionAccessReset(async ({ cursor }) => {
            reconciled.push(cursor);
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reconciled).toEqual([42]);
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('account-1', 42);
    });

    it('retains the prior cursor when cursor-gone Session access reconciliation fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        mockAccountGet(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
            if (url.includes('/v2/changes')) {
                return { status: 410, data: { error: 'cursor-gone', currentCursor: 42 } };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return { status: 200, data: { machine: { ...machine, active: true } } };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        client.onSessionAccessReset(async () => {
            throw new Error('retained_session_reconciliation_failed');
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' }))
            .rejects.toThrow('retained_session_reconciliation_failed');
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });
});
