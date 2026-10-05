import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    projectLegacySessionAccessCapabilitiesV1,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryRequestV1,
} from '@happier-dev/protocol';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ChangesCursorScope } from '@/sync/domains/state/persistence';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

import {
    installLocalStorageMock,
    installWebLockManagerMock,
    type LocalStorageMockHandle,
    type WebLockManagerMockHandle,
} from '@/auth/storage/tokenStorage.web.testHelpers';

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

type AwaitedInvalidationSyncUnit = {
    invalidateAndAwait(): Promise<void>;
};

type SyncAccountChangeWakeSchedulingHarness = SyncAccountChangeCatchUpHarness & {
    isForeground: boolean;
    resumeInFlight: Promise<void> | null;
    purchasesSync: ResumeSyncUnit;
    nativeUpdateSync: ResumeSyncUnit;
    sessionsSync: ResumeSyncUnit;
    machinesSync: ResumeSyncUnit;
    settingsSync: AwaitedInvalidationSyncUnit;
    profileSync: AwaitedInvalidationSyncUnit;
    rearmPendingOutboxForActiveScope(): Promise<void>;
    resumeViaChanges(options: { accountId: string; shouldContinue?: () => boolean }): Promise<unknown>;
    catchUpLoadedExternalSessionsOnResume(): Promise<void>;
    resumeSync(reason: 'app-foreground' | 'socket-reconnect' | 'changes-catch-up' | 'manual' | 'server-reachable'): Promise<void>;
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
    readerContext: {
        pluginId: DATA_PLUGIN_ID,
        collectionId: 'tasks',
        schemaVersion: 1,
        contractDigest: 'a'.repeat(43),
    },
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
        invalidateRequests: vi.fn(),
        disposeScopedAuthority: vi.fn(),
        getSessionScopedTarget: vi.fn(() => null),
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
vi.mock('./api/session/apiChanges', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./api/session/apiChanges')>();
    return {
        fetchChanges: (params: Parameters<typeof actual.fetchChanges>[0]) => params.request ? actual.fetchChanges(params) : fetchChanges(params),
        fetchCurrentChangesCursor: (params: Parameters<typeof actual.fetchCurrentChangesCursor>[0]) => params.request
            ? actual.fetchCurrentChangesCursor(params)
            : Promise.resolve({ status: 'ok' as const, cursor: '0' }),
    };
});

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
        packageAssets: [],
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
    const { sync } = await import('./syncEngine');

    await upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
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
    // The socket owner only handles wakes for the Home its transport is applied to.
    (harness as unknown as { appliedServerTarget: unknown }).appliedServerTarget = {
        serverId,
        serverUrl: 'http://localhost:53288',
        generation: 1,
    };
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
    let webLocks: WebLockManagerMockHandle | null = null;

    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        localStorage = installLocalStorageMock();
        webLocks = installWebLockManagerMock();
        apiRequest.mockReset();
        runtimeFetchWithServerReachability.mockReset();
        fetchChanges.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        localStorage?.restore();
        localStorage = null;
        webLocks?.restore();
        webLocks = null;
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('boots and renews the embed session with only its explicit child credential and session corridor', async () => {
        // The browser realm is a genuine boundary: capture its route before importing owners.
        vi.stubGlobal('window', { location: { pathname: '/embed/session/embed' }, localStorage: globalThis.localStorage,
            addEventListener: vi.fn(), removeEventListener: vi.fn() });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const storedCredentialRead = vi.spyOn(TokenStorage, 'getCredentials');
        const scopedCredentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const { sync } = await import('./syncEngine');
        const paths: string[] = [];
        const changesAfter: string[] = [];
        let expectedToken = 'hap_v1_child';
        let accessLevel: 'view' | 'edit' = 'view';
        let credentialRejected = false;
        const onCredentialRejected = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            paths.push(url.pathname);
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${expectedToken}`);
            if (url.pathname === '/v1/features/authenticated') return currentAccountStoredContentCompatibilityFeaturesResponse();
            if (url.pathname === '/v2/cursor') return credentialRejected
                ? new Response(null, { status: 401 }) : jsonResponse({ cursor: 8 });
            if (url.pathname === '/v2/changes') {
                expect(url.searchParams.get('sessionId')).toBe('embed');
                changesAfter.push(url.searchParams.get('after') ?? '');
                return jsonResponse({ changes: [], nextCursor: 9 });
            }
            if (url.pathname === '/v2/sessions/embed') return jsonResponse({ session: {
                id: 'embed', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                metadataVersion: 1, metadata: JSON.stringify({ path: '/hidden', host: 'hidden', name: 'Embedded' }),
                agentStateVersion: 0, agentState: null, share: null,
                responsibleAccountId: null, responsibleAccount: null,
                effectiveAccess: { v: 1, level: accessLevel, sources: [],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: accessLevel }) },
            } });
            if (url.pathname === '/v1/sessions/embed/turns') return jsonResponse({ v: 1, sessionId: 'embed', turns: [] });
            if (url.pathname === '/v1/sessions/embed/messages') return jsonResponse({ messages: [], nextAfterSeq: null });
            if (url.pathname === '/v2/sessions/embed/pending') return jsonResponse({ pending: [], pendingVersion: 0 });
            throw new Error(`Account request escaped embed: ${url.pathname}`);
        }));
        await sync.create({ token: 'hap_v1_child' }, null, undefined, {
            scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
            endpointUrl: 'http://localhost:53288', isCurrent: () => true, onCredentialRejected,
        });
        expect(paths).toContain('/v2/sessions/embed');
        expect(paths).toContain('/v1/sessions/embed/messages');
        expect(paths).toContain('/v2/sessions/embed/pending');
        expect(paths.every((path) => path.includes('/embed') || path === '/v2/cursor' || path === '/v1/features/authenticated')).toBe(true);
        expect(storedCredentialRead).not.toHaveBeenCalled();
        expect(scopedCredentialRead).not.toHaveBeenCalled();
        expect(apiRequest).not.toHaveBeenCalled();
        expect(kvStore.size).toBe(0);
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const state = (await import('@/sync/domains/state/storage')).storage;
        const retainedTranscriptBeforeRenewal = state.getState().sessionMessages.embed;
        const retainedTurnsBeforeRenewal = state.getState().sessions.embed?.sessionTurns;
        const initialContext = sync.getEmbedSessionRequestContext();
        paths.length = 0;
        expectedToken = 'hap_v1_renewed';
        accessLevel = 'edit';
        await sync.create({ token: expectedToken }, null, undefined, {
            scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
            endpointUrl: 'http://localhost:53288', isCurrent: () => true, onCredentialRejected,
        });
        expect(paths).toContain('/v2/sessions/embed');
        expect(paths).toContain('/v2/changes');
        expect(changesAfter).toEqual(['8']);
        expect(paths).not.toContain('/v1/features/authenticated');
        expect(paths).not.toContain('/v2/cursor');
        expect(paths).not.toContain('/v1/sessions/embed/turns');
        expect(paths).not.toContain('/v1/sessions/embed/messages');
        expect(state.getState().sessionMessages.embed).toBe(retainedTranscriptBeforeRenewal);
        expect(state.getState().sessions.embed?.sessionTurns).toBe(retainedTurnsBeforeRenewal);
        expect(state.getState().sessions.embed?.access?.capabilities.submitAgentInput).toBe(true);
        expect(vi.mocked(apiSocket.initialize).mock.calls.map(([configuration]) => configuration.token))
            .toEqual(['hap_v1_child', 'hap_v1_renewed']);
        await expect(initialContext!.request('/v2/sessions/embed')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        const onUpdate = vi.mocked(apiSocket.onMessage).mock.calls.find(([event]) => event === 'update')?.[1];
        const before = (await import('@/sync/domains/state/storage')).storage.getState().sessions.embed?.access;
        await onUpdate?.({ id: 'u', seq: 1, createdAt: 2, body: { t: 'update-session', id: 'embed',
            access: { role: 'owner', capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) } } }, { serverId: 'http://localhost:53288' });
        expect((await import('@/sync/domains/state/storage')).storage.getState().sessions.embed?.access).toEqual(before);
        const context = sync.getEmbedSessionRequestContext();
        expect(context).not.toBeNull();
        await expect(context!.request('/v2/sessions/another')).rejects.toThrow('outside the embed Session corridor');
        credentialRejected = true;
        expect((await context!.request('/v2/cursor')).status).toBe(401);
        expect(onCredentialRejected).toHaveBeenCalledOnce();
        const retainedSession = state.getState().sessions.embed;
        const retainedTranscript = state.getState().sessionMessages.embed;
        sync.disposeEmbedSession({ preserveSessionState: true });
        expect(state.getState().sessions.embed).toBe(retainedSession);
        expect(state.getState().sessionMessages.embed).toBe(retainedTranscript);
        await expect(context!.request('/v2/sessions/embed')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });

    it('projects one V3 AccountChange catch-up page through the existing Data, Settings, and Availability owners', async () => {
        const availabilityRefresh = createDeferred<void>();
        let dataReadCount = 0;
        runtimeFetchWithServerReachability.mockImplementation(async ({ url }: { url: string }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features') {
                return currentAccountStoredContentCompatibilityFeaturesResponse();
            }
            if (path === '/v1/account/saved-secrets/resources/materials') {
                return jsonResponse({ resources: [] });
            }
            if (path === '/v1/plugins/data/ui-query') {
                dataReadCount += 1;
                return collectionResponse(
                    dataReadCount === 1 ? 'before AccountChange' : 'after AccountChange',
                    dataReadCount,
                );
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                await availabilityRefresh.promise;
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

        await upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { switchConnectionToActiveServer } = await import('./runtime/orchestration/connectionManager');
        await switchConnectionToActiveServer();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        storage.getState().activateProfileScope({ serverId, accountId: ACCOUNT_ID });
        await storage.getState().activateSettingsScope({ serverId, accountId: ACCOUNT_ID });
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

        const {
            replacePluginAccountAvailabilityProjection,
            useActivePluginAccountAvailabilityReader,
        } = await import('./domains/plugins/availability/projection');
        const unaffectedPluginId = 'example.unaffected';
        replacePluginAccountAvailabilityProjection({
            scope: { serverId, accountId: ACCOUNT_ID },
            snapshot: {
                availabilityCursor: 8,
                intentReads: await Promise.all([AVAILABILITY_PLUGIN_ID, unaffectedPluginId].map(async (pluginId) => ({
                    pluginId,
                    response: PluginAvailabilityIntentReadActionOutputV1Schema.parse({
                        ...await availabilityIntentResponse(pluginId).json(),
                        availabilityCursor: 8,
                    }),
                }))),
                materializations: [],
                snapshots: [],
            },
        });
        const availabilityHook = await renderHook(useActivePluginAccountAvailabilityReader);
        const availabilityReader = availabilityHook.getCurrent();
        expect(availabilityReader?.readMaterializations()).toMatchObject({
            kind: 'available',
            intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID }, { pluginId: unaffectedPluginId }],
        });

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

        try {
            await act(async () => {
                await expect(syncHarness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
                    status: 'ok',
                });
            });
            // A named X hint retires X before refresh, without withdrawing Y.
            expect(availabilityReader?.readMaterializations()).toMatchObject({
                kind: 'available',
                intentReads: [{ pluginId: unaffectedPluginId }],
            });
        } finally {
            availabilityRefresh.resolve();
            await availabilityHook.unmount();
        }
        await pagerRefreshed;
        await syncHarness.pluginAvailabilitySync.awaitQueue({ timeoutMs: 2_000 });
        expect(availabilityReader?.readMaterializations()).toMatchObject({
            kind: 'available',
            availabilityCursor: 9,
            intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID }],
        });

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

    it('publishes a fetched AccountChange to the Home whose cursor was read when focus changes in flight', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { getActiveServerSnapshot, upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        harness.changesCursor = '0';
        harness.settingsSync = { invalidateAndAwait: vi.fn(async () => undefined) };
        harness.profileSync = { invalidateAndAwait: vi.fn(async () => undefined) };

        let releaseChanges!: () => void;
        const changesReleased = new Promise<void>((resolve) => {
            releaseChanges = resolve;
        });
        let markChangesStarted!: () => void;
        const changesStarted = new Promise<void>((resolve) => {
            markChangesStarted = resolve;
        });
        fetchChanges.mockImplementationOnce(async () => {
            markChangesStarted();
            await changesReleased;
            return {
                status: 'ok' as const,
                changes: [{
                    cursor: 1,
                    kind: 'account' as const,
                    entityId: 'self',
                    changedAt: 1,
                    hint: null,
                }],
                nextCursor: '1',
            };
        });

        const observedWakes: Array<{
            serverId: string;
            entityIds?: readonly string[];
            sessionListQueryAffects?: boolean | 'structural';
        }> = [];
        const dispose = subscribeHomeAccountChange((event) => observedWakes.push(event));
        const catchUp = harness.resumeViaChanges({ accountId: ACCOUNT_ID });
        await changesStarted;
        const focusedServer = await upsertAndActivateServer({
            serverUrl: 'http://localhost:53289',
            scope: 'tab',
        });
        expect(focusedServer.id).not.toBe(sourceServerId);
        releaseChanges();

        await expect(catchUp).resolves.toMatchObject({ status: 'ok' });
        expect(observedWakes).toEqual([{
            serverId: sourceServerId,
            entityIds: ['self'],
            sessionListQueryAffects: false,
        }]);
        dispose();
        harness.disconnectServer();
    });

    it('keeps an AccountChange refresh on the applied Home while another Home is staged', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { getActiveServerSnapshot, upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { storage } = await import('./domains/state/storage');
        const appliedSnapshot = getActiveServerSnapshot();
        const appliedServerId = String(appliedSnapshot.serverId ?? '').trim();
        Reflect.set(harness, 'appliedServerTarget', {
            serverId: appliedServerId,
            serverUrl: appliedSnapshot.serverUrl,
            generation: appliedSnapshot.generation,
        });
        harness.changesCursor = '0';
        harness.settingsSync = { invalidateAndAwait: vi.fn(async () => undefined) };
        harness.profileSync = { invalidateAndAwait: vi.fn(async () => undefined) };
        fetchChanges.mockResolvedValueOnce({
            status: 'ok' as const,
            changes: [{
                cursor: 1,
                kind: 'account' as const,
                entityId: 'self',
                changedAt: 1,
                hint: null,
            }],
            nextCursor: '1',
        });

        await upsertAndActivateServer({
            serverUrl: 'http://localhost:53289',
            scope: 'device',
        });
        const stagedSnapshot = getActiveServerSnapshot();
        storage.getState().activateProfileScope({
            serverId: stagedSnapshot.serverId,
            accountId: ACCOUNT_ID,
        });
        expect(stagedSnapshot.serverId).not.toBe(appliedServerId);
        expect(getActiveServerAccountScope()).toEqual({
            serverId: stagedSnapshot.serverId,
            accountId: ACCOUNT_ID,
        });

        const observedWakes: Array<{ serverId: string }> = [];
        const dispose = subscribeHomeAccountChange((event) => observedWakes.push(event));
        await expect(harness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
            status: 'ok',
        });

        expect(fetchChanges).toHaveBeenCalledOnce();
        expect(observedWakes).toEqual([expect.objectContaining({ serverId: appliedServerId })]);
        dispose();
        harness.disconnectServer();
    });

    it('coalesces wakes received after a changes response into one trailing canonical catch-up', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const observedHomes: string[] = [];
        const disposeHomeAccountChanged = subscribeHomeAccountChange(({ serverId }) => observedHomes.push(serverId));
        const resumeUnit: ResumeSyncUnit = {
            invalidateCoalesced: vi.fn(),
            awaitQueue: vi.fn(async () => {}),
        };
        harness.purchasesSync = resumeUnit;
        harness.nativeUpdateSync = resumeUnit;
        harness.sessionsSync = resumeUnit;
        harness.machinesSync = resumeUnit;

        const rearmPendingOutbox = vi
            .spyOn(harness, 'rearmPendingOutboxForActiveScope')
            .mockResolvedValue(undefined);
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
        const observedBeforeResume = [...observedHomes];
        disposeHomeAccountChanged();
        expect(resumeViaChanges).toHaveBeenCalledTimes(1);

        releaseFirstResume();
        await firstResume;
        await vi.waitFor(() => expect(harness.resumeInFlight).toBeNull());

        expect(resumeViaChanges).toHaveBeenCalledTimes(2);
        // The socket wake is already a durable changes-cursor signal. Its trailing pass must not
        // repeat the full resume's outbox, external-session, purchases, or native-update tail.
        expect(rearmPendingOutbox).toHaveBeenCalledTimes(1);
        expect(catchUpCalls).toBe(1);
        expect(resumeUnit.invalidateCoalesced).toHaveBeenCalledTimes(2);
        expect(observedBeforeResume).toEqual([]);
    });

    it('publishes no content-free Home change for a focused-Home wake and asks for the exact page instead', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const resumeUnit: ResumeSyncUnit = { invalidateCoalesced: vi.fn(), awaitQueue: vi.fn(async () => {}) };
        harness.purchasesSync = resumeUnit;
        harness.nativeUpdateSync = resumeUnit;
        harness.sessionsSync = resumeUnit;
        harness.machinesSync = resumeUnit;
        vi.spyOn(harness, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
        vi.spyOn(harness, 'catchUpLoadedExternalSessionsOnResume').mockResolvedValue(undefined);
        const resumeViaChanges = vi.spyOn(harness, 'resumeViaChanges').mockResolvedValue({
            status: 'ok',
            refreshedByCatchUp: { sessions: false, machines: false },
        });
        const observed: Array<Readonly<{ serverId: string; entityIds?: readonly string[] }>> = [];
        const dispose = subscribeHomeAccountChange((event) => observed.push(event));

        await harness.handleUpdate(accountChangeWake('account-change-focused'));
        await vi.waitFor(() => expect(resumeViaChanges).toHaveBeenCalled());
        await vi.waitFor(() => expect(harness.resumeInFlight).toBeNull());
        dispose();

        // A busy Account wakes about once a second; every Home projection with an entity filter
        // (governance, eligibility, Teams) would treat a content-free event as "anything changed"
        // and refetch. The focused Home's exact page is published by the change planner instead.
        expect(observed).toEqual([]);
    });

    it('drops a queued AccountChange wake when its server/account lifetime resets', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const resumeUnit: ResumeSyncUnit = {
            invalidateCoalesced: vi.fn(),
            awaitQueue: vi.fn(async () => {}),
        };
        harness.purchasesSync = resumeUnit;
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
