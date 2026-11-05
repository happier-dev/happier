import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import React from 'react';
import 'fake-indexeddb/auto';
import type { Socket } from 'socket.io-client';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    AUTHORING_MEMORY_ROUTE_V1,
    AuthoringMemoryListResponseV1Schema,
    projectLegacySessionAccessCapabilitiesV1,
    resolveSessionFollowActionRequest,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryRequestV1,
} from '@happier-dev/protocol';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { SESSION_DRAFT_V2_ROUTE_LIST, SessionDraftListResponseV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    normalizePluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ChangesCursorScope } from '@/sync/domains/state/persistence';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { FeedResponseSchema } from '@/sync/domains/social/feedTypes';
import type { InvalidateSync } from '@/utils/sessions/sync';

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
    disconnectServer(): void;
};

type SyncAccountChangeWakeSchedulingHarness = SyncAccountChangeCatchUpHarness & {
    resumeInFlight: Promise<void> | null;
    resumeViaChanges(options: { accountId: string; shouldContinue?: () => boolean }): Promise<unknown>;
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

// The SDK and HTTP leaves are the only replaced owners in the composed cases.
const sockets: Socket[] = [];
installDisconnectedServerSocketBoundary((socket) => { sockets.push(socket); });
const domainHttp = vi.hoisted(() => vi.fn<(params: { url: string; init?: RequestInit }) => Promise<Response>>());
const changesResponse = vi.hoisted(() => vi.fn());
// Holding the genuine profile HTTP response keeps the real change applier in flight.
const profileResponseGate = vi.hoisted(() => vi.fn<() => Promise<void>>());
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let authScreen: RenderScreenResult | undefined;
let syncRuntime: typeof import('./syncEngine').sync | undefined;
let syncBridge: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;

async function loadTestSync(): Promise<void> {
    syncBridge = await loadSyncSingletonForTests();
    syncRuntime = (await import('./syncEngine')).sync;
}

await loadTestSync();

async function restoreTestAccount(options: {
    mountAuth?: boolean;
    credentials?: AuthCredentials;
    accountMode?: 'plain' | 'e2ee';
    draftsEnabled?: boolean;
    followingEnabled?: boolean;
    onRequest?: (path: string) => void;
    runtimeRequest?: (path: string, init?: RequestInit) => Response | undefined;
    physicalRequest?: (url: string, init?: RequestInit) => Promise<Response> | undefined;
} = {}): Promise<void> {
    await loadTestSync();
    const { profileDefaults } = await import('./domains/profiles/profile');
    let bootstrapping = true;
    account = await restoreServerAccountForTest({
        serverUrl: 'http://localhost:53288',
        accountId: ACCOUNT_ID,
        credentials: options.credentials ?? { token: ACCOUNT_TOKEN },
        request: (url, init) => options.physicalRequest?.(String(url), init) ?? sessionBoundary(url, init),
    });
    async function sessionBoundary(...args: Parameters<ReturnType<typeof createSessionReadBatchFetchBoundary>>) {
        return createSessionReadBatchFetchBoundary((url, init) => waitForNetworkResponseForTests((async () => {
            const path = new URL(String(url)).pathname;
            options.onRequest?.(path);
            if (!bootstrapping) {
                const response = options.runtimeRequest?.(path, init);
                if (response) return response;
            }
            if (path === '/health') return jsonResponse({});
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                features: { sessions: { drafts: { enabled: options.draftsEnabled === true },
                    ...(options.followingEnabled === undefined ? {} : { enabled: true, following: { enabled: options.followingEnabled } }) } },
            }));
            if (path === '/v1/account/encryption') return jsonResponse({ mode: options.accountMode ?? 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return jsonResponse({
                mode: options.accountMode ?? 'plain', version: 1,
                signingKeyFingerprint: options.accountMode === 'e2ee' ? 'fixture-signing' : null,
                contentKeyFingerprint: options.accountMode === 'e2ee' ? 'fixture-content' : null,
                updatedAt: 1, recipientEnvelopeReadiness: options.accountMode === 'e2ee'
                    ? { status: 'available' } : { status: 'unavailable', reason: 'plain_account' },
            });
            if (path === '/v2/account/settings') return jsonResponse({ content: null, version: 0 });
            if (path === '/v1/account/profile') {
                await profileResponseGate();
                return jsonResponse({ ...profileDefaults, id: ACCOUNT_ID });
            }
            if (path === AUTHORING_MEMORY_ROUTE_V1) return jsonResponse(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return jsonResponse(options.accountMode === 'e2ee'
                ? { status: 'listed', coverage: 'complete', rows: [] } : createPlainProjectAccountRowListFixture());
            if (path === SESSION_DRAFT_V2_ROUTE_LIST) return jsonResponse(SessionDraftListResponseV2Schema.parse({ items: [] }));
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return jsonResponse({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v1/machines' || path === '/v1/artifacts') return jsonResponse([]);
            if (path === '/v1/friends' || path === '/v1/friends/requests') return jsonResponse({ friends: [], requests: [] });
            if (path === '/v1/kv') return jsonResponse({ items: [] });
            if (path === '/v1/account/saved-secrets/resources/materials') return jsonResponse({ resources: [] });
            if (path === '/v1/feed') return jsonResponse(FeedResponseSchema.parse({ items: [], hasMore: false }));
            if (bootstrapping && path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) return jsonResponse({ availabilityCursor: 0, snapshots: [] });
            if (bootstrapping && path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) return jsonResponse({ availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [] });
            // Account bootstrap continues after core readiness. Its independent
            // inventory reads need real empty protocol replies throughout the test.
            if (path === '/v2/session-organization' || path === '/v2/sessions/metadata-upgrades' || path === '/v1/account/pets') {
                return createEmptyAccountBootstrapHttpResponse(path, init)!;
            }
            if (path === '/v2/cursor') return jsonResponse({ cursor: 0, changesFloor: 0 });
            if (path === '/v2/changes') {
                const page = await changesResponse({ url: String(url), init });
                return jsonResponse({ changes: page?.changes ?? [], nextCursor: Number(page?.nextCursor ?? 0) });
            }
            return domainHttp({ url: String(url), init });
        })(), init?.signal))(...args);
    }
    const { storage } = await import('./domains/state/storage');
    await waitForHomeGovernance(() => {
        expect(storage.getState().isDataReady).toBe(true);
        expect(storage.getState().profile.id).toBe(ACCOUNT_ID);
    });
    const { sync } = await import('./syncEngine');
    const bootstrap = sync as unknown as {
        sessionsSync: Pick<InvalidateSync, 'awaitQueue'>;
        pluginAvailabilitySync: Pick<InvalidateSync, 'awaitQueue'>;
        resumeInFlight: Promise<void> | null;
        ensureSessionDraftRepositoryRuntimeReady(): Promise<void>;
    };
    await sync.awaitBootstrapForegroundAcquisition();
    // Core readiness deliberately precedes the independent background readers.
    // Finish their initial empty census before a case installs held domain replies.
    await bootstrap.ensureSessionDraftRepositoryRuntimeReady();
    await Promise.all([bootstrap.sessionsSync.awaitQueue(), bootstrap.pluginAvailabilitySync.awaitQueue()]);
    await bootstrap.resumeInFlight;
    bootstrapping = false;
    if (!options.mountAuth) return;
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    authScreen = await renderScreen(React.createElement(AuthProvider, {
        initialCredentials: account.credentials, children: null,
    }));
}

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
        intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID, response: availabilityIntentValue(AVAILABILITY_PLUGIN_ID) }],
        failedPluginIds: [],
    });
}

function availabilityIntentValue(pluginId: string) {
    return {
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
    };
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
    await restoreTestAccount();
    const { sync } = await import('./syncEngine');
    const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
    await waitForHomeGovernance(() => expect(getActiveServerAccountScope()).not.toBeNull());
    return sync as unknown as SyncAccountChangeWakeSchedulingHarness;
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
    it('gathers one Home page of missing documents without opening the other 124 Sessions', async () => {
        const { createCompactSessionListFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
        const { SessionReadBatchRequestV1Schema } = await import('@happier-dev/protocol/sessions/read/sessionReadBatchV1');
        const rows = Array.from({ length: 174 }, (_, index) => createPlainSessionCurrentProjectionRecordFixture({ id: `home-page-${index}` }));
        const batches: string[][] = [];
        const boundary = createCompactSessionListFetchBoundary(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v2/sessions/active') return jsonResponse({ sessions: [], hasNext: false, nextCursor: null });
            if (path === '/v2/sessions') return jsonResponse({ sessions: rows.slice(0, 50), hasNext: true, nextCursor: 'next-home-page' });
            const row = rows.find(row => path === `/v2/sessions/${row.id}`);
            return row ? jsonResponse({ session: row }) : undefined;
        });
        await restoreTestAccount({ physicalRequest: (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v2/sessions/read-batch') batches.push([...SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body))).sessionIds]);
            return path === '/v2/sessions' || path.startsWith('/v2/sessions/') && path !== '/v2/sessions/metadata-upgrades'
                ? boundary(url, init) : undefined;
        } });
        expect(batches).toEqual([rows.slice(0, 50).map(row => row.id)]);
    });

    it('applies pushed metadata to an open viewer through the exact-Home reader', async () => {
        const requests: string[] = [];
        const sessionId = 'pushed-owner-tuple';
        let row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId });
        domainHttp.mockImplementation(async ({ url }) => new URL(url).pathname === `/v2/sessions/${sessionId}`
            ? jsonResponse({ session: row }) : Response.json({}, { status: 404 }));
        await restoreTestAccount({ physicalRequest: url => { requests.push(new URL(url).pathname); return undefined; } });
        const runtime = syncRuntime;
        if (!runtime || !account) throw new Error('Expected restored Account');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected exact Home scope');
        const { storage } = await import('./domains/state/storage');
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const release = registerSessionRealtimeTranscriptConsumer(sessionId, scope.serverId);
        try {
            await runtime.ensureSessionVisibleForMessageRoute(sessionId, { serverId: scope.serverId,
                hydrateMessages: false, includeTurnsProjection: false });
            requests.length = 0;
            row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadataVersion: 2,
                metadata: { path: '/pushed-owner', host: 'home' } });
            await runtime.consumeSessionRealtimeUpdateForHome({ serverId: scope.serverId,
                credentials: account.credentials, encryption: null, isCurrent: () => true,
                update: { id: 'owner-metadata-push', seq: 9, createdAt: 9, body: {
                    t: 'update-session', id: sessionId, metadataLayoutVersion: 1,
                    metadata: { version: row.metadataVersion, value: row.metadata! }, ownerMetadata: row.ownerMetadata!,
                } } });
            await waitForHomeGovernance(() => expect(storage.getState().sessions[sessionId]?.ownerMetadataView?.path).toBe('/pushed-owner'));
            // Full owner documents pass through the canonical owner reader;
            // they do not trigger an Account inventory or changes-feed refresh.
            expect(requests).toContain('/v2/sessions/read-batch');
            expect(requests).not.toContain('/v2/sessions');
            expect(requests).not.toContain('/v2/changes');
            requests.length = 0;
            row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadataVersion: 3,
                metadata: { path: '/pushed-owner', host: 'home', summary: { text: 'pushed summary', updatedAt: 10 } } });
            await runtime.consumeSessionRealtimeUpdateForHome({ serverId: scope.serverId,
                credentials: account.credentials, encryption: null, isCurrent: () => true,
                update: { id: 'shared-metadata-push', seq: 10, createdAt: 10, body: {
                    t: 'update-session', id: sessionId, metadataLayoutVersion: 1,
                    metadata: { version: row.metadataVersion, value: row.metadata! },
                } } });
            await waitForHomeGovernance(() => expect(storage.getState().sessions[sessionId]?.metadata?.summary?.text).toBe('pushed summary'));
            expect(storage.getState().sessions[sessionId]?.ownerMetadataView?.path).toBe('/pushed-owner');
            expect(requests).toContain('/v2/sessions/read-batch');
            expect(requests).not.toContain('/v2/sessions');
            expect(requests).not.toContain('/v2/changes');
        } finally { release(); }
    });

    let localStorage: LocalStorageMockHandle | null = null;
    let webLocks: WebLockManagerMockHandle | null = null;

    beforeEach(async () => {
        vi.resetModules();
        kvStore.clear();
        localStorage = installLocalStorageMock();
        webLocks = installWebLockManagerMock();
        sockets.length = 0;
        domainHttp.mockReset();
        domainHttp.mockImplementation(async () => Response.json({}, { status: 404 }));
        changesResponse.mockReset();
        profileResponseGate.mockReset();
        profileResponseGate.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await authScreen?.unmount();
        authScreen = undefined;
        // Retire the fixture's runtime before its HTTP/credential boundary.
        // Do not import a new Engine during cleanup of a failed import.
        syncRuntime?.disposeEmbedSession();
        syncRuntime?.disconnectServer();
        const { abortServerFetches } = await import('./http/client');
        abortServerFetches();
        await account?.dispose();
        account = undefined;
        // A reset while a background reader is still importing can strand the
        // next Engine import in a half-retired module graph.
        await vi.dynamicImportSettled();
        syncBridge?.dispose();
        syncBridge = undefined;
        syncRuntime = undefined;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        localStorage?.restore();
        localStorage = null;
        webLocks?.restore();
        webLocks = null;
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('settles an exact Run in detail and rail once after held catch-up without reading unrelated wakes', async () => {
        const runtime = await prepareAccountChangeWakeSchedulingHarness();
        const { storage } = await import('./domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('./domains/scope/activeServerAccountScope');
        const { createWorkflowDefinitionFixture, createWorkflowRunListStorageFixture, createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { workflowRunRowFromSummary } = await import('./store/domains/workflowRuns');
        const { useWorkflowRun, useWorkflowRunRows } = await import('./store/hooks');
        const { subscribeVisibleWorkflowRunListInvalidation } = await import('./domains/workflows/workflowRunListInvalidation');
        const { refreshWorkflowRunById } = await import('./engine/workflows/refreshWorkflowRun');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected restored Run Account lifetime');
        const running = createWorkflowRunSummaryFixture({ ownerAccountId: ACCOUNT_ID, origin: { kind: 'direct' } });
        const failed = createWorkflowRunSummaryFixture({ ...running, state: 'failed', revision: 11, workflowCustodyState: 'settled' });
        const response = await createWorkflowRunListStorageFixture({ runs: [failed], definition: createWorkflowDefinitionFixture({
            blocks: [{ kind: 'wait', id: 'confirm', document: { text: 'Continue', references: [], attachments: [] } }],
        }) });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(running)], lifetime.scope);
        const hook = await renderHook(() => ({ detail: useWorkflowRun(running.id), rail: useWorkflowRunRows([running.id]) }));
        const reads: Promise<void>[] = [];
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({ lifetime, runId: running.id,
            isVisibleWindowLoaded: () => true,
            invalidate: ({ summaryCurrent }) => {
                if (!summaryCurrent) reads.push(refreshWorkflowRunById(running.id, { accountLifetime: lifetime, fence: lifetime }));
            },
        });
        let runReads = 0;
        domainHttp.mockImplementation(async ({ url }) => {
            if (new URL(url).pathname === '/v3/automations/runs/workflow-storage') {
                runReads++;
                return jsonResponse(response);
            }
            return Response.json({}, { status: 404 });
        });
        const gate = createDeferred<void>();
        let catchUpRequested = false;
        changesResponse.mockImplementationOnce(async () => {
            catchUpRequested = true;
            await gate.promise;
            return { changes: [{ cursor: 1, changedAt: 1, kind: 'account', entityId: `workflow-run:${running.id}`,
                hint: { revision: 11 } }], nextCursor: 1 };
        });
        try {
            await act(async () => runtime.handleUpdate(accountChangeWake('run-failed')));
            await vi.waitFor(() => expect(catchUpRequested).toBe(true));
            for (let index = 0; index < 100; index++) await runtime.handleUpdate(accountChangeWake(`unrelated-${index}`));
            expect(runReads).toBe(0);
            expect(hook.getCurrent().detail?.summary).toMatchObject({ state: 'running', revision: 1 });
            await act(async () => { gate.resolve(); await runtime.resumeInFlight; await Promise.all(reads); });
            expect(hook.getCurrent().detail?.summary).toMatchObject({ state: 'failed', revision: 11 });
            expect(hook.getCurrent().rail[0]?.summary).toMatchObject({ state: 'failed', revision: 11 });
            expect(runReads).toBe(1);
        } finally {
            gate.resolve(); await runtime.resumeInFlight; await Promise.allSettled(reads);
            unsubscribe(); await hook.unmount();
        }
    });

    it('publishes concurrent exact Session list projections as one store update without a publication timer', async () => {
        const ids = Array.from({ length: 6 }, (_, index) => `publication-projection-${index}`);
        const responses = createDeferred<void>();
        const requested = createDeferred<void>();
        const physical: Array<{ path: string; ids: readonly string[] }> = [];
        let directGets = 0;
        await restoreTestAccount({ physicalRequest: (url, init) => {
            const path = new URL(url).pathname;
            if (ids.some(id => path === `/v2/sessions/${id}`)) directGets++;
            if (path !== '/v2/sessions/read-batch') return undefined;
            const input = JSON.parse(String(init?.body));
            if (!input.sessionIds.some((id: string) => ids.includes(id))) return undefined;
            physical.push({ path, ids: input.sessionIds });
            requested.resolve();
            return responses.promise.then(() => jsonResponse({ results: input.sessionIds.map((id: string) => ({
                sessionId: id, detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id }) } },
            })) }));
        } });
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness & {
            refreshSessionListRowProjection(serverId: string, sessionId: string): Promise<void>;
        };
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        let publications = 0;
        const unsubscribe = storage.subscribe((next, previous) => {
            if (next.sessionListRowsByServerId[scope.serverId] !== previous.sessionListRowsByServerId[scope.serverId]) publications++;
        });
        const reads = ids.map(async id => {
            await runtime.refreshSessionListRowProjection(scope.serverId, id);
            expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[id]).toBeDefined();
        });
        let publicationTimersFrozen = false;
        try {
            await requested.promise;
            expect(physical).toEqual([{ path: '/v2/sessions/read-batch', ids }]);
            expect(directGets).toBe(0);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            publicationTimersFrozen = true;
            responses.resolve();
            // Settle real HTTP/currentness admission with publication timers
            // frozen. A timer-owned publication could not complete these reads.
            await Promise.all(reads);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(publications).toBe(1);
            await vi.runAllTimersAsync();
            await Promise.all(reads);
            expect(publications).toBe(1);
            for (const id of ids) expect(storage.getState().sessions[id]).toBeUndefined();
        } finally {
            responses.resolve();
            if (publicationTimersFrozen) await vi.runAllTimersAsync();
            await Promise.allSettled(reads);
            vi.useRealTimers();
            unsubscribe();
        }
    });

    it.each(['scope', 'account', 'same-home-retirement', 'other-home-retirement'] as const)(
        'rechecks exact Session list projection publication after %s', async change => {
        const started = createDeferred<void>();
        const response = createDeferred<Response>();
        let holdCurrentness = false;
        await restoreTestAccount({ physicalRequest: (url) => {
            if (!holdCurrentness || new URL(url).pathname !== '/v1/account/encryption/currentness') return undefined;
            started.resolve();
            return response.promise;
        } });
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness & {
            refreshSessionListRowProjection(serverId: string, sessionId: string): Promise<void>;
        };
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        const id = `projection-publication-${change}`;
        domainHttp.mockImplementation(async ({ url }) => new URL(url).pathname === `/v2/sessions/${id}`
            ? jsonResponse({ session: createPlainSessionCurrentProjectionRecordFixture({ id }) })
            : Response.json({}, { status: 404 }));
        const { invalidateAccountEncryptionModeCache } = await import('./api/account/apiAccountEncryptionMode');
        invalidateAccountEncryptionModeCache({ serverId: scope.serverId, reason: 'scope-reset' });
        holdCurrentness = true;
        const read = runtime.refreshSessionListRowProjection(scope.serverId, id).then(() => 'applied', () => 'refused');
        try {
            // Hold the real fresh-witness HTTP boundary. Scope/access retirement
            // must still fence the materialized row when that admission resumes.
            await started.promise;
            if (change === 'scope') runtime.disconnectServer();
            else if (change === 'account') {
                invalidateAccountEncryptionModeCache({ serverId: scope.serverId, reason: 'scope-reset' });
            }
            else storage.getState().deleteSession(id, change === 'same-home-retirement' ? scope.serverId : 'another-home');
            response.resolve(jsonResponse({ mode: 'plain', version: 1, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            }));
            expect(await read).toBe(change === 'other-home-retirement' ? 'applied' : 'refused');
            expect(Boolean(storage.getState().sessionListRowsByServerId[scope.serverId]?.[id]))
                .toBe(change === 'other-home-retirement');
        } finally {
            response.resolve(jsonResponse({ mode: 'plain', version: 1, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null,
            }));
            await read;
        }
    });

    it('publishes a ready exact Session list projection while another read remains pending', async () => {
        const runtime = await prepareAccountChangeWakeSchedulingHarness() as SyncAccountChangeWakeSchedulingHarness & {
            refreshSessionListRowProjection(serverId: string, sessionId: string): Promise<void>;
        };
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        const releaseSlow = createDeferred<void>();
        let slowStarted = false;
        domainHttp.mockImplementation(async ({ url }) => {
            const id = new URL(url).pathname.split('/').at(-1)!;
            if (id === 'projection-slow') { slowStarted = true; await releaseSlow.promise; }
            if (id === 'projection-slow' || id === 'projection-ready') return jsonResponse({
                session: createPlainSessionCurrentProjectionRecordFixture({ id }),
            });
            return Response.json({}, { status: 404 });
        });
        let slowSettled = false;
        const slow = runtime.refreshSessionListRowProjection(scope.serverId, 'projection-slow').then(() => { slowSettled = true; });
        try {
            await waitForHomeGovernance(() => expect(slowStarted).toBe(true));
            await runtime.refreshSessionListRowProjection(scope.serverId, 'projection-ready');
            expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.['projection-ready']).toBeDefined();
            expect(slowSettled).toBe(false);
            expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.['projection-slow']).toBeUndefined();
        } finally { releaseSlow.resolve(); await slow; }
    });

    it('refreshes observed Session records from a Home wake before detailed catch-up can publish', async () => {
        const sessionId = 'mounted-board-session';
        let revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
        let recordReads = 0;
        await restoreTestAccount({ runtimeRequest: path => {
            if (path === `/v2/sessions/${sessionId}`) return jsonResponse({
                session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }),
            });
            if (path === `/v2/sessions/${sessionId}/system-records`) {
                recordReads++;
                return jsonResponse({ records: [{ id: 'sysrec_1', revision,
                    address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                    content: { t: 'plain', v: { v: 1, tabs: [] } },
                    createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
                }], nextCursor: null, hasNext: false });
            }
            return undefined;
        } });
        const { sync } = await import('./syncEngine');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { publishHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        const address = { serverId: scope.serverId, sessionId };
        const acquired = await sync.withSessionSystemRecordRuntime(address, async runtime => runtime.repository);
        expect(acquired.status).toBe('ok');
        if (acquired.status !== 'ok') throw new Error('Expected Session record authority');
        const repository = acquired.value;
        const query = { type: 'list', namespace: 'surface' } as const;
        const stop = repository.subscribe(address, query, () => {});
        try {
            await waitForHomeGovernance(() => expect(repository.getSnapshot(address, query).data?.records[0]?.revision).toBe(revision));
            const initialReads = recordReads;
            publishHomeAccountChange('another-home', undefined, { source: 'catch-up-pending' });
            publishHomeAccountChange(scope.serverId, ['self'], { changeKinds: ['account'] });
            expect(recordReads).toBe(initialReads);
            revision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
            publishHomeAccountChange(scope.serverId, undefined, { source: 'catch-up-pending' });
            expect(repository.getSnapshot(address, query).freshness).toBe('stale');
            await waitForHomeGovernance(() => expect(repository.getSnapshot(address, query).data?.records[0]?.revision).toBe(revision));
            expect(repository.getSnapshot(address, query)).toMatchObject({ freshness: 'fresh', loading: 'idle' });
            revision = 'ssr1.AAAACHN5c3JlY18xAAAAAw';
            publishHomeAccountChange(scope.serverId);
            expect(repository.getSnapshot(address, query).freshness).toBe('stale');
            await waitForHomeGovernance(() => expect(repository.getSnapshot(address, query).data?.records[0]?.revision).toBe(revision));
        } finally { stop(); }
    });

    it.each(['blocked', 'held'] as const)('revalidates mounted skill reach while the focused catch-up is %s', async phase => {
        const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
        const { PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'skill-rules', value: { v: 1,
            rules: [{ id: 'built-in-on', skillId: 'happier:happier', target: { t: 'allMachines' }, enabled: true,
                createdAt: 1, updatedAt: 1 }] } }] });
        const work: string[] = [];
        let measuring = false;
        const ruleResponseGate = createDeferred<void>();
        let ruleRequested = false;
        domainHttp.mockImplementation(async ({ url, init }) => {
            const path = new URL(url).pathname;
            const response = await catalog.handle(path, init);
            if (measuring && path.endsWith('/prompt-library/skill-rules') && (init?.method ?? 'GET') === 'GET') {
                ruleRequested = true;
                await ruleResponseGate.promise;
            }
            return response ?? Response.json({}, { status: 404 });
        });
        await restoreTestAccount({ onRequest: path => { if (measuring) work.push(path); } });
        const rowCodec = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
        const decrypts = vi.spyOn(rowCodec, 'openPromptLibraryContentV1');
        const readers = await import('./api/account/apiPromptLibraryCatalog');
        const catalogReads = vi.spyOn(readers, 'readPromptLibraryCatalogProjection');
        const rowReads = vi.spyOn(readers, 'readPromptLibraryCatalogRowsProjection');
        const { useSkillsLibrary } = await import('./domains/skills/useSkillsLibrary');
        const { buildSkillsReach } = await import('@/components/settings/skills/skillsCollectionModel');
        const { resetPromptLibraryCatalogEngineForTests } = await import('./engine/settings/promptLibraryCatalogEngine');
        const { resetPromptLibraryCatalogSnapshotsForTests } = await import('./store/settings/promptLibraryCatalogSnapshot');
        const hook = await renderHook(() => useSkillsLibrary());
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness;
        const responseGate = createDeferred<void>();
        let requestedChanges = false;
        const count = () => buildSkillsReach(hook.getCurrent().items, [{ machineId: 'online', name: 'Online',
            platform: 'posix', agentIds: ['codex'], online: true, offline: false, lastSeenAt: null }]).reachingCount;
        try {
            await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'happier:happier')?.rules[0]?.enabled).toBe(true));
            expect(count()).toBe(1);
            const record = catalog.read('skill-rules');
            if (record.key !== 'skill-rules') throw new Error('Expected rules');
            const response = await catalog.handle('/v1/account/entity-rows/prompt-library/skill-rules', {
                method: 'POST', body: JSON.stringify({ expectedRevision: catalog.revision('skill-rules'), content: { t: 'plain',
                    v: { ...record, value: { ...record.value, rules: record.value.rules.map(rule => ({ ...rule, enabled: false, updatedAt: 2 })) } } } }),
            });
            expect(await response?.json()).toMatchObject({ status: 'updated', revision: 2 });
            // This real ChangeEntry is an unmaterializable historical row. The newer reach
            // write lies beyond this short page, so it cannot supply an exact row wake.
            changesResponse.mockImplementationOnce(async () => {
                requestedChanges = true;
                if (phase === 'held') await responseGate.promise;
                return { changes: [{ cursor: 1, changedAt: 1, kind: 'account',
                    entityId: `${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}unrecognized`, hint: null }], nextCursor: 1 };
            });
            const cursorBefore = runtime.changesCursor;
            measuring = true;
            decrypts.mockClear(); catalogReads.mockClear(); rowReads.mockClear();
            await act(async () => {
                if (phase === 'held') await runtime.handleUpdate(accountChangeWake('reach-changed-during-catch-up'));
                else await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            });
            await vi.waitFor(() => expect(requestedChanges).toBe(true));
            await vi.waitFor(() => expect(ruleRequested).toBe(true));
            const { publishHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
            const entityId = rowCodec.buildPromptLibraryPhysicalKeyV1('skill-rules');
            // The detailed wake can arrive before the early read answers. It must
            // not cause a second request for the revision that read then receives.
            publishHomeAccountChange(account!.serverId, [entityId], { entityRevisions: { [entityId]: 2 } });
            ruleResponseGate.resolve();
            await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'happier:happier')?.rules[0]?.enabled).toBe(false));
            expect(count()).toBe(0);
            expect(runtime.changesCursor).toBe(cursorBefore);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(work.filter(path => path.includes('prompt-library') || path.includes('/artifacts') || path.includes('/account/settings')))
                .toEqual(['/v1/account/entity-rows/prompt-library/skill-rules']);
            expect(decrypts).toHaveBeenCalledTimes(1);
            expect(catalogReads).not.toHaveBeenCalled();
            expect(rowReads).toHaveBeenCalledTimes(1);
            console.info(JSON.stringify({ phase, requests: work, rowDecrypts: decrypts.mock.calls.length,
                catalogRefreshes: catalogReads.mock.calls.length, scopedRowRefreshes: rowReads.mock.calls.length }));
        } finally {
            ruleResponseGate.resolve();
            responseGate.resolve();
            await runtime.resumeInFlight;
            await hook.unmount(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests();
        }
    });

    it('does not reread Teams or Home for already published rows across ten held-cursor wakes', async () => {
        await restoreTestAccount();
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { observeTeamsDirectory, resetTeamsDirectoryEngineForTests } = await import('./engine/teams/teamsDirectoryEngine');
        const { getTeamsDirectorySnapshot, resetTeamsSnapshotsForTests } = await import('./store/teams/teamsSnapshots');
        const { observeHomeGovernance, resetHomeGovernanceEngineForTests } = await import('./engine/home/governance/homeGovernanceEngine');
        const { getHomeGovernanceSnapshot, resetHomeGovernanceSnapshotsForTests } = await import('./store/home/governance/homeGovernanceSnapshots');
        const { NO_HOME_CAPABILITIES_V1 } = await import('@happier-dev/protocol/home/governance');
        const { teamDirectoryQueryKeyV1 } = await import('@happier-dev/protocol/teams');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol/changes');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        const reads: string[] = [];
        let sessionAvailable = false;
        domainHttp.mockImplementation(async ({ url }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/teams/list') {
                reads.push(path);
                return jsonResponse({ items: [], nextCursor: null });
            }
            if (path === '/v1/home/governance/get') {
                reads.push(path);
                return jsonResponse({
                    viewer: { accountId: ACCOUNT_ID, homeRole: 'owner', status: 'active' },
                    capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
                    policy: { revision: 3, teamCreationPolicy: 'managed_only', authentication: { status: 'inherited' } },
                    authenticationOptions: { methods: [], permittedAccountModes: ['plain'], recommendedProvisioningMode: 'plain',
                        signInService: { deploymentMode: null, canDisable: false } },
                    setupState: 'owned', activeOwnerCount: 1, teamsEnabled: true,
                });
            }
            if (path === '/v2/sessions/held-session') return sessionAvailable
                ? jsonResponse({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'held-session' }) })
                : Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            return Response.json({}, { status: 404 });
        });
        const input = { v: 1, scope: 'member', archived: 'active' } as const;
        const stopTeams = observeTeamsDirectory(scope, input);
        const stopHome = observeHomeGovernance(scope);
        const runtime = syncRuntime as unknown as SyncAccountChangeCatchUpHarness;
        let teamCursor = 2;
        changesResponse.mockImplementation(async ({ url }) => {
            const after = Number(new URL(url).searchParams.get('after'));
            const changes = [
                { cursor: 1, changedAt: 1, kind: 'share', entityId: 'held-session' },
                { cursor: teamCursor, changedAt: teamCursor, kind: 'account', entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
                { cursor: 3, changedAt: 3, kind: 'account', entityId: HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 },
            ].filter(change => change.cursor > after).sort((a, b) => a.cursor - b.cursor);
            return { changes, nextCursor: Math.max(after, teamCursor, 3) };
        });
        try {
            await waitForHomeGovernance(() => {
                expect(getTeamsDirectorySnapshot(scope, teamDirectoryQueryKeyV1(input))?.status).toBe('ready');
                expect(getHomeGovernanceSnapshot(scope)?.status).toBe('ready');
            });
            await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            await waitForHomeGovernance(() => expect(reads).toHaveLength(4));
            const heldCursor = runtime.changesCursor;
            reads.length = 0;
            for (let wake = 0; wake < 10; wake++) await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(runtime.changesCursor).toBe(heldCursor);
            expect(reads).toEqual([]);

            // A newer change for the same family must still reach its mounted reader.
            teamCursor = 4;
            await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            await waitForHomeGovernance(() => expect(reads).toEqual(['/v1/teams/list']));
            expect(runtime.changesCursor).toBe(heldCursor);
            sessionAvailable = true;
            await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            expect(runtime.changesCursor).toBe('4');
        } finally {
            stopTeams(); stopHome();
            resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests();
            resetHomeGovernanceEngineForTests(); resetHomeGovernanceSnapshotsForTests();
        }
    });

    it('revalidates mounted Home projections once on a genuine focused reconnect, not empty catch-up wakes', async () => {
        const runtime = await prepareAccountChangeWakeSchedulingHarness();
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { observeHomeGovernance, resetHomeGovernanceEngineForTests } = await import('./engine/home/governance/homeGovernanceEngine');
        const { getHomeGovernanceSnapshot, resetHomeGovernanceSnapshotsForTests } = await import('./store/home/governance/homeGovernanceSnapshots');
        const { NO_HOME_CAPABILITIES_V1 } = await import('@happier-dev/protocol/home/governance');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        const socket = sockets.at(-1);
        if (!socket) throw new Error('Expected focused Account transport');
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const wakes: Array<{ serverId: string; source?: string }> = [];
        const unsubscribe = subscribeHomeAccountChange(event => wakes.push(event));
        // Deliver genuine SDK transport-boundary events, retaining ApiSocket and Sync.
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        let revision = 1;
        let reads = 0;
        domainHttp.mockImplementation(async ({ url }) => {
            if (new URL(url).pathname !== '/v1/home/governance/get') return Response.json({}, { status: 404 });
            reads++;
            return jsonResponse({
                viewer: { accountId: ACCOUNT_ID, homeRole: 'owner', status: 'active' },
                capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
                policy: { revision, teamCreationPolicy: 'managed_only', authentication: { status: 'inherited' } },
                authenticationOptions: { methods: [], permittedAccountModes: ['plain'], recommendedProvisioningMode: 'plain',
                    signInService: { deploymentMode: null, canDisable: false } },
                setupState: 'owned', activeOwnerCount: 1, teamsEnabled: true,
            });
        });
        const release = observeHomeGovernance(scope);
        try {
            await waitForHomeGovernance(() => expect(getHomeGovernanceSnapshot(scope)?.data?.policy.revision).toBe(1));
            for (let wake = 0; wake < 10; wake++) await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            expect(reads).toBe(1);
            expect(wakes.filter(event => event.source === 'connected')).toEqual([]);
            revision = 2;
            socket.connected = false;
            for (const listener of socket.listeners('disconnect')) listener('transport close');
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            expect(wakes.filter(event => event.source === 'connected')).toEqual([
                expect.objectContaining({ serverId: scope.serverId, source: 'connected' }),
            ]);
            await waitForHomeGovernance(() => expect(getHomeGovernanceSnapshot(scope)?.data?.policy.revision).toBe(2));
            expect(reads).toBe(2);
        } finally {
            unsubscribe();
            release();
            resetHomeGovernanceEngineForTests();
            resetHomeGovernanceSnapshotsForTests();
        }
    });

    it('refreshes shared Machine access in the open store after an AccountChange wake', async () => {
        let role: 'use' | 'manage' = 'use';
        const machine = createPlainMachineRowFixture({ id: 'shared-machine', accountId: 'custodian' });
        await restoreTestAccount({ runtimeRequest: path => path === '/v1/machines'
            ? jsonResponse([{ ...machine, access: { ...machine.access!, role } }]) : undefined });
        const { sync } = await import('./syncEngine');
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { storage } = await import('./domains/state/storage');
        const refresh = sync as unknown as { refreshMachines(): Promise<void> };
        await refresh.refreshMachines();
        expect(storage.getState().machines['shared-machine']?.access?.role).toBe('use');
        role = 'manage';
        changesResponse.mockResolvedValueOnce({ changes: [{ kind: 'machine', entityId: machine.id, cursor: 1, changedAt: 1 }], nextCursor: 1 });
        await runtime.handleUpdate(accountChangeWake('grant-changed'));
        await vi.waitFor(() => expect(storage.getState().machines['shared-machine']?.access?.role).toBe('manage'));
    });

    it('publishes a failed activation authorization into the open Session store without changing the queue version', async () => {
        await restoreTestAccount();
        const { sync } = await import('./syncEngine');
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { storage } = await import('./domains/state/storage');
        const scope = runtime.getChangesCursorScope();
        if (!scope || typeof scope === 'string' || !scope.serverScope) throw new Error('Expected the active Account cursor scope');
        const serverId = scope.serverScope;
        const waiting = { requestId: 'pending-one', requestedAt: 1, status: 'waiting' as const };
        storage.getState().applySessions([createSessionFixture({ id: 'activation-session', serverId,
            pendingCount: 1, pendingVersion: 4, pendingActivationAuthorization: waiting })]);
        await runtime.handleUpdate({ id: 'activation-failed', seq: 1, createdAt: 2, body: {
            t: 'pending-changed', sid: 'activation-session', sessionId: 'activation-session',
            pendingCount: 1, pendingVersion: 4,
            pendingActivationAuthorization: { ...waiting, status: 'failed', failureCode: 'runtime_start_failed' },
        } });
        expect(storage.getState().sessions['activation-session']?.pendingActivationAuthorization).toMatchObject({
            status: 'failed', failureCode: 'runtime_start_failed',
        });
    });

    it('refreshes the demanded pending hold on Machine access changes without a queue-version change', async () => {
        let hold = 'managed_power_required';
        const sessionId = 'grant-held-session';
        await restoreTestAccount({ runtimeRequest: path => path === `/v2/sessions/${sessionId}/pending`
            ? jsonResponse({ pending: [{ localId: 'held-input', messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained input' } } },
                status: 'queued', deliveryStatus: { status: 'queued' }, position: 0, createdAt: 1, updatedAt: 1,
                activationHoldReason: hold }], pendingVersion: 4 }) : undefined });
        const { sync } = await import('./syncEngine');
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { storage } = await import('./domains/state/storage');
        const scope = runtime.getChangesCursorScope();
        if (!scope || typeof scope === 'string' || !scope.serverScope) throw new Error('Expected the active Account cursor scope');
        const serverId = scope.serverScope;
        storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId, pendingCount: 1, pendingVersion: 4 })]);
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const release = registerSessionRealtimeTranscriptConsumer(sessionId, serverId);
        const { resolveSessionLiveConsumption } = await import('@/sync/runtime/sessionLiveConsumption');
        const { subscribeHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const wakes: unknown[] = [];
        const unsubscribe = subscribeHomeAccountChange(event => wakes.push(event));
        try {
            await sync.fetchPendingMessages(sessionId);
            expect(storage.getState().sessionPending[sessionId]?.messages[0]?.pendingActivationHoldReason).toBe('managed_power_required');
            expect(resolveSessionLiveConsumption(sessionId, serverId).isFullContentConsumer).toBe(true);
            hold = 'resume_not_requested';
            changesResponse.mockResolvedValueOnce({ changes: [{ kind: 'machine', entityId: 'controller', cursor: 1, changedAt: 1 }], nextCursor: 1 });
            await runtime.handleUpdate(accountChangeWake('grant-pending-changed'));
            await vi.waitFor(() => expect(wakes).toContainEqual(expect.objectContaining({ serverId, changeKinds: ['machine'] })));
            expect(storage.getState().sessions[sessionId]).toMatchObject({ serverId, pendingCount: 1, pendingVersion: 4 });
            expect(resolveSessionLiveConsumption(sessionId, serverId).isFullContentConsumer).toBe(true);
            await vi.waitFor(() => expect(storage.getState().sessionPending[sessionId]?.messages[0]?.pendingActivationHoldReason).toBe('resume_not_requested'));
            expect(storage.getState().sessions[sessionId]?.pendingVersion).toBe(4);
        } finally { unsubscribe(); release(); }
    });

    it('boots and renews the embed session with only its explicit child credential and session corridor', async () => {
        // The browser realm is a genuine boundary: capture its route before importing owners.
        vi.stubGlobal('window', { location: { pathname: '/embed/session/embed' }, localStorage: globalThis.localStorage,
            addEventListener: vi.fn(), removeEventListener: vi.fn() });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const storedCredentialRead = vi.spyOn(TokenStorage, 'getCredentials');
        const scopedCredentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        await loadTestSync();
        const { sync } = await import('./syncEngine');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const apiRequest = vi.spyOn(apiSocket, 'request');
        const initialize = vi.spyOn(apiSocket, 'initialize');
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
                ? new Response(null, { status: 401 }) : jsonResponse({ cursor: 8, changesFloor: 0 });
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
            if (url.pathname === '/v1/sessions/embed/turns') return jsonResponse({ v: 1, sessionId: 'embed', updatedAt: 1, turns: [] });
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
        const state = (await import('@/sync/domains/state/storage')).storage;
        const retainedTranscriptBeforeRenewal = state.getState().sessionMessages.embed;
        const retainedTurnsBeforeRenewal = state.getState().sessions.embed?.sessionTurns;
        expect(retainedTurnsBeforeRenewal).toBeDefined();
        expect(state.getState().isDataReady).toBe(true);
        expect((sync as unknown as SyncAccountChangeCatchUpHarness).changesCursor).toBe('8');
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
        expect(initialize.mock.calls.map(([configuration]) => configuration.token))
            .toEqual(['hap_v1_child', 'hap_v1_renewed']);
        await expect(initialContext!.request('/v2/sessions/embed')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        const onUpdate = sockets.at(-1)?.listeners('update')[0];
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
        domainHttp.mockImplementation(async ({ url }: { url: string }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features') {
                return currentAccountStoredContentCompatibilityFeaturesResponse();
            }
            if (path === '/v1/account/saved-secrets/resources/materials') {
                return jsonResponse({ resources: [] });
            }
            if (path === '/v2/sessions/metadata-upgrades') {
                // This Account's empty Session inventory has no metadata tuples to upgrade.
                return jsonResponse({ sessionIds: [] });
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
            return jsonResponse({});
        });
        changesResponse.mockResolvedValue({
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
        await restoreTestAccount({ mountAuth: true });
        const { sync } = await import('./sync');
        const syncHarness = sync as unknown as SyncAccountChangeCatchUpHarness;
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
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
                        ...availabilityIntentValue(pluginId),
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
            // A freshness hint has no replacement fact: retain confirmed reads
            // while the named plugin's authoritative refresh is held.
            expect(availabilityReader?.readMaterializations()).toMatchObject({
                kind: 'available',
                availabilityCursor: 8,
                intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID }, { pluginId: unaffectedPluginId }],
            });
        } finally {
            availabilityRefresh.resolve();
        }
        await act(async () => {
            await pagerRefreshed;
            await waitForHomeGovernance(() => {
                expect(availabilityReader?.readMaterializations()).toMatchObject({
                    kind: 'available',
                    availabilityCursor: 9,
                });
            });
        });
        // A named X refresh replaces X, not the unaffected Y read.
        expect(availabilityReader?.readMaterializations()).toMatchObject({
            intentReads: [
                { pluginId: AVAILABILITY_PLUGIN_ID, response: { availabilityCursor: 9 } },
                { pluginId: unaffectedPluginId, response: { availabilityCursor: 8 } },
            ],
        });
        await availabilityHook.unmount();

        expect(syncHarness.changesCursor).toBe('9');
        expect(loadChangesCursor(cursorScope)).toBe('9');
        expect(onSettingsInvalidated).toHaveBeenCalledOnce();
        expect(onAccountEncryptionModeInvalidated).toHaveBeenCalledOnce();
        expect(dataReadCount).toBe(2);
        expect(pager.getSnapshot()).toMatchObject({
            status: 'ready',
            rows: [{ fields: { title: 'after AccountChange' } }],
        });
        expect(domainHttp.mock.calls.map(([params]) => new URL(params.url).pathname)).toEqual(expect.arrayContaining([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        ]));

        accountEncryptionModeInvalidation();
        settingsWatch.dispose();
        pager.dispose();
        syncHarness.disconnectServer();
    });

    it.each(['disable', 'release'] as const)('refreshes an open external plugin after an Account intent change supersedes an in-flight Availability read (%s)', async (change) => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } = await import('./domains/plugins/availability/projection');
        const scope = getActiveServerAccountScope()!;
        const slot = { pluginId: AVAILABILITY_PLUGIN_ID, contributionId: 'page', tier: 'hostedWeb' as const, platform: 'web' as const };
        const intentResponse = (version: string, enabled: boolean, cursor: number) => PluginAvailabilityIntentReadActionOutputV1Schema.parse({
            ...availabilityIntentValue(AVAILABILITY_PLUGIN_ID), availabilityCursor: cursor,
            intent: { ...availabilityIntentValue(AVAILABILITY_PLUGIN_ID).intent, desiredVersion: version, enabled, revision: String(cursor) },
            release: normalizePluginReleaseFactsV1({
                ref: { pluginId: AVAILABILITY_PLUGIN_ID, version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: AVAILABILITY_PLUGIN_ID, version, displayName: 'External plugin',
                    runtime: { apiVersion: 1 }, contributes: {} },
                collectionContracts: [], uiSlots: [{ contributionId: slot.contributionId, tier: slot.tier, platform: slot.platform,
                    artifactId: 'page', artifactDigest: `sha256:${(cursor === 0 ? 'a' : 'b').repeat(64)}`, hostUiApiRange: '^1.0.0' }],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] },
            }),
        });
        const successor = intentResponse(change === 'release' ? '2.0.0' : '1.2.3', change !== 'disable', 2);
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 0, materializations: [], snapshots: [],
            intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID, response: intentResponse('1.2.3', true, 0) }],
        } });
        const reader = readPluginAccountAvailability(scope);
        expect(reader.readCurrentArtifact(slot)).toMatchObject({ kind: 'available', artifact: { releaseVersion: '1.2.3' } });
        const firstReadStarted = createDeferred<void>();
        const releaseFirstRead = createDeferred<void>();
        let readCount = 0;
        domainHttp.mockImplementation(async ({ url }) => {
            const path = new URL(url).pathname;
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                readCount += 1;
                if (readCount === 1) {
                    firstReadStarted.resolve();
                    await releaseFirstRead.promise;
                }
                return jsonResponse({ availabilityCursor: 2, snapshots: [] });
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return jsonResponse({ availabilityCursor: 2, pluginIds: [AVAILABILITY_PLUGIN_ID], failedPluginIds: [],
                    intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID, response: successor }],
                });
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set']) {
                return jsonResponse({ intent: successor.intent });
            }
            return jsonResponse({});
        });
        const changePage = (cursor: number) => ({ changes: [{ cursor, kind: 'pluginDomain',
            entityId: `pluginDomain/${AVAILABILITY_PLUGIN_ID}/availability`, changedAt: cursor,
            hint: { pluginDomain: 'availability', pluginId: AVAILABILITY_PLUGIN_ID } }], nextCursor: String(cursor) });
        changesResponse.mockResolvedValueOnce(changePage(1)).mockResolvedValueOnce(changePage(2));
        try {
            await harness.handleUpdate(accountChangeWake('availability-first'));
            await firstReadStarted.promise;
            await waitForHomeGovernance(() => expect(harness.resumeInFlight).toBeNull());
            if (change === 'release') {
                const { setActivePluginAccountAvailabilityIntent } = await import('./api/plugins/availability/setActivePluginAccountAvailabilityIntent');
                const { revision: _revision, ...intent } = successor.intent!;
                await expect(setActivePluginAccountAvailabilityIntent({ ...intent, expectedRevision: '0' }))
                    .resolves.toMatchObject({ kind: 'updated', intent: { desiredVersion: '2.0.0' } });
            }
            await harness.handleUpdate(accountChangeWake('availability-disabled'));
            await waitForHomeGovernance(() => expect(harness.changesCursor).toBe('2'));
            releaseFirstRead.resolve();
            const queue = harness as typeof harness & { pluginAvailabilitySync: { awaitQueue(): Promise<unknown> } };
            await queue.pluginAvailabilitySync.awaitQueue();
            expect(reader.readMaterializations()).toMatchObject({ kind: 'available', availabilityCursor: 2,
                intentReads: [{ pluginId: AVAILABILITY_PLUGIN_ID, response: { intent: successor.intent } }],
            });
            expect(reader.readCurrentArtifact(slot)).toMatchObject(change === 'disable'
                ? { kind: 'unavailable', code: 'artifact_not_current' }
                : { kind: 'available', artifact: { releaseVersion: '2.0.0', digest: `sha256:${'b'.repeat(64)}` } });
        } finally {
            releaseFirstRead.resolve();
            harness.disconnectServer();
        }
    });

    it.each(['present', 'malformed', 'absent', 'deleted'] as const)('materializes a cold Session draft from one change page without transcript or Account collection reads (%s)', async status => {
        await loadTestSync();
        // Prior cases retain device-local drafts. The restored empty Home census
        // confirms those rows absent through the genuine exact-read boundary.
        domainHttp.mockImplementation(async ({ url }) => new URL(url).pathname === '/v2/account/session-drafts/read'
            ? jsonResponse({ status: 'absent' }) : Response.json({}, { status: 404 }));
        const { Encryption } = await import('./encryption/encryption');
        const { decodeBase64, encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
        const { createSessionDraftCipher } = await import('./encryption/sessionDraftEncryption');
        const { createSessionDraftRepository, getSessionDraftSnapshot } = await import('./ops/sessionDrafts/sessionDraftRepository');
        const { SESSION_DRAFT_V2_ROUTE_READ } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const secret = new Uint8Array(32).fill(42);
        const authorEncryption = await Encryption.create(secret);
        const address = { kind: 'session' as const, sessionId: 'cold-draft-session' };
        await authorEncryption.initializeSessions(new Map([[address.sessionId, null]]));
        const sessionEncryption = authorEncryption.getSessionEncryption(address.sessionId)!;
        const cipher = createSessionDraftCipher({ accountMode: 'e2ee', accountCryptoMaterial: { type: 'legacy', secret },
            getSessionContext: () => ({ mode: 'e2ee', encryption: sessionEncryption }), randomBytes: length => new Uint8Array(length) });
        const values = new Map<string, string>();
        const author = createSessionDraftRepository({ cipher, syncEnabled: false,
            storage: { getString: key => values.get(key), set: (key, value) => values.set(key, value), delete: key => values.delete(key) } });
        const paths: string[] = [];
        await restoreTestAccount({ credentials: { token: ACCOUNT_TOKEN, secret: encodeBase64(secret, 'base64url') },
            accountMode: 'e2ee', draftsEnabled: true, onRequest: path => paths.push(path) });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Restoration must establish the Account scope');
        const { sync } = await import('./syncEngine');
        const syncHarness = sync as unknown as SyncAccountChangeCatchUpHarness & {
            encryption: Awaited<ReturnType<typeof Encryption.create>>;
            ensureSessionDraftRepositoryRuntimeReady(): Promise<void>;
        };
        // Complete the real Account draft bootstrap before measuring one change page.
        await syncHarness.ensureSessionDraftRepositoryRuntimeReady();
        storage.getState().applyServerScopedSessionListRows(scope.serverId, [createSessionListRenderableSessionFixture({
            id: address.sessionId, encryptionMode: 'e2ee',
        })], { source: 'ordinary', mode: 'append' });
        expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
        // Keep the reader cold: only the remote author has the Session cipher.
        // Catch-up must acquire its exact encryption context without full hydration.
        expect(syncHarness.encryption.getSessionEncryption(address.sessionId)).toBeNull();
        author.writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { text: 'retained draft' } });
        const document = author.getSessionDraftSnapshot(scope, address)!.document;
        const content = await cipher.seal(address, document);
        if (content.t !== 'encrypted') throw new Error('The E2EE Session fixture must seal encrypted content');
        const tamperedBytes = decodeBase64(content.c);
        tamperedBytes[tamperedBytes.length - 1] ^= 1;
        const tamperedContent = { ...content, c: encodeBase64(tamperedBytes) };
        const sessionRecord = SessionCurrentProjectionRecordV1Schema.parse({
            id: address.sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 0,
            encryptionMode: 'e2ee', dataEncryptionKey: null, metadataLayoutVersion: 0,
            metadataVersion: 1, metadata: await sessionEncryption.encryptRaw({ path: '/fixture', host: 'fixture' }),
            agentStateVersion: 0, agentState: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
        });
        domainHttp.mockImplementation(async ({ url }) => {
            const path = new URL(url).pathname;
            if (path === SESSION_DRAFT_V2_ROUTE_READ) return jsonResponse(status === 'absent' ? { status } : {
                status: status === 'malformed' ? 'present' : status,
                record: { address, revision: 0, createdAt: 1, updatedAt: 1,
                    content: status === 'deleted' ? null : status === 'malformed' ? tamperedContent : content },
            });
            if (path === `/v2/sessions/${address.sessionId}`) return jsonResponse({ session: sessionRecord });
            return Response.json({}, { status: 404 });
        });
        changesResponse.mockResolvedValue({ changes: [{ cursor: 1, kind: 'account',
            entityId: `session-draft:session/${address.sessionId}`, changedAt: 1,
            hint: { v: 1, sessionDraft: true, address, revision: 0, status: status === 'deleted' ? 'deleted' : 'present' },
        }], nextCursor: '1' });
        paths.length = 0;
        changesResponse.mockClear();
        const previousCursor = syncHarness.changesCursor;
        await syncHarness.resumeViaChanges({ accountId: ACCOUNT_ID });
        expect(changesResponse).toHaveBeenCalledOnce();
        if (status === 'malformed') {
            expect(syncHarness.changesCursor).toBe(previousCursor);
            expect(getSessionDraftSnapshot(scope, address)).toBeNull();
        } else {
            expect(syncHarness.changesCursor).toBe('1');
            if (status === 'present') expect(getSessionDraftSnapshot(scope, address)).toMatchObject({
                status: 'clean', document: { composer: { text: { value: 'retained draft' } } },
            });
            else expect(getSessionDraftSnapshot(scope, address)).toBeNull();
        }
        expect(paths.filter(path => path === SESSION_DRAFT_V2_ROUTE_READ)).toHaveLength(1);
        expect(paths.filter(path => path === `/v2/sessions/${address.sessionId}`)).toHaveLength(status === 'present' || status === 'malformed' ? 1 : 0);
        expect(paths.every(path => ['/v2/changes', SESSION_DRAFT_V2_ROUTE_READ, `/v2/sessions/${address.sessionId}`].includes(path))).toBe(true);
        expect(storage.getState().sessionMessages[address.sessionId]?.isLoaded).not.toBe(true);
    });

    it('keeps the applied Account lifetime and in-flight reads through same-Home auth refreshes', async () => {
        await restoreTestAccount({ mountAuth: true });
        const { captureActiveServerAccountScopeLifetime } = await import('./domains/scope/activeServerAccountScope');
        const { getCurrentAuth } = await import('@/auth/context/currentAuth');
        const { serverFetch } = await import('./http/client');
        const { profileParse } = await import('./domains/profiles/profile');
        const { storage } = await import('./domains/state/storage');
        const lifetime = captureActiveServerAccountScopeLifetime();
        const auth = getCurrentAuth();
        if (!lifetime || !auth) throw new Error('Restoration must establish the mounted Account');
        const requestIssued = createDeferred<void>();
        const releaseProfile = createDeferred<void>();
        profileResponseGate.mockImplementationOnce(async () => {
            requestIssued.resolve();
            await releaseProfile.promise;
        });
        const pendingProfile = serverFetch('/v1/account/profile', { method: 'GET' }, { retry: 'none' })
            .then(async response => profileParse(await response.json()));
        // Keep rejected transport promises observed while the held HTTP boundary is released.
        void pendingProfile.catch(() => undefined);
        try {
            await requestIssued.promise;
            await act(async () => {
                await auth.refreshFromActiveServer();
                await auth.refreshFromActiveServer();
                storage.getState().activateProfileScope({ ...lifetime.scope });
            });
            expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
            expect(lifetime.isCurrent()).toBe(true);
            releaseProfile.resolve();
            await expect(pendingProfile).resolves.toMatchObject({ id: ACCOUNT_ID });
            expect(storage.getState().isDataReady).toBe(true);
        } finally {
            releaseProfile.resolve();
            await pendingProfile.catch(() => undefined);
        }
    });

    it('keeps mounted Account-mode disclosure through Settings and Connected Service changes', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { captureActiveServerAccountScopeLifetime } = await import('./domains/scope/activeServerAccountScope');
        const { getAccountEncryptionModeCacheRevision } = await import('./api/account/apiAccountEncryptionMode');
        const { usePluginSurfaceAccountEncryptionMode } = await import('@/components/plugins/surfaces/pluginSurfaceContext');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !harness.credentials) throw new Error('Restoration must establish the Account');
        const credentials = harness.credentials;
        const isCurrent = () => lifetime.isCurrent();
        const disclosures: Array<ReturnType<typeof usePluginSurfaceAccountEncryptionMode>> = [];
        const hook = await renderHook(() => {
            const mode = usePluginSurfaceAccountEncryptionMode({ accountLifetime: lifetime, credentials, isCurrent });
            disclosures.push(mode);
            return mode;
        });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
            disclosures.length = 0;
            const revision = getAccountEncryptionModeCacheRevision();
            changesResponse.mockResolvedValueOnce({
                changes: [
                    { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { connectedServices: true } },
                    { cursor: 2, kind: 'account', entityId: 'self', changedAt: 2, hint: { settingsVersion: 1 } },
                ],
                nextCursor: '2',
            });
            await act(async () => {
                await expect(harness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({ status: 'ok' });
            });
            expect(disclosures.every(disclosure => disclosure.status === 'ready' && disclosure.mode === 'plain')).toBe(true);
            expect(getAccountEncryptionModeCacheRevision()).toBe(revision);
            expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' });
            expect(harness.changesCursor).toBe('2');
            // A migration changes both Settings and mode. Its extra hint must
            // not be mistaken for an ordinary Settings write.
            disclosures.length = 0;
            changesResponse.mockResolvedValueOnce({
                changes: [{ cursor: 3, kind: 'account', entityId: 'self', changedAt: 3,
                    hint: { settingsVersion: 2, accountEncryptionTransitionId: 'transition-1' } }],
                nextCursor: '3',
            });
            await act(async () => {
                await expect(harness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({ status: 'ok' });
            });
            expect(disclosures).toContainEqual({ status: 'loading' });
            expect(getAccountEncryptionModeCacheRevision()).toBeGreaterThan(revision);
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
        } finally {
            await hook.unmount();
        }
    });

    it('publishes a fetched AccountChange and its kind to the Home whose cursor was read when focus changes in flight', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { getActiveServerSnapshot, upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim();

        let releaseChanges!: () => void;
        const changesReleased = new Promise<void>((resolve) => {
            releaseChanges = resolve;
        });
        let markChangesStarted!: () => void;
        const changesStarted = new Promise<void>((resolve) => {
            markChangesStarted = resolve;
        });
        changesResponse.mockImplementationOnce(async () => {
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
        try {
            await changesStarted;
            const focusedServer = await upsertAndActivateServer({
                serverUrl: 'http://localhost:53289',
                scope: 'tab',
            });
            expect(focusedServer.id).not.toBe(sourceServerId);
            releaseChanges();

            await expect(catchUp).resolves.toMatchObject({ status: 'ok' });
            expect(observedWakes).toMatchObject([{
                serverId: sourceServerId,
                entityIds: ['self'],
                changeKinds: ['account'],
                // An unqualified self change can alter credential/Account currentness.
                sessionListQueryAffects: true,
            }]);
        } finally {
            releaseChanges();
            dispose();
            harness.disconnectServer();
        }
    });

    it('keeps an AccountChange refresh on the applied Home while another Home is staged', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { getActiveServerSnapshot, upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const appliedSnapshot = getActiveServerSnapshot();
        const appliedServerId = String(appliedSnapshot.serverId ?? '').trim();
        changesResponse.mockResolvedValueOnce({
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
        expect(stagedSnapshot.serverId).not.toBe(appliedServerId);
        // Selecting a Home cannot grant its Account an applied runtime lifetime.
        expect(getActiveServerAccountScope()).toEqual({ serverId: appliedServerId, accountId: ACCOUNT_ID });

        const observedWakes: Array<{ serverId: string }> = [];
        const dispose = subscribeHomeAccountChange((event) => observedWakes.push(event));
        await expect(harness.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
            status: 'ok',
        });

        expect(changesResponse).toHaveBeenCalledOnce();
        expect(observedWakes).toEqual([expect.objectContaining({ serverId: appliedServerId })]);
        dispose();
        harness.disconnectServer();
    });

    it.each([{ mode: 'plain', retained: false }, { mode: 'plain', retained: true }, { mode: 'e2ee', retained: true }] as const)(
        'refreshes a visible Home title from an omitted metadata push ($mode, retained Session: $retained)', async ({ mode, retained }) => {
        const sessionId = 'renamed-home-row';
        const { Encryption } = await import('./encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { createLegacyAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        const { sealSessionOwnerMetadataEnvelopeV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
        const { createSessionDisplayCrypto } = await import('./encryption/sessionDisplayCrypto');
        const secret = new Uint8Array(32).fill(61);
        const key = new Uint8Array(32).fill(71);
        const credentials = mode === 'e2ee' ? { token: ACCOUNT_TOKEN, secret: encodeBase64(secret) } : { token: ACCOUNT_TOKEN };
        const currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
        const author = await Encryption.create(secret);
        await author.initializeSessions(new Map([[sessionId, key]]));
        const cipher = author.getSessionEncryption(sessionId)!;
        const dataEncryptionKey = encodeBase64(await author.encryptEncryptionKey(key));
        const displayCrypto = createSessionDisplayCrypto({ sessionMode: mode, accountMode: mode, credentials, sessionEncryption: cipher });
        const buildRow = async (version: number, title: string) => {
            const plain = createPlainSessionWithDisplayRecordFixture({ id: sessionId, metadataVersion: version,
                metadata: { path: '/rename', host: 'home', summary: { text: title, updatedAt: version } } });
            if (mode === 'plain') return plain;
            if (plain.ownerMetadata?.t !== 'plain' || plain.displayProjectionV1?.shared.t !== 'plain'
                || plain.displayProjectionV1.owner?.t !== 'plain') throw new Error('Expected plain fixture envelopes');
            return SessionCurrentProjectionRecordV1Schema.parse({ ...plain, encryptionMode: mode,
                metadata: await cipher.encryptRaw(JSON.parse(plain.metadata!)),
                agentState: plain.agentState ? await cipher.encryptRaw(JSON.parse(plain.agentState)) : null,
                ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                    ownerMetadata: plain.ownerMetadata.v, randomBytes: length => new Uint8Array(length).fill(73) }),
                dataEncryptionKey,
                displayProjectionV1: { ...plain.displayProjectionV1,
                    shared: await displayCrypto.encodeSharedDisplay(plain.displayProjectionV1.shared.v.display),
                    owner: displayCrypto.encodeOwnerDisplay(plain.displayProjectionV1.owner.v.display) },
            });
        };
        let row = await buildRow(1, 'Before rename');
        const requests: string[] = [];
        domainHttp.mockImplementation(async ({ url }) => new URL(url).pathname === `/v2/sessions/${sessionId}`
            ? jsonResponse({ session: row, observationCursor: row.metadataVersion === 1 ? 0 : 9 }) : Response.json({}, { status: 404 }));
        await restoreTestAccount({ credentials, accountMode: mode, physicalRequest: (url) => {
            const path = new URL(url).pathname;
            requests.push(path);
            return mode === 'e2ee' && path === '/v1/account/encryption/currentness' ? Promise.resolve(jsonResponse(currentness)) : undefined;
        } });
        const runtime = syncRuntime;
        if (!runtime || !account) throw new Error('Expected restored Account');
        const { storage } = await import('./domains/state/storage');
        const { retainVisibleSessionListSurfaces } = await import('./domains/session/sessionSurfaceVisibility');
        const { getSessionName } = await import('@/utils/sessions/sessionUtils');
        const serverId = account.serverId;
        await (runtime as unknown as {
            refreshSessionListRowProjection(serverId: string, sessionId: string): Promise<void>;
        }).refreshSessionListRowProjection(serverId, sessionId);
        const homeRow = () => storage.getState().sessionListRowsByServerId[serverId]![sessionId]!;
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        if (retained) {
            const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
            const releaseViewer = registerSessionRealtimeTranscriptConsumer(sessionId, serverId);
            try {
                await runtime.ensureSessionVisibleForMessageRoute(sessionId, { serverId,
                    hydrateMessages: false, includeTurnsProjection: false });
                expect(storage.getState().sessions[sessionId]?.metadataVersion).toBe(1);
            } finally { releaseViewer(); }
        }
        expect(getSessionName(homeRow())).toBe('Before rename');
        const release = retainVisibleSessionListSurfaces([{ serverId, sessionId }]);
        const { useSessionListRowRenderablesForItems } = await import('./store/hooks');
        const items = [{ type: 'session' as const, serverId, sessionId }];
        const hook = await renderHook(() => useSessionListRowRenderablesForItems(items));
        const renderedRow = () => [...hook.getCurrent().values()][0]!;
        expect(getSessionName(renderedRow())).toBe('Before rename');
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { sessionRuntimeObservations } = await import('./domains/session/sessionRuntimeObservation');
        const wakes: unknown[] = [];
        const unsubscribe = subscribeHomeAccountChange(event => wakes.push(event));
        const wakeRuntime = runtime as unknown as SyncAccountChangeWakeSchedulingHarness;
        const durableCursor = wakeRuntime.changesCursor;
        try {
            requests.length = 0;
            row = await buildRow(2, 'After rename');
            const socket = sockets.findLast(candidate => candidate.listenersAny().length > 0)!;
            await act(async () => {
                for (const listener of socket.listenersAny()) listener('update', { id: 'rename-hint', seq: 9, createdAt: 9,
                    body: { t: 'update-session', id: sessionId, metadataLayoutVersion: 1,
                        metadataDocument: 'omitted', metadataVersion: 2 } });
                await waitForHomeGovernance(() => expect(sessionRuntimeObservations.read({ serverId, sessionId })?.serverObservationCursor).toBe(9));
                await wakeRuntime.handleUpdate({ ...accountChangeWake('covered-rename'), body: { t: 'account-change',
                    changeKinds: ['session'], entityIds: [sessionId], sessionSystemRecords: [] } });
                await waitForHomeGovernance(() => expect(getSessionName(homeRow())).toBe('After rename'));
            });
            expect(wakes).toEqual([]);
            expect(wakeRuntime.changesCursor).toBe(durableCursor);
            await waitForHomeGovernance(() => expect(getSessionName(renderedRow())).toBe('After rename'));
            expect(storage.getState().sessions[sessionId]?.metadataVersion).toBe(retained ? 1 : undefined);
            expect(requests.filter(path => path === '/v2/sessions/read-batch')).toHaveLength(1);
            expect(requests).not.toContain('/v2/changes');
            expect(requests).not.toContain('/v2/sessions');
        } finally { unsubscribe(); release(); await hook.unmount(); }
    });

    it('keeps a covered Session wake quiet without advancing the durable feed and repairs the next uncovered cursor', async () => {
        const runtime = await prepareAccountChangeWakeSchedulingHarness();
        const { storage } = await import('./domains/state/storage');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const sessionId = 'covered-session-write';
        const scope = runtime.getChangesCursorScope();
        if (!scope || typeof scope === 'string' || !scope.serverScope) throw new Error('Expected the Account Home scope');
        const persistedCursorBefore = loadChangesCursor(scope);
        storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId: scope.serverScope,
            encryptionMode: 'plain', metadataVersion: 1, agentStateVersion: 1 })]);
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const releaseViewer = registerSessionRealtimeTranscriptConsumer(sessionId, scope.serverScope);
        try {
            await runtime.handleUpdate({ id: 'covered-current-view', seq: 9, createdAt: 9, body: {
                t: 'update-session', id: sessionId, agentState: { version: 2, value: JSON.stringify({ controlledByUser: true }) },
                metadata: { version: 2, value: JSON.stringify({ path: '/rename', host: 'home',
                    summary: { text: 'Covered rename', updatedAt: 2 } }) },
            } });
            const wake = { ...accountChangeWake('covered-wake'), body: { t: 'account-change',
                changeKinds: ['session'], entityIds: [sessionId], sessionSystemRecords: [] } };
            await runtime.handleUpdate(wake);
            const { getSessionName } = await import('@/utils/sessions/sessionUtils');
            await waitForHomeGovernance(() => expect(getSessionName(storage.getState().sessionListRowsByServerId[scope.serverScope]![sessionId]!)).toBe('Covered rename'));
            expect(changesResponse).not.toHaveBeenCalled();
            expect(runtime.changesCursor).toBe('0');
            expect(loadChangesCursor(runtime.getChangesCursorScope())).toBe(persistedCursorBefore);
            await runtime.handleUpdate({ ...wake, id: 'next-uncovered-wake', seq: 10 });
            await waitForHomeGovernance(() => expect(changesResponse).toHaveBeenCalledOnce());
            await waitForHomeGovernance(() => expect(runtime.resumeInFlight).toBeNull());
            expect(new URL(changesResponse.mock.calls[0]![0].url).searchParams.get('after')).toBe('0');
        } finally { releaseViewer(); }
    });

    it('coalesces wakes received after a changes response into one trailing canonical catch-up', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const observed: Array<readonly string[] | undefined> = [];
        const dispose = subscribeHomeAccountChange(({ entityIds }) => observed.push(entityIds));
        const profileStarted = createDeferred<void>();
        const releaseProfile = createDeferred<void>();
        profileResponseGate.mockImplementationOnce(async () => {
            profileStarted.resolve();
            await releaseProfile.promise;
        });
        changesResponse.mockResolvedValue({ changes: [], nextCursor: '1' }).mockResolvedValueOnce({
            changes: [{ cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: null }], nextCursor: '1',
        });
        const firstResume = harness.resumeSync('manual');
        try {
            await profileStarted.promise;
            // The page arrived; its real profile materialization still owns the resume slot.
            await Promise.all([1, 2, 3].map(id => harness.handleUpdate(accountChangeWake(`account-change-${id}`))));
            expect(changesResponse).toHaveBeenCalledOnce();
            releaseProfile.resolve();
            await firstResume;
            await waitForHomeGovernance(() => {
                expect(changesResponse).toHaveBeenCalledTimes(2);
                expect(harness.resumeInFlight).toBeNull();
            });
            expect(changesResponse.mock.calls.map(([request]) => new URL(request.url).searchParams.get('after'))).toEqual(['0', '1']);
            expect(loadChangesCursor(harness.getChangesCursorScope())).toBe('1');
            expect(observed).toEqual([['self']]);
        } finally {
            releaseProfile.resolve();
            dispose();
        }
    });

    it('keeps Follow and private-rule reads at zero for 1,000 unrelated Account arrivals, then refreshes a real Follow change', async () => {
        await restoreTestAccount({ followingEnabled: true });
        const { sync } = await import('./syncEngine');
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { InboxExecutionRunSourceBoundary, useInboxExecutionRunSource } = await import('@/hooks/inbox/useInboxExecutionRunSource');
        const { useSessionAutoFollowPreferences } = await import('@/components/sessions/follow/useSessionAutoFollowPreferences');
        const { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } = await import('@happier-dev/protocol/sessions/follow/changes');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { publishHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const serverId = getActiveServerAccountScope()!.serverId;
        const reads = { follows: 0, rules: 0, preferences: 0 };
        const preferencesPath = resolveSessionFollowActionRequest('follow.preferences.get', {}).path;
        let assigned = true;
        domainHttp.mockImplementation(async ({ url }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/auth/ping') return jsonResponse({});
            if (path === '/v2/account/session-follows') { reads.follows++; return jsonResponse({ follows: [] }); }
            if (path === '/v2/account/session-follow-rules') { reads.rules++; return jsonResponse({ rules: [] }); }
            if (path === preferencesPath) {
                reads.preferences++;
                return jsonResponse({ assigned, direct: false, team: false, group: false });
            }
            return Response.json({}, { status: 404 });
        });
        const hook = await renderHook(() => ({ runs: useInboxExecutionRunSource(), preferences: useSessionAutoFollowPreferences(serverId) }),
            { wrapper: ({ children }) => React.createElement(InboxExecutionRunSourceBoundary, { children }) });
        const releaseChanges = createDeferred<void>();
        const changesStarted = createDeferred<void>();
        try {
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().runs).toMatchObject({ loading: false, failed: false });
                expect(hook.getCurrent().preferences.displayed?.assigned).toBe(true);
            });
            const baseline = { ...reads };
            expect(baseline).toEqual({ follows: 1, rules: 0, preferences: 1 });
            changesResponse.mockResolvedValue({ changes: [], nextCursor: 1 }).mockImplementationOnce(async () => {
                changesStarted.resolve(); await releaseChanges.promise;
                return { changes: [{ cursor: 1, kind: 'machine', entityId: 'unrelated-machine', changedAt: 1, hint: null }], nextCursor: 1 };
            });
            await act(async () => runtime.handleUpdate(accountChangeWake('unrelated-first')));
            await waitForHomeGovernance(() => expect(changesResponse).toHaveBeenCalled());
            await changesStarted.promise;
            await act(async () => {
                for (let index = 1; index < 1_000; index++) await runtime.handleUpdate(accountChangeWake(`unrelated-${index}`));
            });
            expect(reads).toEqual(baseline);
            releaseChanges.resolve();
            await waitForHomeGovernance(() => expect(runtime.resumeInFlight).toBeNull());
            expect(reads).toEqual(baseline);

            assigned = false;
            changesResponse.mockResolvedValue({ changes: [], nextCursor: 2 }).mockResolvedValueOnce({ changes: [{
                cursor: 2, kind: 'account', entityId: ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID,
                changedAt: 2, hint: null,
            }], nextCursor: 2 });
            await act(async () => runtime.handleUpdate(accountChangeWake('follow-mutated')));
            await waitForHomeGovernance(() => {
                expect(runtime.resumeInFlight).toBeNull();
                expect(hook.getCurrent().runs).toMatchObject({ loading: false, failed: false });
                expect(hook.getCurrent().preferences.displayed?.assigned).toBe(false);
            });
            expect(reads).toEqual({ follows: baseline.follows + 1, rules: baseline.rules, preferences: baseline.preferences + 1 });

            // A truly unqualified/reconnect or access wake is not an unrelated fact.
            for (const detail of [{}, { source: 'connected' as const }, { changeKinds: ['share'] as const }]) {
                const before = { ...reads };
                await act(async () => publishHomeAccountChange(serverId, undefined, detail));
                await waitForHomeGovernance(() => expect(reads).toEqual({ follows: before.follows + 1,
                    rules: before.rules, preferences: before.preferences + 1 }));
                await waitForHomeGovernance(() => expect(hook.getCurrent().runs.loading).toBe(false));
            }
            const beforeRetirement = { ...reads };
            const { storage } = await import('./domains/state/storage');
            await act(async () => storage.getState().clearProfileScope());
            await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
            expect(hook.getCurrent().runs.entries).toEqual([]);
            expect(hook.getCurrent().preferences.displayed).toBeNull();
            expect(reads).toEqual(beforeRetirement);
        } finally {
            releaseChanges.resolve(); await runtime.resumeInFlight; await hook.unmount();
        }
    });

    it('publishes no content-free Home change for a focused-Home wake and asks for the exact page instead', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        const changesStarted = createDeferred<void>();
        const releaseChanges = createDeferred<void>();
        changesResponse.mockImplementationOnce(async () => {
            changesStarted.resolve();
            await releaseChanges.promise;
            return { changes: [{ cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: null }], nextCursor: '1' };
        });
        const observed: Array<Readonly<{ serverId: string; entityIds?: readonly string[] }>> = [];
        const dispose = subscribeHomeAccountChange((event) => observed.push(event));

        try {
            await harness.handleUpdate(accountChangeWake('account-change-focused'));
            await changesStarted.promise;
            expect(observed).toEqual([]);
            releaseChanges.resolve();
            await waitForHomeGovernance(() => expect(harness.resumeInFlight).toBeNull());
            expect(changesResponse).toHaveBeenCalledOnce();
            expect(observed).toEqual([expect.objectContaining({ entityIds: ['self'] })]);
        } finally {
            releaseChanges.resolve();
            dispose();
        }
    });

    it('reuses current off-page pinned Session admission across identical inventory refreshes and repairs a pushed revision', async () => {
        let pinned = createPlainSessionCurrentProjectionRecordFixture({ id: 'off-page-admitted-pin' });
        const batches: string[][] = [];
        await restoreTestAccount({
            physicalRequest: (url, init) => {
                if (new URL(url).pathname === '/v2/sessions/read-batch') {
                    batches.push([...SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body))).sessionIds]);
                }
                return undefined;
            },
            runtimeRequest: path => {
                if (path === '/v2/session-organization') return jsonResponse({ snapshot: {
                    schemaVersion: 1, version: 1,
                    pins: [{ sessionId: pinned.id, sortKey: null, pinnedAt: 1, listPinned: true, railPinned: false }],
                    folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
                } });
                return path === `/v2/sessions/${pinned.id}` ? jsonResponse({ session: pinned }) : undefined;
            },
        });
        if (!syncRuntime || !account) throw new Error('Expected restored Sync');
        const sync = syncRuntime;
        const serverId = account.serverId;
        const { storage } = await import('./domains/state/storage');
        await sync.refreshSessions({ awaitSessionListHydration: true });
        expect(batches).toEqual([[pinned.id]]);
        expect(storage.getState().sessions[pinned.id]?.metadataVersion).toBe(1);
        const retainedRow = storage.getState().sessionListRowsByServerId[serverId]?.[pinned.id];
        expect(retainedRow).toBeDefined();
        batches.length = 0;
        for (let refreshIndex = 0; refreshIndex < 3; refreshIndex++) {
            await sync.refreshSessions({ awaitSessionListHydration: true });
            expect(storage.getState().sessionListRowsByServerId[serverId]?.[pinned.id]).toBe(retainedRow);
        }
        expect(batches).toEqual([]);
        pinned = createPlainSessionCurrentProjectionRecordFixture({ id: pinned.id, seq: 2, updatedAt: 2,
            metadataVersion: 2, metadata: { path: '/pin-updated', host: 'home' } });
        await sync.consumeSessionRealtimeUpdateForHome({ serverId, credentials: account.credentials,
            encryption: null, isCurrent: () => true,
            update: { id: 'off-page-pin-revision', seq: 2, createdAt: 2, body: { t: 'update-session', id: pinned.id,
                metadataLayoutVersion: 1, metadataDocument: 'omitted', metadataVersion: 2 } },
        });
        await sync.refreshSessions({ awaitSessionListHydration: true });
        expect(batches).toEqual([[pinned.id]]);
        expect(storage.getState().sessions[pinned.id]?.ownerMetadataView?.path).toBe('/pin-updated');
    });

    it('drops a queued AccountChange wake when its server/account lifetime resets', async () => {
        const harness = await prepareAccountChangeWakeSchedulingHarness();
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const scope = harness.getChangesCursorScope();
        const cursorBefore = loadChangesCursor(scope);
        const changesStarted = createDeferred<void>();
        const releaseChanges = createDeferred<void>();
        changesResponse.mockImplementationOnce(async () => {
            changesStarted.resolve();
            await releaseChanges.promise;
            return { changes: [], nextCursor: '1' };
        });
        const firstResume = harness.resumeSync('manual');
        try {
            await changesStarted.promise;
            await harness.handleUpdate(accountChangeWake('account-change-before-reset'));
            harness.disconnectServer();
            releaseChanges.resolve();
            await firstResume;
            await waitForHomeGovernance(() => expect(harness.resumeInFlight).toBeNull());
            expect(changesResponse).toHaveBeenCalledOnce();
            expect(loadChangesCursor(scope)).toBe(cursorBefore);
        } finally {
            releaseChanges.resolve();
        }
    });

    it.each([false, true])('repairs a missing embed cursor with a fresh detail acquisition (retired: %s)', async (retired) => {
        vi.stubGlobal('window', { location: { pathname: '/embed/session/embed' }, localStorage: globalThis.localStorage,
            addEventListener: vi.fn(), removeEventListener: vi.fn() });
        await loadTestSync();
        const { sync } = await import('./syncEngine');
        const owner = sync as unknown as SyncAccountChangeCatchUpHarness;
        const oldDetailStarted = createDeferred<void>();
        const cursorCaptured = createDeferred<void>();
        const oldDetail = createDeferred<void>();
        const freshDetail = createDeferred<void>();
        let detailReads = 0;
        let cursorReads = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') return currentAccountStoredContentCompatibilityFeaturesResponse();
            if (url.pathname === '/v2/cursor') {
                if (++cursorReads === 1) return new Response(null, { status: 503 });
                cursorCaptured.resolve();
                return jsonResponse({ cursor: 9, changesFloor: 0 });
            }
            if (url.pathname === '/v2/changes') return jsonResponse({ changes: [], nextCursor: 9 });
            if (url.pathname === '/v2/sessions/embed') {
                const read = ++detailReads;
                const level = read === 1 ? 'view' : 'edit';
                const response = jsonResponse({ session: {
                    id: 'embed', createdAt: 1, updatedAt: read, seq: 0, active: false, activeAt: 0,
                    encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                    metadataVersion: read, metadata: JSON.stringify({ path: '/hidden', host: 'hidden', name: 'Embedded' }),
                    agentStateVersion: 0, agentState: null, share: null,
                    responsibleAccountId: null, responsibleAccount: null,
                    effectiveAccess: { v: 1, level, sources: [],
                        capabilities: projectLegacySessionAccessCapabilitiesV1({ level }) },
                } });
                if (read === 1) oldDetailStarted.resolve();
                await (read === 1 ? oldDetail.promise : freshDetail.promise);
                return response;
            }
            if (url.pathname === '/v1/sessions/embed/turns') return jsonResponse({ v: 1, sessionId: 'embed', updatedAt: 1, turns: [] });
            if (url.pathname === '/v1/sessions/embed/messages') return jsonResponse({ messages: [], nextAfterSeq: null });
            if (url.pathname === '/v2/sessions/embed/pending') return jsonResponse({ pending: [], pendingVersion: 0 });
            throw new Error(`Account request escaped embed: ${url.pathname}`);
        }));
        const bootstrap = sync.create({ token: 'hap_v1_child' }, null, undefined, {
            scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
            endpointUrl: 'http://localhost:53288', accountMode: 'plain', approvalGranted: false,
            isCurrent: () => true, onCredentialRejected: () => {},
        });
        void bootstrap.catch(() => {});
        let resumed: Promise<void> | undefined;
        try {
            await oldDetailStarted.promise;
            resumed = sync.resumeSync('socket-reconnect');
            void resumed.catch(() => {});
            await cursorCaptured.promise;
            // Let the repair reach the hydration owner while the old detail remains held.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            if (retired) sync.disposeEmbedSession({ preserveSessionState: true });
            oldDetail.resolve();
            if (retired) {
                await Promise.allSettled([bootstrap, resumed]);
                expect(detailReads).toBe(1);
                expect(owner.changesCursor).toBeNull();
            } else {
                await bootstrap;
                await vi.waitFor(() => expect(detailReads).toBe(2));
                expect(owner.changesCursor).toBeNull();
                freshDetail.resolve();
                await resumed;
                const { storage } = await import('./domains/state/storage');
                expect(storage.getState().sessions.embed?.access?.capabilities.submitAgentInput).toBe(true);
                expect(owner.changesCursor).toBe('9');
            }
        } finally {
            oldDetail.resolve(); freshDetail.resolve();
            await Promise.allSettled([bootstrap, resumed]);
        }
    });

    it('discovers metadata upgrades for cursor recovery and authority changes, not unrelated list or hinted changes', async () => {
        let discoveryReads = 0;
        let listReads = 0;
        let metadataVersion = 1;
        const catchUpRequests: string[] = [];
        let initialCursorUnavailable = true;
        await restoreTestAccount({ physicalRequest: url => initialCursorUnavailable && new URL(url).pathname === '/v2/cursor'
            ? Promise.resolve(Response.json({}, { status: 503 })) : undefined, runtimeRequest: (path, init) => {
            if (path === '/v2/cursor' || path === '/v2/changes' || path === '/v2/sessions/metadata-upgrades') {
                catchUpRequests.push(path);
            }
            if (path === '/v2/sessions') listReads++;
            if (path === '/v2/sessions/metadata-upgrades') {
                discoveryReads++;
                return jsonResponse({ sessionIds: [] });
            }
            if (path === '/v2/sessions/unrelated-message-session' || path === '/v2/sessions/unknown-legacy-session') {
                return jsonResponse({ session: createPlainSessionCurrentProjectionRecordFixture({
                    id: path.split('/').at(-1)!, metadataVersion,
                }) });
            }
            // Missing-cursor recovery refreshes the independent Account readers
            // too; acknowledge their real empty protocols so the snapshot settles.
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? undefined;
        } });
        initialCursorUnavailable = false;
        const { sync } = await import('./syncEngine');
        const { storage } = await import('./domains/state/storage');
        const queue = sync as unknown as { sessionsSync: Pick<InvalidateSync, 'awaitQueue'> };
        for (let arrival = 0; arrival < 3; arrival++) {
            sync.invalidateSessionListSnapshot(account!.serverId);
            await queue.sessionsSync.awaitQueue();
        }
        expect(discoveryReads).toBe(0);
        const onUpdate = sockets.at(-1)?.listenersAny()[0];
        expect(onUpdate).toBeDefined();
        for (let arrival = 1; arrival <= 3; arrival++) {
            const previousListReads = listReads;
            onUpdate?.('update', { id: `agent-state-${arrival}`, seq: arrival, createdAt: arrival,
                body: { t: 'update-session', id: 'unrelated-agent-state',
                    metadataLayoutVersion: 0, agentState: { version: arrival, value: '{}' } } });
            await vi.waitFor(() => expect(listReads).toBeGreaterThan(previousListReads));
            await queue.sessionsSync.awaitQueue();
        }
        expect(discoveryReads).toBe(0);
        await sync.refreshSessions({ awaitSessionListHydration: true });
        expect(discoveryReads).toBe(1);

        const catchUp = sync as unknown as SyncAccountChangeCatchUpHarness;
        expect(catchUp.changesCursor).toBeNull();
        catchUpRequests.length = 0;
        changesResponse.mockResolvedValue({ changes: [{ cursor: 1, kind: 'session', entityId: 'unrelated-message-session',
            changedAt: 1, hint: { lastMessageSeq: 1, lastMessageId: 'message-1' } }], nextCursor: 1 });
        // A missing cursor repairs the Account snapshot before reading the hinted
        // page. That recovery must rediscover metadata even after a manual refresh.
        await expect(catchUp.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
            status: 'ok', refreshedByCatchUp: { sessions: true, machines: true },
        });
        expect(catchUpRequests).toEqual(['/v2/cursor', '/v2/sessions/metadata-upgrades', '/v2/changes']);
        expect(discoveryReads).toBe(2);
        expect(catchUp.changesCursor).toBe('1');
        expect(storage.getState().sessionListRowsByServerId[account!.serverId]?.['unrelated-message-session']?.metadataVersion).toBe(1);

        // With cursor coverage established, the next message hint advances its
        // checkpoint without another snapshot-base read or metadata census.
        catchUpRequests.length = 0;
        metadataVersion = 2;
        changesResponse.mockResolvedValue({ changes: [{ cursor: 2, kind: 'session', entityId: 'unrelated-message-session',
            changedAt: 2, hint: { lastMessageSeq: 2, lastMessageId: 'message-2' } }], nextCursor: 2 });
        await expect(catchUp.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({
            status: 'ok', refreshedByCatchUp: { machines: false },
        });
        expect(catchUpRequests).toEqual(['/v2/changes']);
        expect(discoveryReads).toBe(2);
        expect(catchUp.changesCursor).toBe('2');
        expect(storage.getState().sessionListRowsByServerId[account!.serverId]?.['unrelated-message-session']?.metadataVersion).toBe(2);

        changesResponse.mockResolvedValue({ changes: [{ cursor: 3, kind: 'session', entityId: 'unknown-legacy-session',
            changedAt: 3, hint: null }], nextCursor: 3 });
        await catchUp.resumeViaChanges({ accountId: ACCOUNT_ID });
        expect(discoveryReads).toBe(3);
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol/changes');
        changesResponse.mockResolvedValue({ changes: [{ cursor: 4, kind: 'account', entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
            changedAt: 4, hint: null }], nextCursor: 4 });
        await catchUp.resumeViaChanges({ accountId: ACCOUNT_ID });
        expect(discoveryReads).toBe(4);
    });

    it.each([404, 503])('joins concurrent metadata discovery and retains failed demand for the next sync (%s)', async status => {
        const discovery = createDeferred<void>();
        const retryDiscovery = createDeferred<void>();
        let serving = false;
        let discoveryReads = 0;
        let listReads = 0;
        await restoreTestAccount({ physicalRequest: (url) => {
            if (!serving) return undefined;
            const path = new URL(url).pathname;
            if (path === '/v2/sessions') listReads++;
            if (path !== '/v2/sessions/metadata-upgrades') return undefined;
            const attempt = ++discoveryReads;
            return (attempt === 2 ? retryDiscovery.promise : discovery.promise).then(() => attempt === 1
                ? new Response(null, { status })
                : jsonResponse({ sessionIds: [] }));
        } });
        const { sync } = await import('./syncEngine');
        serving = true;
        const first = sync.refreshSessions({ awaitSessionListHydration: true });
        await vi.waitFor(() => expect(discoveryReads).toBe(1));
        const second = sync.refreshSessions();
        try {
            await vi.waitFor(() => expect(listReads).toBe(2));
            discovery.resolve();
            await Promise.all([first, second]);
            expect(discoveryReads).toBe(1);
            sync.invalidateSessionListSnapshot(account!.serverId);
            await vi.waitFor(() => expect(discoveryReads).toBe(2));
            const onUpdate = sockets.at(-1)?.listenersAny()[0];
            expect(onUpdate).toBeDefined();
            onUpdate?.('update', { id: 'share-during-discovery', seq: 1, createdAt: 1,
                body: { t: 'public-share-created', sessionId: 'new-share-candidate' } });
            retryDiscovery.resolve();
            await (sync as unknown as { sessionsSync: Pick<InvalidateSync, 'awaitQueue'> }).sessionsSync.awaitQueue();
            expect(discoveryReads).toBe(3);
            sync.invalidateSessionListSnapshot(account!.serverId);
            await (sync as unknown as { sessionsSync: Pick<InvalidateSync, 'awaitQueue'> }).sessionsSync.awaitQueue();
            expect(discoveryReads).toBe(3);
        } finally {
            discovery.resolve();
            retryDiscovery.resolve();
            await Promise.all([first, second]);
        }
    });

    it('does not open discovered metadata after the Account lifetime retires', async () => {
        const discovery = createDeferred<void>();
        let serving = false;
        let discoveryReads = 0;
        const candidateReads: string[] = [];
        await restoreTestAccount({ physicalRequest: (url) => {
            if (!serving) return undefined;
            const path = new URL(url).pathname;
            if (path === '/v2/sessions/metadata-upgrades') {
                discoveryReads++;
                return discovery.promise.then(() => jsonResponse({ sessionIds: ['retired-candidate'] }));
            }
            if (path === '/v2/sessions/read-batch' || path === '/v2/sessions/retired-candidate') candidateReads.push(path);
            return undefined;
        } });
        const { sync } = await import('./syncEngine');
        serving = true;
        const refresh = sync.refreshSessions({ awaitSessionListHydration: true });
        try {
            await vi.waitFor(() => expect(discoveryReads).toBe(1));
            sync.disconnectServer();
            discovery.resolve();
            await refresh;
            expect(candidateReads).toEqual([]);
        } finally {
            discovery.resolve();
            await refresh;
        }
    });

    it('migrates discovered archived and offscreen owner metadata without UI hydration demand', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { createLegacyAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        const { createCompactSessionListFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
        const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
        const { SessionMetadataTuplePatchV1Schema, SessionSharedMetadataV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const { openSessionOwnerMetadataEnvelopeV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
        const { SessionDisplayProjectionV1Schema, projectSessionDisplayV1 } = await import('@happier-dev/protocol');
        const { openAccountScopedBlobCiphertext } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
        const secret = new Uint8Array(32).fill(61);
        const credentials = { token: ACCOUNT_TOKEN, secret: encodeBase64(secret) };
        const currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
        const writer = await Encryption.create(secret);
        const ids = ['retained-archived-owner', 'retained-offscreen-owner', 'later-shared-owner'];
        await writer.initializeSessions(new Map(ids.map((id, index) => [id, new Uint8Array(32).fill(index + 71)])));
        const sources = await Promise.all(ids.map(async (id, index) => {
            const metadata = { name: `Retained owner ${index}`, path: `/private/retained-${index}`, host: 'retained-host',
                summary: { text: `Historical shared work ${index}`, updatedAt: 42 } };
            const agentState = { controlledByUser: false, requests: {
                retained: { tool: 'Bash', arguments: { command: 'git status' }, createdAt: 3 },
            } };
            const cipher = writer.getSessionEncryption(id)!;
            const { ownerMetadata: _owner, metadataLayoutVersion: _layout, ...base } = createPlainSessionCurrentProjectionRecordFixture({ id });
            const record = SessionCurrentProjectionRecordV1Schema.parse({ ...base,
                active: false, archivedAt: index === 0 ? 7 : null, encryptionMode: 'e2ee', metadataLayoutVersion: 0,
                metadataVersion: 5, metadata: await cipher.encryptRaw(metadata),
                agentStateVersion: 3, agentState: await cipher.encryptRaw(agentState),
                dataEncryptionKey: encodeBase64(await writer.encryptEncryptionKey(new Uint8Array(32).fill(index + 71))),
            });
            return { id, record, metadata, agentState };
        }));
        const http = createSessionMetadataHttpBoundary(() => ({}));
        for (const source of sources) {
            // One discovered candidate is temporarily unavailable at the real
            // detail boundary; the next routine sync must recover it.
            if (source !== sources[1]) http.replaceSession(source.id, source.record);
        }
        const initialSources = sources.slice(0, 2);
        const pending = new Set(initialSources.map(source => source.id));
        const discovery = createDeferred<void>();
        const patches: Array<{ sessionId: string; patch: ReturnType<typeof SessionMetadataTuplePatchV1Schema.parse> }> = [];
        const batches: Array<ReturnType<typeof SessionReadBatchRequestV1Schema.parse>> = [];
        const physicalDetailGets: string[] = [];
        const boundaryFailures: unknown[] = [];
        let serving = false;
        let discoveryReads = 0;
        let listReads = 0;
        const request = createCompactSessionListFetchBoundary(async (url, init) => {
            const path = new URL(url, 'http://localhost:53288').pathname;
            if (path === '/v2/sessions/metadata-upgrades') {
                discoveryReads++;
                await discovery.promise;
                return jsonResponse({ sessionIds: [...pending] });
            }
            if (path === '/v2/sessions' || path === '/v2/sessions/active') {
                listReads++;
                return jsonResponse({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (path === '/v2/sessions/read-batch') {
                batches.push(SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init.body))));
                return undefined;
            }
            const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
            if (detail && init.method === 'PATCH') {
                patches.push({ sessionId: decodeURIComponent(detail[1]!),
                    patch: SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body))) });
            }
            let response: Response | null;
            try { response = http.handle(new URL(url, 'http://localhost:53288'), init); }
            catch (error) { boundaryFailures.push(error); throw error; }
            if (detail && init.method === 'PATCH' && response?.ok) pending.delete(decodeURIComponent(detail[1]!));
            return response ?? undefined;
        });
        await restoreTestAccount({ accountMode: 'e2ee', credentials,
            physicalRequest: (url, init) => {
                const path = new URL(url).pathname;
                const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
                if (serving && detail && ids.includes(detail[1]!) && (init?.method ?? 'GET') === 'GET') {
                    physicalDetailGets.push(detail[1]!);
                }
                if (path === '/v1/account/encryption/currentness') return Promise.resolve(jsonResponse(currentness));
                if (serving && (path.startsWith('/v2/sessions') || path.startsWith('/v1/sessions/') || path === '/v2/session-organization')) {
                    return request(url, init);
                }
                return undefined;
            },
        });
        const { storage } = await import('./domains/state/storage');
        const { sync } = await import('./sync');
        const serverId = account!.serverId;
        const paints: string[] = [];
        const unsubscribe = storage.subscribe((state, previous) => {
            const observation = state.concurrentSessionListCacheByServerId[serverId]?.listObservation;
            if (observation !== previous.concurrentSessionListCacheByServerId[serverId]?.listObservation
                && observation?.phase && listReads > 0) paints.push(observation.phase);
        });
        serving = true;
        const refresh = sync.refreshSessions({ awaitSessionListHydration: true });
        try {
            await vi.waitFor(() => expect(paints).toContain('ready'));
            await vi.waitFor(() => expect(discoveryReads).toBe(1));
            expect(http.writes).toEqual([]);
            expect(initialSources.map(source => storage.getState().sessions[source.id])).toEqual([undefined, undefined]);
            discovery.resolve();
            await refresh;
            expect(boundaryFailures).toEqual([]);
            expect(discoveryReads).toBe(1);
            expect(http.writes).toEqual([sources[0]!.id]);
            // Measure ordinary migration before later retry and deliberate
            // route hydration. Batch-synthesized component reads are not HTTP.
            expect(physicalDetailGets).toEqual([]);
            expect(batches).toHaveLength(1);
            expect(batches[0]!.sessionIds.toSorted()).toEqual(initialSources.map(source => source.id).toSorted());
            http.replaceSession(sources[1]!.id, sources[1]!.record);
            const engine = (await import('./syncEngine')).sync;
            engine.invalidateSessionListSnapshot(serverId);
            await (engine as unknown as { sessionsSync: Pick<InvalidateSync, 'awaitQueue'> }).sessionsSync.awaitQueue();
            expect(discoveryReads).toBe(2);
            expect(http.writes.toSorted()).toEqual(initialSources.map(source => source.id).toSorted());
            for (const source of initialSources) {
                const mutation = patches.find(value => value.sessionId === source.id)?.patch;
                expect(mutation).toMatchObject({ mode: 'owner_migration', source: { metadataLayoutVersion: 0,
                    metadata: { version: 5, ciphertext: source.record.metadata }, ownerMetadata: null,
                    agentState: { version: 3, ciphertext: source.record.agentState } } });
                const response = http.handle(`http://localhost:53288/v2/sessions/${source.id}`);
                if (!response) throw new Error('Missing committed retained Session');
                const committed = SessionCurrentProjectionRecordV1Schema.parse((await response.json()).session);
                expect(committed).toMatchObject({ metadataLayoutVersion: 1, metadataVersion: 6, agentStateVersion: 4,
                    archivedAt: source.record.archivedAt });
                const owner = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee', material: { type: 'legacy', secret }, envelope: committed.ownerMetadata });
                expect(owner).toMatchObject({ ok: true, ownerMetadata: { workspace: {
                    name: source.metadata.name, path: source.metadata.path, host: source.metadata.host,
                } } });
                if (!owner.ok) throw new Error('Committed owner metadata did not open');
                const cipher = writer.getSessionEncryption(source.id)!;
                const sharedMetadata = SessionSharedMetadataV1Schema.parse(await cipher.decryptRaw(committed.metadata));
                expect(sharedMetadata).toMatchObject({ v: 1, summary: source.metadata.summary });
                const expectedDisplay = projectSessionDisplayV1({ sharedMetadata, ownerMetadata: owner.ownerMetadata });
                expect(await cipher.decryptAgentStateResult(4, committed.agentState)).toEqual({ status: 'available', value: source.agentState });
                const display = SessionDisplayProjectionV1Schema.parse(committed.displayProjectionV1);
                expect(display).toMatchObject({ sourceMetadataVersion: 6, metadataLayoutVersion: 1 });
                if (display.owner?.t !== 'encrypted') throw new Error('Missing Account-encrypted owner display');
                const ownerDisplay = openAccountScopedBlobCiphertext({ kind: 'session_owner_display', material: { type: 'legacy', secret }, ciphertext: display.owner.c })?.value;
                expect(ownerDisplay).toMatchObject({ audience: 'owner', purpose: 'session_owner_display', display: {
                    name: source.metadata.name, path: source.metadata.path, host: source.metadata.host,
                } });
                expect(ownerDisplay).toMatchObject({ display: expectedDisplay.owner });
                expect(ownerDisplay).not.toHaveProperty('sessionId');
                expect(JSON.stringify(ownerDisplay)).not.toContain('git status');
                if (display.shared.t !== 'encrypted') throw new Error('Missing Session-encrypted shared display');
                const sharedDisplay = await cipher.decryptRaw(display.shared.c);
                expect(sharedDisplay).toMatchObject({ audience: 'shared', display: expectedDisplay.shared });
                expect(JSON.stringify(sharedDisplay)).not.toContain(source.metadata.path);
                expect(JSON.stringify(sharedDisplay)).not.toContain('git status');
                expect(sharedDisplay).not.toHaveProperty('sessionId');
                expect(storage.getState().sessions[source.id]).toBeUndefined();
                await expect(sync.ensureSessionVisibleForMessageRoute(source.id, {
                    serverId, hydrateMessages: false, forceRefresh: true,
                })).resolves.toMatchObject({ kind: 'available' });
                expect(storage.getState().sessions[source.id]?.ownerMetadataView).toMatchObject(source.metadata);
            }
            const later = sources[2]!;
            pending.add(later.id);
            changesResponse.mockResolvedValue({ changes: [{ cursor: 1, kind: 'share', entityId: later.id,
                changedAt: 1, hint: null }], nextCursor: 1 });
            const catchUp = sync as unknown as SyncAccountChangeCatchUpHarness;
            await catchUp.resumeViaChanges({ accountId: ACCOUNT_ID });
            expect(discoveryReads).toBe(3);
            await vi.waitFor(() => {
                expect(http.writes.toSorted()).toEqual(ids.toSorted());
            });
            expect(storage.getState().sessions[later.id]).toBeUndefined();
            await expect(sync.ensureSessionVisibleForMessageRoute(later.id, {
                serverId, hydrateMessages: false, forceRefresh: true,
            })).resolves.toMatchObject({ kind: 'available' });
            expect(storage.getState().sessions[later.id]?.ownerMetadataView).toMatchObject(later.metadata);
            expect(storage.getState().sessions[later.id]?.metadataLayoutVersion).toBe(1);
            changesResponse.mockResolvedValue({ changes: [{ cursor: 2, kind: 'share', entityId: later.id,
                changedAt: 2, hint: null }], nextCursor: 2 });
            await catchUp.resumeViaChanges({ accountId: ACCOUNT_ID });
            expect(discoveryReads).toBe(4);
            expect(http.writes).toHaveLength(3);
            expect([...new Set(batches.flatMap(batch => batch.sessionIds))].toSorted()).toEqual(ids.toSorted());
            expect(batches.every(batch => batch.includeTurns === false && batch.includeMessages === false)).toBe(true);
        } finally {
            discovery.resolve();
            await refresh;
            unsubscribe();
        }
    });
});
