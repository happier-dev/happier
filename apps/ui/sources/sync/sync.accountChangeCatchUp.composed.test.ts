import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryRequestV1,
} from '@happier-dev/protocol';
import {
    PluginAvailabilityActionHttpPathsV1,
} from '@happier-dev/protocol/plugins/availability';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ChangesCursorScope } from '@/sync/domains/state/persistence';

import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';

const ACCOUNT_ID = 'account-a';
const ACCOUNT_TOKEN = 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig';
const DATA_PLUGIN_ID = 'example.tasks';
const SETTINGS_PLUGIN_ID = 'example.settings';
const AVAILABILITY_PLUGIN_ID = 'example.availability';

// Test-only narrow harness for the private canonical catch-up owner.
type SyncAccountChangeCatchUpHarness = {
    credentials: AuthCredentials | null;
    serverID: string | null;
    changesCursor: string | null;
    getChangesCursorScope(): ChangesCursorScope | null;
    resumeViaChanges(options: { accountId: string; shouldContinue?: () => boolean }): Promise<unknown>;
    pluginAvailabilitySync: {
        awaitQueue(options?: { timeoutMs?: number }): Promise<void>;
    };
    disconnectServer(): void;
};

type ResumeSyncUnit = {
    invalidateCoalesced(): void;
    awaitQueue(options?: { timeoutMs?: number }): Promise<void>;
};

type SyncAccountChangeWakeSchedulingHarness = SyncAccountChangeCatchUpHarness & {
    isForeground: boolean;
    resumeInFlight: Promise<void> | null;
    purchasesSync: ResumeSyncUnit;
    pushTokenSync: ResumeSyncUnit;
    nativeUpdateSync: ResumeSyncUnit;
    sessionsSync: ResumeSyncUnit;
    machinesSync: ResumeSyncUnit;
    rearmPendingOutboxForActiveScope(): Promise<void>;
    resumeViaChanges(options: { accountId: string; shouldContinue?: () => boolean }): Promise<unknown>;
    catchUpLoadedExternalSessionsOnResume(): Promise<void>;
    resumeSync(reason: 'app-foreground' | 'socket-reconnect' | 'account-change' | 'manual' | 'server-reachable'): Promise<void>;
    handleUpdate(update: unknown): Promise<void>;
};

const descriptor: NormalizedPluginCollectionUiQueryDescriptorV1 = {
    collection: { pluginId: DATA_PLUGIN_ID, collectionId: 'tasks' },
    id: 'open',
    indexId: 'by-status',
    parameters: {
        status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
    },
    prefix: [{ kind: 'parameter', parameterId: 'status' }],
    order: 'asc',
    pageSize: 50,
    projectedFields: [
        { field: 'status', kind: 'string' },
        { field: 'title', kind: 'string' },
    ],
};

const queryRequest: PluginCollectionUiQueryRequestV1 = {
    pluginId: DATA_PLUGIN_ID,
    collectionId: 'tasks',
    uiQueryId: 'open',
    parameters: { status: 'open' },
};

// Sync imports persistence, which instantiates MMKV. Mock the device boundary.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: apiRequest,
    },
}));

const runtimeFetchWithServerReachability = vi.hoisted(() =>
    vi.fn<(params: { url: string }) => Promise<Response>>(),
);
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability,
}));

const fetchChanges = vi.hoisted(() => vi.fn());
vi.mock('./api/session/apiChanges', () => ({
    fetchChanges,
    fetchCurrentChangesCursor: vi.fn(async () => ({ status: 'ok' as const, cursor: '0' })),
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function collectionResponse(title: string, changeCursor: number): Response {
    return jsonResponse({
        rows: [{
            context: {
                collection: { pluginId: DATA_PLUGIN_ID, collectionId: 'tasks' },
                rowId: 'task-1',
                revision: changeCursor,
            },
            fields: { status: 'open', title },
        }],
        changeCursor,
    });
}

function availabilityMaterializationsResponse(): Response {
    return jsonResponse({
        availabilityCursor: 9,
        snapshots: [],
    });
}

function availabilityIntentDiscoveryResponse(): Response {
    return jsonResponse({
        availabilityCursor: 9,
        pluginIds: [AVAILABILITY_PLUGIN_ID],
    });
}

function availabilityIntentResponse(pluginId: string): Response {
    return jsonResponse({
        availabilityCursor: 9,
        hostingCapability: { enabled: false },
        intent: {
            pluginId,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'disabled',
            writableCollections: [],
            revision: '1',
        },
        release: null,
        uiArtifacts: [],
    });
}

function currentAccountStoredContentCompatibilityFeaturesResponse(): Response {
    return jsonResponse({
        features: {},
        capabilities: {
            accountStoredContentCompatibility: {
                v: 1,
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        },
    });
}

async function prepareAccountChangeWakeSchedulingHarness(): Promise<SyncAccountChangeWakeSchedulingHarness> {
    const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { storage } = await import('./domains/state/storage');
    const { sync } = await import('./sync');

    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
    storage.getState().activateProfileScope({ serverId, accountId: ACCOUNT_ID });
    storage.setState((state) => ({
        ...state,
        profile: { ...(state.profile ?? {}), id: ACCOUNT_ID },
    }), true);

    const harness = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
    harness.credentials = { token: ACCOUNT_TOKEN };
    harness.serverID = ACCOUNT_ID;
    harness.isForeground = true;
    harness.resumeInFlight = null;
    return harness;
}

function accountChangeWake(id: string): Readonly<{
    id: string;
    seq: number;
    createdAt: number;
    body: { t: 'account-change' };
}> {
    return {
        id,
        seq: 9,
        createdAt: 9,
        body: { t: 'account-change' },
    };
}

describe('sync AccountChange catch-up projection', () => {
    let localStorage: LocalStorageMockHandle | null = null;

    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        localStorage = installLocalStorageMock();
        apiRequest.mockReset();
        runtimeFetchWithServerReachability.mockReset();
        fetchChanges.mockReset();
    });

    afterEach(() => {
        localStorage?.restore();
        localStorage = null;
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('projects one V3 AccountChange catch-up page through the existing Data, Settings, and Availability owners', async () => {
        let dataReadCount = 0;
        runtimeFetchWithServerReachability.mockImplementation(async ({ url }: { url: string }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features') {
                return currentAccountStoredContentCompatibilityFeaturesResponse();
            }
            if (path === '/v1/plugins/data/ui-query') {
                dataReadCount += 1;
                return collectionResponse(
                    dataReadCount === 1 ? 'before AccountChange' : 'after AccountChange',
                    dataReadCount,
                );
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return availabilityMaterializationsResponse();
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return availabilityIntentDiscoveryResponse();
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
                return availabilityIntentResponse(AVAILABILITY_PLUGIN_ID);
            }
            return jsonResponse({});
        });
        fetchChanges.mockResolvedValue({
            status: 'ok',
            changes: [
                {
                    cursor: 5,
                    kind: 'account',
                    entityId: 'self',
                    changedAt: 5,
                    hint: null,
                },
                {
                    cursor: 6,
                    kind: 'pluginDomain',
                    entityId: `pluginDomain/${SETTINGS_PLUGIN_ID}/settings`,
                    changedAt: 6,
                    hint: {
                        pluginDomain: 'settings',
                        pluginId: SETTINGS_PLUGIN_ID,
                        scope: 'account',
                        revision: 1,
                    },
                },
                {
                    cursor: 8,
                    kind: 'pluginDomain',
                    entityId: `pluginDomain/${DATA_PLUGIN_ID}/data-collection/tasks`,
                    changedAt: 8,
                    hint: {
                        pluginDomain: 'dataCollection',
                        pluginId: DATA_PLUGIN_ID,
                        collectionId: 'tasks',
                        contractDigest: 'a'.repeat(43),
                        revision: 1,
                        full: true,
                    },
                },
                {
                    cursor: 9,
                    kind: 'pluginDomain',
                    entityId: `pluginDomain/${AVAILABILITY_PLUGIN_ID}/availability`,
                    changedAt: 9,
                    hint: {
                        pluginDomain: 'availability',
                        pluginId: AVAILABILITY_PLUGIN_ID,
                    },
                },
            ],
            nextCursor: '9',
        });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const { recordAccountStoredContentServerRequirements } = await import(
            './http/accountStoredContentCompatibility'
        );
        const { captureActiveServerAccountScopeLifetime } = await import(
            '@/sync/domains/scope/activeServerAccountScope'
        );
        const {
            createActivePluginCollectionUiQueryPager,
        } = await import('./api/plugins/data/queryPluginCollectionUiQuery');
        const {
            watchActiveScopedPluginSettingsChanges,
        } = await import('./domains/plugins/settings/scopedPluginSettingsChangeWatch');
        const {
            subscribeAccountEncryptionModeCacheInvalidation,
        } = await import('./api/account/apiAccountEncryptionMode');
        const { sync } = await import('./sync');
        const syncHarness = sync as unknown as SyncAccountChangeCatchUpHarness;

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        storage.getState().activateProfileScope({ serverId, accountId: ACCOUNT_ID });
        storage.setState((state) => ({
            ...state,
            profile: { ...(state.profile ?? {}), id: ACCOUNT_ID },
        }), true);
        await expect(TokenStorage.setCredentials({ token: ACCOUNT_TOKEN })).resolves.toBe(true);
        recordAccountStoredContentServerRequirements({
            serverUrl: getActiveServerSnapshot().serverUrl,
            requirements: {
                v: 1,
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });

        syncHarness.credentials = { token: ACCOUNT_TOKEN };
        syncHarness.serverID = ACCOUNT_ID;
        syncHarness.changesCursor = '0';
        const cursorScope = syncHarness.getChangesCursorScope();
        expect(cursorScope).not.toBeNull();

        const pager = createActivePluginCollectionUiQueryPager({ descriptor, request: queryRequest });
        await pager.refresh();
        expect(pager.getSnapshot()).toMatchObject({
            status: 'ready',
            rows: [{ fields: { title: 'before AccountChange' } }],
        });

        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        const onSettingsInvalidated = vi.fn();
        const onAccountEncryptionModeInvalidated = vi.fn();
        const accountEncryptionModeInvalidation = subscribeAccountEncryptionModeCacheInvalidation(
            onAccountEncryptionModeInvalidated,
        );
        const settingsWatch = watchActiveScopedPluginSettingsChanges({
            pluginId: SETTINGS_PLUGIN_ID,
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            lifetime: lifetime!,
            onInvalidated: onSettingsInvalidated,
        });
        const pagerRefreshed = new Promise<void>((resolve) => {
            const subscription = pager.subscribe(() => {
                if (pager.getSnapshot().status !== 'ready') return;
                if (pager.getSnapshot().rows[0]?.fields.title !== 'after AccountChange') return;
                subscription();
                resolve();
            });
        });

        await expect(syncHarness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
            status: 'ok',
        });
        await pagerRefreshed;
        await syncHarness.pluginAvailabilitySync.awaitQueue({ timeoutMs: 2_000 });

        expect(syncHarness.changesCursor).toBe('9');
        expect(loadChangesCursor(cursorScope)).toBe('9');
        expect(onSettingsInvalidated).toHaveBeenCalledOnce();
        expect(onAccountEncryptionModeInvalidated).toHaveBeenCalledOnce();
        expect(dataReadCount).toBe(2);
        expect(pager.getSnapshot()).toMatchObject({
            status: 'ready',
            rows: [{ fields: { title: 'after AccountChange' } }],
        });
        expect(runtimeFetchWithServerReachability.mock.calls.map(([params]) => new URL(params.url).pathname)).toEqual(expect.arrayContaining([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'],
        ]));

        accountEncryptionModeInvalidation();
        settingsWatch.dispose();
        pager.dispose();
        syncHarness.disconnectServer();
    }, 30_000);

    it('coalesces wakes received after a changes response into one trailing canonical catch-up', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const resumeUnit: ResumeSyncUnit = {
            invalidateCoalesced: vi.fn(),
            awaitQueue: vi.fn(async () => {}),
        };
        harness.purchasesSync = resumeUnit;
        harness.pushTokenSync = resumeUnit;
        harness.nativeUpdateSync = resumeUnit;
        harness.sessionsSync = resumeUnit;
        harness.machinesSync = resumeUnit;

        vi.spyOn(harness, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
        // The cursor owner has already completed; hold only the outer resume tail to
        // reproduce a wake delivered after /v2/changes responds but before cleanup.
        const resumeViaChanges = vi.spyOn(harness, 'resumeViaChanges').mockResolvedValue({
            status: 'ok',
            refreshedByCatchUp: { sessions: false, machines: false },
        });

        let releaseFirstResume!: () => void;
        const firstResumeFinished = new Promise<void>((resolve) => {
            releaseFirstResume = resolve;
        });
        let markFirstResumeFinalizing!: () => void;
        const firstResumeFinalizing = new Promise<void>((resolve) => {
            markFirstResumeFinalizing = resolve;
        });
        let catchUpCalls = 0;
        vi.spyOn(harness, 'catchUpLoadedExternalSessionsOnResume').mockImplementation(async () => {
            catchUpCalls += 1;
            if (catchUpCalls !== 1) return;
            markFirstResumeFinalizing();
            await firstResumeFinished;
        });

        const firstResume = harness.resumeSync('manual');
        await firstResumeFinalizing;
        expect(resumeViaChanges).toHaveBeenCalledTimes(1);

        await Promise.all([
            harness.handleUpdate(accountChangeWake('account-change-1')),
            harness.handleUpdate(accountChangeWake('account-change-2')),
            harness.handleUpdate(accountChangeWake('account-change-3')),
        ]);
        expect(resumeViaChanges).toHaveBeenCalledTimes(1);

        releaseFirstResume();
        await firstResume;
        await vi.waitFor(() => expect(harness.resumeInFlight).toBeNull());

        expect(resumeViaChanges).toHaveBeenCalledTimes(2);
    });

    it('drops a queued AccountChange wake when its server/account lifetime resets', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const resumeUnit: ResumeSyncUnit = {
            invalidateCoalesced: vi.fn(),
            awaitQueue: vi.fn(async () => {}),
        };
        harness.purchasesSync = resumeUnit;
        harness.pushTokenSync = resumeUnit;
        harness.nativeUpdateSync = resumeUnit;
        harness.sessionsSync = resumeUnit;
        harness.machinesSync = resumeUnit;

        vi.spyOn(harness, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
        // Keep the same post-catch-up window open, then retire the Account scope.
        const resumeViaChanges = vi.spyOn(harness, 'resumeViaChanges').mockResolvedValue({
            status: 'ok',
            refreshedByCatchUp: { sessions: false, machines: false },
        });

        let releaseFirstResume!: () => void;
        const firstResumeFinished = new Promise<void>((resolve) => {
            releaseFirstResume = resolve;
        });
        let markFirstResumeFinalizing!: () => void;
        const firstResumeFinalizing = new Promise<void>((resolve) => {
            markFirstResumeFinalizing = resolve;
        });
        vi.spyOn(harness, 'catchUpLoadedExternalSessionsOnResume').mockImplementation(async () => {
            markFirstResumeFinalizing();
            await firstResumeFinished;
        });

        const firstResume = harness.resumeSync('manual');
        await firstResumeFinalizing;
        await harness.handleUpdate(accountChangeWake('account-change-before-reset'));

        harness.disconnectServer();
        releaseFirstResume();
        await firstResume;
        await Promise.resolve();

        expect(resumeViaChanges).toHaveBeenCalledTimes(1);
        expect(harness.resumeInFlight).toBeNull();
    });
});
