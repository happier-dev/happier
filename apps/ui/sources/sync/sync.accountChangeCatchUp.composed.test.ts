import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import React from 'react';
import 'fake-indexeddb/auto';
import type { Socket } from 'socket.io-client';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionByIdResponseFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    AccountApiTokenSelfV1Schema} from '@happier-dev/protocol/auth/accountApiTokens';
import {
    AUTHORING_MEMORY_ROUTE_V1,
    AuthoringMemoryListResponseV1Schema} from '@happier-dev/protocol/account/authoringMemory';
import {
    projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    resolveSessionFollowActionRequest} from '@happier-dev/protocol/sessions/follow/actionTransport';
import {
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryRequestV1,
} from '@happier-dev/protocol/plugins/data/collectionUiQueryWireV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowChangeHintV1Schema, ProjectAccountRowReadRequestV1Schema,
    type ProjectAccountRowListResponseV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { SESSION_DRAFT_V2_ROUTE_LIST, SessionDraftListResponseV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    normalizePluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ChangesCursorScope } from '@/sync/domains/state/persistence';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createCompactSessionListRowFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { FeedResponseSchema } from '@/sync/domains/social/feedTypes';
import type { InvalidateSync } from '@/utils/sessions/sync';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

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
let connectTestSockets = false;
installDisconnectedServerSocketBoundary((socket) => {
    sockets.push(socket);
    if (connectTestSockets) configureConnectedServerSocketBoundary(socket);
});
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
    connectedSocket?: boolean;
    mountAuth?: boolean;
    credentials?: AuthCredentials;
    accountMode?: 'plain' | 'e2ee';
    draftsEnabled?: boolean;
    followingEnabled?: boolean;
    onRequest?: (path: string) => void;
    runtimeRequest?: (path: string, init?: RequestInit) => Response | undefined;
    physicalRequest?: (url: string, init?: RequestInit) => Promise<Response> | undefined;
} = {}): Promise<void> {
    connectTestSockets = options.connectedSocket === true;
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
            if (path === '/v1/artifacts') return createArtifactListHttpResponse(new URL(String(url)), []);
            if (path === '/v1/machines') return jsonResponse([]);
            if (path === '/v1/friends' || path === '/v1/friends/requests') return jsonResponse({ friends: [], requests: [] });
            if (path === '/v1/kv') return jsonResponse({ items: [] });
            if (path === '/v1/account/saved-secrets/resources') return jsonResponse(SharedSavedSecretListOutputV1Schema.parse({ resources: [] }));
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
    if (options.connectedSocket) {
        const binding = sync.getAccountEncryptionObservationBinding(account.credentials);
        if (!binding) throw new Error('Expected connected Account observation');
        await binding.read();
    }
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
    // These cases start with an acquired Account snapshot. Let the real
    // missing-cursor repair finish before installing held change-page replies.
    domainHttp.mockImplementation(async ({ url, init }) =>
        createEmptyAccountBootstrapHttpResponse(new URL(url).pathname, init) ?? Response.json({}, { status: 404 }));
    await restoreTestAccount();
    const { sync } = await import('./syncEngine');
    const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
    await waitForHomeGovernance(() => expect(getActiveServerAccountScope()).not.toBeNull());
    const harness = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
    await harness.resumeViaChanges({ accountId: ACCOUNT_ID });
    expect(harness.changesCursor).toBe('0');
    changesResponse.mockClear();
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
    it('FLOWBUDGET foregrounds an acquired 1000-Session list and applies one changed Session', async () => {
        const rows = Array.from({ length: 1_000 }, (_, index) =>
            createPlainSessionCurrentProjectionRecordFixture({ id: `flowbudget-session-${index}` }));
        const http: string[] = [];
        const batchIds: string[][] = [];
        await restoreTestAccount({ connectedSocket: true, physicalRequest: (url, init) => {
            const path = new URL(url).pathname;
            http.push(`${init?.method ?? 'GET'} ${path}`);
            if (path === '/v2/sessions/read-batch') {
                batchIds.push(SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body))).sessionIds);
            }
            return undefined;
        }, runtimeRequest: path => {
            if (path === '/v2/sessions') return jsonResponse({ sessions: rows.map(createCompactSessionListRowFixture),
                nextCursor: null, hasNext: false });
            const row = rows.find(row => path === `/v2/sessions/${row.id}`);
            return row ? jsonResponse({ session: row }) : undefined;
        } });
        if (!syncRuntime) throw new Error('Expected restored Sync');
        await syncRuntime.refreshSessions({ awaitSessionListHydration: true });
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        expect(Object.keys(storage.getState().sessionListRowsByServerId[scope.serverId] ?? {})).toHaveLength(1_000);
        const counts = () => Object.fromEntries([...new Set(http)].map(route => [route, http.filter(value => value === route).length]));
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness;
        http.length = 0;
        batchIds.length = 0;
        await runtime.resumeSync('app-foreground');
        console.info('FLOWBUDGET_FOREGROUND_UNCHANGED', JSON.stringify(counts()));
        // Measured 2 HTTP calls (informational). An unchanged foreground consumes
        // one empty changes page and does not re-read any of the 1,000 resources.
        expect(http.filter(route => route === 'GET /v2/changes')).toHaveLength(1);
        expect(batchIds).toEqual([]);
        expect(http.filter(route => route === 'GET /v2/sessions')).toEqual([]);
        // Nothing changed while away: the metadata-upgrade census has no new authority signal to answer.
        expect(http.filter(route => route === 'GET /v2/sessions/metadata-upgrades')).toEqual([]);
        rows[0] = { ...rows[0]!, metadataVersion: rows[0]!.metadataVersion + 1 };
        changesResponse.mockResolvedValueOnce({ changes: [{ kind: 'session', entityId: rows[0]!.id,
            cursor: 1, changedAt: 1 }], nextCursor: 1 });
        http.length = 0;
        batchIds.length = 0;
        await runtime.resumeSync('app-foreground');
        expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[rows[0]!.id]?.metadataVersion)
            .toBe(rows[0]!.metadataVersion);
        console.info('FLOWBUDGET_FOREGROUND_CHANGED', JSON.stringify(counts()));
        // Measured 4 HTTP calls. Work follows the one changed Session, not the
        // acquired inventory or the number of consumers/layers.
        expect(batchIds).toEqual([[rows[0]!.id]]);
        expect(http.filter(route => route === 'GET /v2/changes')).toHaveLength(1);
        expect(http.filter(route => route === 'GET /v2/sessions')).toEqual([]);
    });

    it('keeps a Discussion-only change local through the real socket and change feed', async () => {
        const { createEmptyAccountMigrationCensusHttpResponse } = await import('@/dev/testkit/fixtures/accountBootstrapHttpBoundary');
        const { DISCUSSION_READ_STATE_CHANGE_HINT_V1 } = await import('@happier-dev/protocol/discussions');
        const { TeamsPageV1Schema } = await import('@happier-dev/protocol/teams');
        const requests: string[] = [];
        domainHttp.mockImplementation(async ({ url, init }) =>
            createEmptyAccountMigrationCensusHttpResponse(new URL(url).pathname, init)
                ?? createEmptyAccountBootstrapHttpResponse(new URL(url).pathname, init)
                ?? Response.json({}, { status: 404 }));
        await restoreTestAccount({ onRequest: path => { requests.push(path); }, runtimeRequest: path => {
            if (path === '/v2/account/settings') return jsonResponse({ content: { t: 'plain', v: {} }, version: 0 });
            if (path === '/v1/teams/list') return jsonResponse(TeamsPageV1Schema.parse({ teams: [], nextCursor: null }));
            return undefined;
        } });
        const { sync } = await import('./syncEngine');
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope()!;
        const { observeProfileCatalog, refreshProfileCatalog } = await import('./engine/settings/profileCatalogEngine');
        const { getProfileCatalogSnapshot } = await import('./store/settings/profileCatalogSnapshot');
        const { observeTeamsDirectory } = await import('./engine/teams/teamsDirectoryEngine');
        const releaseProfile = observeProfileCatalog(scope);
        const releaseTeams = observeTeamsDirectory(scope, {});
        try {
            await refreshProfileCatalog(scope);
            await waitForHomeGovernance(() => expect(getProfileCatalogSnapshot(scope)?.catalog.status).toBe('ready'));
            await vi.dynamicImportSettled();
            const retained = getProfileCatalogSnapshot(scope);
            requests.length = 0;
            const changes: ApiChangeEntry[] = [{ cursor: 1, kind: 'discussion', entityId: 'discussion-one', changedAt: 1,
                hint: DISCUSSION_READ_STATE_CHANGE_HINT_V1 }];
            changesResponse.mockResolvedValue({ changes, nextCursor: 1 });
            await runtime.handleUpdate({ ...accountChangeWake('h30-discussion'), body: {
                t: 'account-change', changeKinds: [changes[0]!.kind], entityIds: [changes[0]!.entityId],
            } });
            await waitForHomeGovernance(() => {
                expect(runtime.changesCursor).toBe('1');
                expect(runtime.resumeInFlight).toBeNull();
            });
            await vi.dynamicImportSettled();
            // Private Discussion progress changes neither Account source nor
            // authority. The feed cursor must still be consumed normally.
            expect.soft(requests.filter(path => path === '/v1/account/profile')).toHaveLength(0);
            expect.soft(requests.filter(path => path.startsWith('/v1/teams/'))).toHaveLength(0);
            expect(requests.filter(path => path.startsWith('/v1/account/') || path === '/v2/account/settings')).toEqual([]);
            expect(getProfileCatalogSnapshot(scope)).toBe(retained);
        } finally { releaseProfile(); releaseTeams(); }
    });

    let localStorage: LocalStorageMockHandle | null = null;
    let webLocks: WebLockManagerMockHandle | null = null;

    beforeEach(async () => {
        vi.resetModules();
        kvStore.clear();
        localStorage = installLocalStorageMock();
        webLocks = installWebLockManagerMock();
        sockets.length = 0;
        connectTestSockets = false;
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
        vi.unstubAllEnvs();
    });

    it.each(['materializations', 'intent_census', 'request', 'transport'] as const)('settles a mounted Artifact when initial Availability cannot publish (%s), then recovers on new facts', async phase => {
        await prepareAccountChangeWakeSchedulingHarness();
        const { captureActiveServerAccountScopeLifetime } = await import('./domains/scope/activeServerAccountScope');
        const { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('./domains/plugins/availability/projection');
        const { acquirePluginSelectedArtifactLease } = await import('./domains/plugins/availability/artifactLease');
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        clearPluginAccountAvailabilityProjection();
        const reader = readPluginAccountAvailability(lifetime.scope);
        const controller = new AbortController();
        const fetchBytes = vi.fn(async () => new Map<string, Uint8Array>());
        let settled: Awaited<ReturnType<typeof acquirePluginSelectedArtifactLease>> | undefined;
        const pending = acquirePluginSelectedArtifactLease({ reader, accountLifetime: lifetime,
            signal: controller.signal, slot: { pluginId: AVAILABILITY_PLUGIN_ID,
                contributionId: 'page', tier: 'hostedWeb', platform: 'web' },
            // Selection precedes graph/byte admission. No graph is fabricated
            // to make a failed Account refresh look like an executable release.
            artifactGraph: null, sources: [{ kind: 'daemon', fetch: fetchBytes }],
        }).then(result => { settled = result; return result; });
        const queue = (syncRuntime! as unknown as { pluginAvailabilitySync: InvalidateSync }).pluginAvailabilitySync;
        let malformed = true;
        const failureCode = phase === 'request' || phase === 'transport' ? 'plugin_availability_unavailable' : 'plugin_availability_invalid_response';
        domainHttp.mockImplementation(async ({ url }) => {
            const path = new URL(url).pathname;
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                if (malformed && phase === 'transport') throw new TypeError('Network request failed');
                if (malformed && phase === 'request') return Response.json({}, { status: 503 });
                return malformed && phase === 'materializations'
                    ? jsonResponse({ availabilityCursor: 'invalid', snapshots: [] }) : availabilityMaterializationsResponse();
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) return malformed && phase === 'intent_census'
                ? jsonResponse({ availabilityCursor: 9, intentReads: 'invalid', pluginIds: [], failedPluginIds: [] })
                : availabilityIntentDiscoveryResponse();
            return Response.json({}, { status: 404 });
        });
        try {
            // Observe an actual failed attempt, not an HTTP read that is
            // intentionally still pending under its existing recovery policy.
            await expect(queue.invalidateAndAwait({ settleOnFirstAttempt: true })).rejects.toBeInstanceOf(Error);
            await vi.waitFor(() => expect(settled).toEqual({ kind: 'unavailable', code: failureCode }));
            expect(reader.readCurrentAccountExecution(AVAILABILITY_PLUGIN_ID)).toMatchObject({
                kind: 'unavailable', code: failureCode,
            });
            expect(fetchBytes).not.toHaveBeenCalled();
            malformed = false;
            await queue.invalidateAndAwait();
            expect(reader.readMaterializations()).toMatchObject({ kind: 'available', availabilityCursor: 9 });
            expect(reader.readCurrentAccountExecution(AVAILABILITY_PLUGIN_ID)).not.toMatchObject({ code: failureCode });
            // A failed refresh is not a withdrawal of already confirmed facts.
            malformed = true;
            await queue.invalidateAndAwait({ settleOnFirstAttempt: true }).catch(() => undefined);
            expect(reader.readMaterializations()).toMatchObject({ kind: 'available', availabilityCursor: 9 });
            expect(reader.readCurrentAccountExecution(AVAILABILITY_PLUGIN_ID)).not.toMatchObject({ code: failureCode });
            expect(fetchBytes).not.toHaveBeenCalled();
        } finally {
            controller.abort();
            await pending;
            queue.stop();
        }
    });

    it.each([503, 500])('keeps the cursor below failed exact Project reads and recovers the page (%s)', async status => {
        let failExactReads = false;
        let listReads = 0;
        let exactReads = 0;
        let census = createPlainProjectAccountRowListFixture();
        const heldRead = createDeferred<Response>();
        await restoreTestAccount({ physicalRequest: (url, init) => {
            const path = new URL(url).pathname;
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
                listReads++;
                return Promise.resolve(jsonResponse(census));
            }
            if (path !== `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) return undefined;
            exactReads++;
            if (failExactReads) return heldRead.promise.then(response => response.clone());
            const { key } = ProjectAccountRowReadRequestV1Schema.parse(JSON.parse(String(init?.body)));
            const row = census.rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
            return Promise.resolve(jsonResponse(row ? { status: 'present', row } : { status: 'absent' }));
        } });
        await syncRuntime!.refreshProjectAccountRows();
        const runtime = syncRuntime! as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Project Account scope');
        const changes: ApiChangeEntry[] = Array.from({ length: 8 }, (_, index) => {
            const key = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: `failed-project-${index}` };
            return { cursor: index + 2, changedAt: 1, kind: 'account', entityId: buildProjectAccountRowPhysicalKeyV1(key),
                hint: ProjectAccountRowChangeHintV1Schema.parse({ projectAccountRow: true, key, revision: 1 }) };
        });
        changesResponse.mockResolvedValue({ changes: [], nextCursor: 9 }).mockResolvedValueOnce({
            changes: [{ cursor: 1, changedAt: 1, kind: 'account', entityId: 'self', hint: { profileVersion: 1 } }, ...changes], nextCursor: 9,
        });
        listReads = 0;
        failExactReads = true;
        await runtime.handleUpdate(accountChangeWake('project-failed-page'));
        await waitForHomeGovernance(() => expect(exactReads).toBe(8));
        expect(Number(runtime.changesCursor)).toBeLessThan(2);
        heldRead.resolve(Response.json({ error: 'unavailable' }, { status }));
        await runtime.resumeInFlight;
        expect(runtime.changesCursor).toBe('1');
        const { storage } = await import('./domains/state/storage');
        expect(storage.getState().projectAccountRows?.workspaceRefs ?? []).toHaveLength(0);
        expect(listReads).toBe(0);

        census = createPlainProjectAccountRowListFixture({ workspaceRefs: changes.map((_, index) => ({
            id: `failed-project-${index}`, serverId: scope.serverId, machineId: 'machine',
            rootPath: `/recovered-${index}`, createdAtMs: 1, label: 'Recovered',
        })) });
        changesResponse.mockResolvedValueOnce({ changes, nextCursor: 9 });
        failExactReads = false;
        listReads = 0;
        await runtime.handleUpdate(accountChangeWake('project-recovered-page'));
        await runtime.resumeInFlight;
        expect(storage.getState().projectAccountRows?.workspaceRefs).toHaveLength(8);
        expect(storage.getState().projectAccountRows?.workspaceRefs.every(ref => ref.label === 'Recovered')).toBe(true);
        expect(runtime.changesCursor).toBe('9');
        expect(listReads).toBe(status === 500 ? 1 : 0);
        expect(exactReads).toBe(16);
    });

    it('reads one complete Project census on initial load and a genuine reconnect, keeping ordinary wakes quiet', async () => {
        let listReads = 0;
        let exactReads = 0;
        let census = createPlainProjectAccountRowListFixture();
        await restoreTestAccount({ physicalRequest: (url) => {
            const path = new URL(url).pathname;
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
                listReads++;
                return Promise.resolve(jsonResponse(census));
            }
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) {
                exactReads++;
                return Promise.resolve(jsonResponse({ status: 'absent' }));
            }
            return undefined;
        } });
        const runtime = syncRuntime! as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Project Account scope');
        await waitForHomeGovernance(() => expect(storage.getState().projectAccountRows?.status).toBe('ready'));
        expect(listReads).toBe(1);
        const socket = sockets.at(-1);
        if (!socket) throw new Error('Expected focused Account transport');
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        census = createPlainProjectAccountRowListFixture({ workspaceRefs: [{ id: 'reconnected-project',
            serverId: scope.serverId, machineId: 'machine', rootPath: '/reconnected', createdAtMs: 1, label: 'Recovered' }] });
        listReads = 0;
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('transport close');
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        await runtime.resumeInFlight;
        expect(listReads).toBe(1);
        expect(storage.getState().projectAccountRows?.workspaceRefs).toMatchObject([{ id: 'reconnected-project', label: 'Recovered' }]);
        await runtime.resumeSync('changes-catch-up');
        await runtime.resumeSync('changes-catch-up');
        expect(listReads).toBe(1);
        expect(exactReads).toBe(0);
    });

    it.each(['default', 1, 8] as const)('reads only hinted Project rows through Sync (concurrency: %s)', async concurrency => {
        if (concurrency !== 'default') {
            vi.stubEnv('EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON', JSON.stringify({ resumeConcurrencyLimit: concurrency }));
        }
        let listReads = 0;
        const exactReads: string[] = [];
        let census: ProjectAccountRowListResponseV1 = createPlainProjectAccountRowListFixture();
        // Only HTTP is replaced: socket admission, Sync, planner/applier, row
        // opening and the consumer's actual store remain real.
        await restoreTestAccount({ physicalRequest: (url, init) => {
            const path = new URL(url).pathname;
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
                listReads++;
                return Promise.resolve(jsonResponse(census));
            }
            if (path !== `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) return undefined;
            const { key } = ProjectAccountRowReadRequestV1Schema.parse(JSON.parse(String(init?.body)));
            exactReads.push(buildProjectAccountRowPhysicalKeyV1(key));
            if (census.status !== 'listed') throw new Error('Expected listed Project fixture');
            const row = census.rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
            return Promise.resolve(jsonResponse(!row ? { status: 'absent' } : row.content === null
                ? { status: 'deleted', revision: row.revision } : { status: 'present', row }));
        } });
        const sync = syncRuntime!;
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Project Account scope');
        const refs = Array.from({ length: 8 }, (_, index) => ({ id: `project-page-${index}`,
            serverId: scope.serverId, machineId: 'machine', rootPath: `/repo-${index}`,
            projectKey: `project-${index}`, createdAtMs: 1, label: 'Before' }));
        census = createPlainProjectAccountRowListFixture({ workspaceRefs: refs.slice(0, 2) });
        await sync.refreshProjectAccountRows();
        expect(storage.getState().projectAccountRows?.workspaceRefs).toHaveLength(2);
        expect(listReads).toBeGreaterThan(0);

        const listed = createPlainProjectAccountRowListFixture({ workspaceRefs: refs
            .filter((_, index) => index !== 1)
            .map(ref => ({ ...ref, label: ref.id === refs[0]!.id ? 'After' : 'Added' })) });
        if (listed.status !== 'listed') throw new Error('Expected listed Project fixture');
        const deletedKey = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: refs[1]!.id };
        census = { ...listed, rows: [...listed.rows.map(row => row.key.kind === 'workspace-ref' && row.key.id === refs[0]!.id
            ? { ...row, revision: 1 } : row), { key: deletedKey, revision: 1, content: null }] };
        const changes: ApiChangeEntry[] = census.rows.filter(row => row.key.kind === 'workspace-ref').map((row, index) => ({
            cursor: index + 1, changedAt: 1, kind: 'account', entityId: buildProjectAccountRowPhysicalKeyV1(row.key),
            hint: ProjectAccountRowChangeHintV1Schema.parse({ projectAccountRow: true, key: row.key, revision: row.revision }),
        }));
        expect(changes).toHaveLength(8);
        changesResponse.mockResolvedValue({ changes: [], nextCursor: 8 })
            .mockResolvedValueOnce({ changes, nextCursor: 8 });
        listReads = 0;
        await runtime.handleUpdate(accountChangeWake('project-first-page'));
        await runtime.resumeInFlight;
        const firstPageListReads = listReads;
        const materialized = storage.getState().projectAccountRows;
        expect(materialized?.workspaceRefs).toHaveLength(7);
        expect(materialized?.workspaceRefs.find(ref => ref.id === refs[0]!.id)?.label).toBe('After');
        expect(materialized?.workspaceRefs.some(ref => ref.id === refs[1]!.id)).toBe(false);
        expect(materialized?.workspaceRefs.find(ref => ref.id === refs[7]!.id)?.label).toBe('Added');
        expect(materialized?.revisionsByPhysicalKey[buildProjectAccountRowPhysicalKeyV1(deletedKey)]).toBe(1);
        expect(runtime.changesCursor).toBe('8');

        const laterKey = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: refs[0]!.id };
        census = { ...census, rows: census.rows.map(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(laterKey)
            ? { key: laterKey, revision: 2, content: { t: 'plain', v: { key: laterKey, value: { ...refs[0]!, label: 'Later' } } } }
            : row) };
        changesResponse.mockResolvedValueOnce({ changes: [{ cursor: 9, changedAt: 2, kind: 'account',
            entityId: buildProjectAccountRowPhysicalKeyV1(laterKey), hint: ProjectAccountRowChangeHintV1Schema.parse({
                projectAccountRow: true, key: laterKey, revision: 2 }) }], nextCursor: 9 });
        listReads = 0;
        await runtime.handleUpdate(accountChangeWake('project-later-page'));
        await runtime.resumeInFlight;
        expect(storage.getState().projectAccountRows?.workspaceRefs.find(ref => ref.id === refs[0]!.id)?.label).toBe('Later');
        expect(runtime.changesCursor).toBe('9');
        expect(listReads).toBe(0);
        expect(firstPageListReads).toBe(0);
        expect(exactReads).toHaveLength(9);
        expect(new Set(exactReads.slice(0, 8))).toEqual(new Set(changes.map(change => change.entityId)));
        expect(exactReads[8]).toBe(buildProjectAccountRowPhysicalKeyV1(laterKey));
    });

    it.each(['detailed', 'blocked'] as const)('delivers a Discussion message from the socket change feed to the mounted thread (%s)', async phase => {
        const runtime = await prepareAccountChangeWakeSchedulingHarness();
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope()!;
        const { createDiscussionClient } = await import('./api/discussions/discussionActions');
        const { getDiscussionRepository, clearDiscussionRepositoryRegistryForTests } = await import('./ops/discussions/discussionRepositoryRegistry');
        const { useDiscussionRepositorySnapshot } = await import('./ops/discussions/useDiscussionRepositorySnapshot');
        const { summary, message } = await import('./ops/discussions/discussionRepository.testkit');
        const discussionId = 'discussion-arrival';
        let head = 1;
        const reads: string[] = [];
        domainHttp.mockImplementation(async ({ url }) => {
            const request = new URL(url);
            if (!request.pathname.startsWith(`/v1/discussions/${discussionId}`)) return Response.json({}, { status: 404 });
            reads.push(request.pathname + request.search);
            if (!request.pathname.endsWith('/messages')) {
                const { title, ...row } = summary(discussionId, null, head);
                return jsonResponse({ discussion: { ...row, titleContent: { t: 'plain', v: { v: 1, title } } } });
            }
            const after = Number(request.searchParams.get('afterSeq') ?? 0);
            return jsonResponse({ messages: Array.from({ length: head }, (_, index) => message(index + 1, null, discussionId))
                .filter(row => row.seq > after).map(({ messageRef: _ref, content, ...row }) => ({ ...row,
                    content: { t: 'plain', v: content } })), hasMoreOlder: false, messageSeq: head });
        });
        const repository = getDiscussionRepository({ scope, address: { serverId: scope.serverId },
            client: createDiscussionClient({ scope, availability: 'available' }) });
        const leave = repository.mount({ discussionId });
        const thread = await renderHook(() => useDiscussionRepositorySnapshot(repository).threads[discussionId]);
        try {
            await act(async () => repository.refreshDiscussion(discussionId));
            expect(thread.getCurrent()?.messages.map(row => row.seq)).toEqual([1]);
            const seed = thread.getCurrent()!.messages[0];
            reads.length = 0;
            head = 2;
            const { PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
            // A retained historical row can block the durable frontier before
            // the newer Discussion row. The current Discussion HTTP read is
            // still available; its private body does not ride on this wake.
            changesResponse.mockResolvedValue({ changes: [], nextCursor: 2 }).mockResolvedValueOnce({ changes: phase === 'blocked'
                ? [{ cursor: 1, kind: 'account', entityId: `${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}unrecognized`, changedAt: 1, hint: null }]
                : [{ cursor: 2, kind: 'discussion', entityId: discussionId, changedAt: 2,
                    hint: { v: 1, discussions: true, changes: { resource: true } } }], nextCursor: phase === 'blocked' ? 1 : 2 });
            const cursorBefore = runtime.changesCursor;
            await act(async () => runtime.handleUpdate({ ...accountChangeWake('discussion-message-arrived'),
                body: { t: 'account-change', changeKinds: ['discussion'], entityIds: [discussionId] } }));
            await waitForHomeGovernance(() => expect(thread.getCurrent()?.messages.map(row => row.seq)).toEqual([1, 2]));
            expect(thread.getCurrent()).toMatchObject({ status: 'ready', messageSeq: 2 });
            expect(thread.getCurrent()!.messages[0]).toBe(seed);
            if (phase === 'blocked') expect(runtime.changesCursor).toBe(cursorBefore);
            expect(reads.filter(path => path.includes('/messages'))).toEqual([
                `/v1/discussions/${discussionId}/messages?afterSeq=1`,
            ]);
        } finally {
            leave(); await thread.unmount(); clearDiscussionRepositoryRegistryForTests();
        }
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

    it('removes a resolved Inbox hold through one qualified Account socket wake and durable catch-up', async () => {
        const runtime = await prepareAccountChangeWakeSchedulingHarness();
        const { storage } = await import('./domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('./domains/scope/activeServerAccountScope');
        const { createWorkflowDefinitionFixture, createWorkflowRunListStorageFixture, createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('./store/domains/workflowRuns');
        const { useWorkflowRun } = await import('./store/hooks');
        const { useWorkflowRunWindow } = await import('@/components/workflows/library/workflowLibraryReads');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected restored Inbox Account lifetime');
        const held = createWorkflowRunSummaryFixture({ ownerAccountId: ACCOUNT_ID, origin: { kind: 'direct' },
            state: 'waiting_for_review', revision: 6, attentionRequired: true, invocationAttentionRequired: true });
        const settled = createWorkflowRunSummaryFixture({ ...held, state: 'succeeded', revision: 11,
            attentionRequired: false, invocationAttentionRequired: false, workflowCustodyState: 'settled' });
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'confirm',
            document: { text: 'Continue', references: [], attachments: [] } }] });
        const heldResponse = await createWorkflowRunListStorageFixture({ runs: [held], definition });
        const settledResponse = await createWorkflowRunListStorageFixture({ runs: [settled], definition });
        const emptyResponse = await createWorkflowRunListStorageFixture({ runs: [], definition });
        let resolved = false;
        const runReads: unknown[] = [];
        domainHttp.mockImplementation(async ({ url, init }) => {
            if (new URL(url).pathname !== '/v3/automations/runs/workflow-storage') return Response.json({}, { status: 404 });
            const input = JSON.parse(String(init?.body));
            runReads.push(input);
            return jsonResponse(!resolved ? heldResponse : input.request?.attention === 'required' ? emptyResponse : settledResponse);
        });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(held)], lifetime.scope);
        // Inbox consumes this same Account-scoped attention window; it has no separate loader.
        const hook = await renderHook(() => ({ detail: useWorkflowRun(held.id),
            inbox: useWorkflowRunWindow('attention', { accountLifetime: lifetime }) }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().inbox.runIds).toEqual([held.id]));
        runReads.length = 0;
        let summaryPublications = 0;
        const key = workflowRunStoreKey(held.id, lifetime.scope);
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.workflowRunsById[key] !== previous.workflowRunsById[key]) summaryPublications++;
        });
        const gate = createDeferred<void>();
        changesResponse.mockImplementationOnce(async () => {
            await gate.promise;
            return { changes: [{ cursor: 1, changedAt: 1, kind: 'account', entityId: `workflow-run:${held.id}`,
                hint: { revision: 11 } }], nextCursor: 1 };
        });
        const socket = sockets.findLast(candidate => candidate.listenersAny().length > 0);
        if (!socket) throw new Error('Expected focused Account socket listeners');
        const wake = { ...accountChangeWake('inbox-review-resolved'), body: {
            t: 'account-change', changeKinds: ['account'], entityIds: [`workflow-run:${held.id}`],
        } };
        try {
            resolved = true;
            await act(async () => { for (const listener of socket.listenersAny()) listener('update', wake); });
            await waitForHomeGovernance(() => expect(changesResponse).toHaveBeenCalledOnce());
            expect(runReads).toEqual([]);
            expect(hook.getCurrent().inbox.runIds).toEqual([held.id]);
            await act(async () => { gate.resolve(); await runtime.resumeInFlight; });
            await waitForHomeGovernance(() => expect(hook.getCurrent().inbox.runIds).toEqual([]));
            expect(hook.getCurrent().detail?.summary).toMatchObject({ state: 'succeeded', revision: 11, attentionRequired: false });
            expect(changesResponse).toHaveBeenCalledOnce();
            expect(summaryPublications).toBe(1);
            // One exact summary, one filtered membership check, then the ordered attention window.
            expect(runReads).toEqual([
                expect.objectContaining({ request: expect.objectContaining({ runIds: [held.id] }) }),
                expect.objectContaining({ request: expect.objectContaining({ attention: 'required', runIds: [held.id] }) }),
                expect.objectContaining({ request: expect.objectContaining({ attention: 'required' }) }),
            ]);
        } finally {
            gate.resolve(); await runtime.resumeInFlight; unsubscribe(); await hook.unmount();
        }
    });

    it.each([false, true])('reads 400 listed Session changes as one set (connected identity: %s)', async connectedSocket => {
        const ids = Array.from({ length: 400 }, (_, index) => `currentness-pass-${index}`);
        let currentnessReads = 0;
        const physicalBatches: string[][] = [];
        await restoreTestAccount({ connectedSocket, onRequest: path => {
            if (path === '/v1/account/encryption/currentness') currentnessReads++;
        }, physicalRequest: (url, init) => {
            if (new URL(url).pathname === '/v2/sessions/read-batch') {
                const input = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
                if (input.sessionIds.some(id => ids.includes(id))) physicalBatches.push(input.sessionIds);
            }
            return undefined;
        } });
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness & {
            refreshListedSessionRows(serverId: string, sessionIds: readonly string[]): Promise<void>;
        };
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        domainHttp.mockImplementation(async ({ url }) => {
            const id = new URL(url).pathname.split('/').at(-1)!;
            return ids.includes(id) ? jsonResponse({ session: createPlainSessionCurrentProjectionRecordFixture({ id }) })
                : Response.json({}, { status: 404 });
        });
        const before = currentnessReads;
        await runtime.refreshListedSessionRows(scope.serverId, ids);
        expect(physicalBatches).toEqual([ids]);
        expect(currentnessReads - before).toBe(connectedSocket ? 0 : 1);
        for (const id of ids) {
            expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[id]?.id).toBe(id);
            expect(storage.getState().sessions[id]).toBeUndefined();
        }
        // Connected identity is reused; an unbound pass owns a fresh witness.
        await runtime.refreshListedSessionRows(scope.serverId, ids.slice(0, 2));
        expect(physicalBatches).toEqual([ids, ids.slice(0, 2)]);
        expect(currentnessReads - before).toBe(connectedSocket ? 0 : 2);
    });

    it('borrows current identity across 400 separate Session query and listed-row arrivals over 180 seconds', async () => {
        let currentnessReads = 0;
        let row = createPlainSessionCurrentProjectionRecordFixture({ id: 'busy-arrival' });
        const { projectSessionDisplayV1, SessionDisplayProjectionV1Schema} = await import('@happier-dev/protocol/sessions');
        const { SessionOwnerMetadataV1Schema, SessionSharedMetadataV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const { createSessionDisplayCrypto } = await import('./encryption/sessionDisplayCrypto');
        if (row.ownerMetadata?.t !== 'plain' || typeof row.metadata !== 'string') throw new Error('Expected plain Session metadata');
        const display = projectSessionDisplayV1({
            sharedMetadata: SessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata)),
            ownerMetadata: SessionOwnerMetadataV1Schema.parse(row.ownerMetadata.v),
        });
        const crypto = createSessionDisplayCrypto({ sessionMode: 'plain', accountMode: 'plain', credentials: { token: ACCOUNT_TOKEN } });
        const shared = await crypto.encodeSharedDisplay(display.shared);
        const owner = crypto.encodeOwnerDisplay(display.owner!);
        // Current list wire already carries display facts. A full tuple instead
        // asks the maintenance owner for a fresh mutation witness on every page.
        const queryRow = () => ({ ...createCompactSessionListRowFixture(row),
            displayProjectionV1: SessionDisplayProjectionV1Schema.parse({ v: 1,
                sourceMetadataVersion: row.metadataVersion, metadataLayoutVersion: row.metadataLayoutVersion, shared, owner }),
            viewer: createSessionViewerFixture() });
        await restoreTestAccount({ connectedSocket: true, onRequest: path => {
            if (path === '/v1/account/encryption/currentness') currentnessReads++;
        }, runtimeRequest: path => path === '/v2/sessions/query'
            ? jsonResponse({ sessions: [queryRow()], nextCursor: null, hasNext: false,
                attentionNextCursor: null, attentionHasNext: false }) : undefined });
        domainHttp.mockImplementation(async ({ url }) => new URL(url).pathname === '/v2/sessions/busy-arrival'
            ? jsonResponse({ session: row }) : Response.json({}, { status: 404 }));
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness & {
            refreshListedSessionRows(serverId: string, sessionIds: readonly string[]): Promise<void>;
        };
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope || !account || !syncRuntime) throw new Error('Expected restored Account scope');
        const binding = syncRuntime.getAccountEncryptionObservationBinding(account.credentials);
        expect(binding?.isCurrent()).toBe(true);
        expect(binding?.peek()?.mode).toBe('plain');
        const before = currentnessReads;
        const startedAt = Date.now();
        const clock = vi.spyOn(Date, 'now');
        try {
            for (let index = 0; index < 400; index++) {
                clock.mockReturnValue(startedAt + (index + 1) * 450);
                row = createPlainSessionCurrentProjectionRecordFixture({ id: 'busy-arrival', metadataVersion: index + 1 });
                await syncRuntime.fetchSessionListQueryPage(scope.serverId, {
                    source: { kind: 'query', allowV1Fallback: false, body: { v: 1, storage: 'active',
                        includeInactive: false, scope: 'all_accessible', attention: 'any' } },
                    signal: new AbortController().signal,
                    membership: 'query',
                });
                await runtime.refreshListedSessionRows(scope.serverId, [row.id]);
            }
            expect(Date.now() - startedAt).toBe(180_000);
            expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[row.id]?.metadataVersion).toBe(400);
            // Bootstrap is outside this window. A current observation needs zero
            // additional GETs regardless of the number or spacing of read passes.
            expect(currentnessReads - before).toBe(0);
        } finally { clock.mockRestore(); }
    });

    it('shares one Session-parts read when concurrent list query pages demand the same row', async () => {
        // P03-RECONNECT-REST: after a return, three list corpora re-read at the catch-up wake and each
        // fetched the same Session's parts (3 identical concurrent read-batch requests).
        const id = 'shared-query-row';
        const row = createPlainSessionCurrentProjectionRecordFixture({ id });
        const physicalBatches: string[][] = [];
        await restoreTestAccount({ connectedSocket: true, physicalRequest: (url, init) => {
            if (new URL(url).pathname === '/v2/sessions/read-batch') {
                const input = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
                if (input.sessionIds.includes(id)) physicalBatches.push(input.sessionIds);
            }
            return undefined;
        }, runtimeRequest: path => path === '/v2/sessions/query'
            ? jsonResponse({ sessions: [{ ...createCompactSessionListRowFixture(row), viewer: createSessionViewerFixture() }], nextCursor: null, hasNext: false,
                attentionNextCursor: null, attentionHasNext: false }) : undefined });
        domainHttp.mockImplementation(async ({ url }) => new URL(url).pathname === `/v2/sessions/${id}`
            ? jsonResponse({ session: row }) : Response.json({}, { status: 404 }));
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope || !syncRuntime) throw new Error('Expected restored Account scope');
        const runtime = syncRuntime;
        const page = (attention: 'any' | 'needs_attention') => runtime.fetchSessionListQueryPage(scope.serverId, {
            source: { kind: 'query', allowV1Fallback: false, body: { v: 1, storage: 'active',
                includeInactive: false, scope: 'all_accessible', attention } },
            signal: new AbortController().signal,
            membership: 'query',
            hydration: 'required',
        });
        await Promise.all([page('any'), page('any'), page('needs_attention')]);
        expect(physicalBatches).toEqual([[id]]);
        expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[id]?.id).toBe(id);
    });

    it('shares the set reader and admitted identity when a change page requires list-membership repair', async () => {
        const ids = Array.from({ length: 12 }, (_, index) => `coldhome-repair-${index}`).sort();
        const physicalBatches: string[][] = [];
        let currentnessReads = 0;
        await restoreTestAccount({ connectedSocket: true, onRequest: path => {
            if (path === '/v1/account/encryption/currentness') currentnessReads++;
        }, physicalRequest: (url, init) => {
            if (new URL(url).pathname === '/v2/sessions/read-batch') {
                const input = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
                if (input.sessionIds.some(id => ids.includes(id))) physicalBatches.push(input.sessionIds);
            }
            return undefined;
        } });
        domainHttp.mockImplementation(async ({ url }) => {
            const id = new URL(url).pathname.split('/').at(-1)!;
            return ids.includes(id) ? jsonResponse({ session: createPlainSessionCurrentProjectionRecordFixture({ id }) })
                : Response.json({}, { status: 404 });
        });
        // These are absent from the admitted membership, so the real planner
        // selects list repair followed by exact changed-row projections.
        changesResponse.mockResolvedValueOnce({
            changes: ids.map((entityId, index) => ({ cursor: index + 1, changedAt: 1, kind: 'session', entityId })),
            nextCursor: ids.length,
        });
        const runtime = syncRuntime as unknown as SyncAccountChangeCatchUpHarness;
        const before = currentnessReads;
        await expect(runtime.resumeViaChanges({ accountId: ACCOUNT_ID })).resolves.toMatchObject({ status: 'ok' });
        expect(runtime.changesCursor).toBe(String(ids.length));
        expect(physicalBatches).toEqual([ids]);
        expect(currentnessReads - before).toBe(0);
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored Account scope');
        for (const id of ids) {
            expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[id]).toBeDefined();
            expect(storage.getState().sessions[id]).toBeUndefined();
        }
    });

    it.each(['completed', 'pending-http'] as const)('retains a server-newer offscreen exact projection across an older omitted snapshot (%s)', async phase => {
        const id = `offscreen-newer-${phase}`;
        const snapshotRequested = createDeferred<void>();
        const snapshotResponse = createDeferred<Response>();
        const detailRequested = createDeferred<void>();
        const detailResponse = createDeferred<Response>();
        let holdSnapshot = false;
        let holdDetail = false;
        let detailCursor = 10;
        let detailReads = 0;
        const rowAt = (cursor: number) => createPlainSessionByIdResponseFixture(createSessionFixture({
            id, seq: cursor, updatedAt: cursor,
            access: { ...createSessionAccessFixture('view'), sources: [{ kind: 'direct', shareId: `share-${id}` }] },
        })).session;
        await restoreTestAccount({ connectedSocket: true, physicalRequest: (url, init) => {
            const path = new URL(url).pathname;
            if (holdSnapshot && path === '/v2/sessions') {
                snapshotRequested.resolve();
                return snapshotResponse.promise;
            }
            if (holdDetail && path === '/v2/sessions/read-batch') {
                const input = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
                if (input.sessionIds.includes(id)) {
                    detailReads += 1;
                    detailRequested.resolve();
                    return detailResponse.promise;
                }
            }
            return undefined;
        }, runtimeRequest: path => {
            const row = rowAt(detailCursor);
            if (path === `/v2/sessions/${id}`) {
                detailReads += 1;
                return jsonResponse({ session: row, observationCursor: detailCursor });
            }
            if (path === '/v2/sessions') return jsonResponse({ sessions: [row], nextCursor: null, hasNext: false, observationCursor: 10 });
            return undefined;
        } });
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope()!;
        await expect(sync.ensureSessionVisibleForMessageRoute(id, { hydrateMessages: false })).resolves.toMatchObject({ kind: 'available' });
        await sync.refreshSessions({ awaitSessionListHydration: true });
        expect(storage.getState().ordinarySessionListMembershipByServerId[scope.serverId]).toContain(id);
        holdSnapshot = true;
        const snapshot = sync.refreshSessions({ awaitSessionListHydration: true });
        await snapshotRequested.promise;
        detailCursor = 21;
        holdDetail = phase === 'pending-http';
        changesResponse.mockResolvedValueOnce({ changes: [{ kind: 'session', entityId: id, cursor: 21, changedAt: 21,
            hint: { pendingExecutionRunIds: [] } }], nextCursor: 21 });
        const socket = sockets.findLast(candidate => candidate.listenersAny().length > 0)!;
        for (const listener of socket.listenersAny()) listener('update', { id: `offscreen-wake-${phase}`, seq: 21, createdAt: 21,
            body: { t: 'account-change', changeKinds: ['session'], entityIds: [id] } });
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness;
        try {
            if (phase === 'pending-http') await detailRequested.promise;
            else await waitForHomeGovernance(() => expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[id]?.seq).toBe(21));
            snapshotResponse.resolve(jsonResponse({ sessions: [], nextCursor: null, hasNext: false, observationCursor: 20 }));
            await snapshot;
            detailResponse.resolve(jsonResponse({ results: [{ sessionId: id, detail: { status: 200, body: {
                session: rowAt(21), observationCursor: 21,
            } } }] }));
            await runtime.resumeInFlight;
            expect(storage.getState().sessionListRowsByServerId[scope.serverId]?.[id]?.seq).toBe(21);
            if (phase === 'completed') expect(storage.getState().sessions[id]).toBeDefined();
            expect(detailReads).toBe(2);
        } finally {
            snapshotResponse.resolve(jsonResponse({ sessions: [], nextCursor: null, hasNext: false, observationCursor: 20 }));
            detailResponse.resolve(jsonResponse({ results: [{ sessionId: id, detail: { status: 200, body: {
                session: rowAt(21), observationCursor: 21,
            } } }] }));
            await Promise.allSettled([snapshot, runtime.resumeInFlight]);
        }
    });

    it('yields a superseded ordinary Session snapshot failure without replacing the next ready observation or shown content', async () => {
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        let listReads = 0;
        const row = createPlainSessionCurrentProjectionRecordFixture({ id: 'snapshot-supersession' });
        await restoreTestAccount({ runtimeRequest: path => {
            if (path === '/v2/sessions') {
                listReads++;
                if (listReads === 2) {
                    started.resolve();
                    return release.promise.then(() => Response.json({}, { status: 400 }));
                }
                return jsonResponse({ sessions: [createCompactSessionListRowFixture(row)], nextCursor: null, hasNext: false });
            }
            return path === `/v2/sessions/${row.id}` ? jsonResponse({ session: row }) : undefined;
        } });
        if (!syncRuntime || !account) throw new Error('Expected restored Sync');
        const sync = syncRuntime;
        const serverId = account.serverId;
        const { storage } = await import('./domains/state/storage');
        await sync.refreshSessions({ awaitSessionListHydration: true });
        await sync.ensureSessionVisibleForMessageRoute(row.id, { serverId, hydrateMessages: false });
        const shown = storage.getState().sessions[row.id];
        expect(shown).toBeDefined();
        const first = sync.refreshSessions({ awaitSessionListHydration: true }).then(() => 'yielded', () => 'failed');
        try {
            await started.promise;
            sync.invalidateSessionListSnapshot(serverId);
            await (sync as unknown as { sessionsSync: Pick<InvalidateSync, 'awaitQueue'> }).sessionsSync.awaitQueue();
            expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('ready');
            expect(storage.getState().sessions[row.id]).toBe(shown);
            release.resolve();
            await expect(first).resolves.toBe('yielded');
            expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('ready');
            expect(storage.getState().sessions[row.id]).toBe(shown);
        } finally { release.resolve(); await first; }
    });

    it.each(['superseded', 'current-failure'] as const)(
        'settles required hydration across a Session access change (%s)', async outcome => {
        const id = 'access-change-hydration';
        const release = createDeferred<void>();
        let hold = false;
        let held = false;
        let hydrationHasStarted = () => false;
        const rowAt = (version: number) => createPlainSessionCurrentProjectionRecordFixture({
            id, seq: version, metadataVersion: version, updatedAt: version,
        });
        await restoreTestAccount({ physicalRequest: (url) => {
            if (!hold || new URL(url).pathname !== '/v1/account/encryption/currentness') return undefined;
            if (!hydrationHasStarted()) return undefined;
            held = true;
            return release.promise.then(() => outcome === 'current-failure' ? Response.json({ error: 'unavailable' }, { status: 503 })
                : jsonResponse({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }));
        }, runtimeRequest: path => {
            if (path === '/v2/sessions') return jsonResponse({ sessions: [createCompactSessionListRowFixture(rowAt(2))],
                nextCursor: null, hasNext: false, observationCursor: 2 });
            return path === `/v2/sessions/${id}` ? jsonResponse({ session: rowAt(hold ? 1 : 2), observationCursor: hold ? 1 : 2 }) : undefined;
        } });
        if (!syncRuntime || !account) throw new Error('Expected restored Sync');
        const sync = syncRuntime;
        const serverId = account.serverId;
        const { storage } = await import('./domains/state/storage');
        await (sync as unknown as { refreshSessionListRowProjection(serverId: string, sessionId: string): Promise<void> })
            .refreshSessionListRowProjection(serverId, id);
        expect(storage.getState().sessions[id]).toBeUndefined();
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[id]?.metadataVersion).toBe(2);
        const { syncPerformanceTelemetry: telemetry } = await import('./runtime/syncPerformanceTelemetry');
        telemetry.configure({ enabled: true });
        telemetry.reset();
        hydrationHasStarted = () => telemetry.snapshot().events.some(event => event.name === 'sync.sessions.snapshot.hydrationPriority');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        hold = true;
        const first = (sync as unknown as {
            fetchSessions(options: { awaitSessionListHydration: true; requiredHydrationSessionIds: string[] }): Promise<unknown>;
        }).fetchSessions({ awaitSessionListHydration: true, requiredHydrationSessionIds: [id] });
        const firstOutcome = first.then(() => 'settled', error => error);
        try {
            await expect.poll(() => held).toBe(true);
            if (outcome === 'superseded') {
                await (sync as unknown as SyncAccountChangeWakeSchedulingHarness).handleUpdate({
                    id: 'access-change-revoke', seq: 3, createdAt: 3,
                    body: { t: 'session-share-revoked', sessionId: 'another-shared-session' },
                });
            }
            hold = false;
            release.resolve();
            const result = await firstOutcome;
            await (sync as unknown as { sessionsSync: Pick<InvalidateSync, 'awaitQueue'> }).sessionsSync.awaitQueue();
            await expect.poll(() => telemetry.snapshot().events.some(event => event.name === 'sync.sessions.snapshot.backgroundHydration')).toBe(true);
            if (outcome !== 'superseded') {
                await expect.poll(() => errors.mock.calls.filter(call => call[0] === '[sessionsSnapshot] Background hydration failed').length).toBe(1);
            }
            const backgroundErrors = errors.mock.calls.filter(call => call[0] === '[sessionsSnapshot] Background hydration failed');
            if (outcome === 'superseded') {
                expect(result).toBe('settled');
                expect(backgroundErrors).toEqual([]);
                expect(storage.getState().sessionListRowsByServerId[serverId]?.[id]?.metadataVersion).toBe(2);
                expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('ready');
            } else {
                expect(backgroundErrors[0]?.[1]).toMatchObject({ code: 'account-encryption-currentness-unavailable', status: 503 });
                expect(result).toBe(backgroundErrors[0]?.[1]);
                expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('error');
            }
        } finally {
            hold = false;
            release.resolve();
            await firstOutcome;
            telemetry.configure({ enabled: false });
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
        const read = runtime.refreshSessionListRowProjection(scope.serverId, id).then(() => 'completed', () => 'refused');
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
            // A retired caller yields to its replacement without applying a row.
            // Account identity and same-Home access retirement still reject.
            expect(await read).toBe(change === 'other-home-retirement' || change === 'scope' ? 'completed' : 'refused');
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
            // A focused socket wake asks the canonical feed what changed. It
            // carries no record/access fact yet; unrelated Account traffic must
            // not keep an admitted Board stale while that feed is in flight.
            for (let wake = 0; wake < 1_000; wake++) {
                publishHomeAccountChange(scope.serverId, undefined, { source: 'catch-up-pending' });
            }
            expect(repository.getSnapshot(address, query)).toMatchObject({ freshness: 'fresh', loading: 'idle' });
            expect(recordReads).toBe(initialReads);
            for (const source of ['catch-up-pending', 'socket'] as const) {
                publishHomeAccountChange(scope.serverId, [sessionId], { source, changeKinds: ['session'], sessionSystemRecords: [] });
                expect(repository.getSnapshot(address, query).freshness).toBe('fresh');
            }
            expect(recordReads).toBe(initialReads);
            revision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
            publishHomeAccountChange(scope.serverId, ['session-record:sysrec_1'], { source: 'socket', changeKinds: ['account'],
                sessionSystemRecords: [{ sessionId, address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } }] });
            expect(repository.getSnapshot(address, query).freshness).toBe('stale');
            await waitForHomeGovernance(() => expect(repository.getSnapshot(address, query).data?.records[0]?.revision).toBe(revision));
            expect(repository.getSnapshot(address, query)).toMatchObject({ freshness: 'fresh', loading: 'idle' });
            revision = 'ssr1.AAAACHN5c3JlY18xAAAAAw';
            publishHomeAccountChange(scope.serverId);
            expect(repository.getSnapshot(address, query).freshness).toBe('stale');
            await waitForHomeGovernance(() => expect(repository.getSnapshot(address, query).data?.records[0]?.revision).toBe(revision));
            // Known access changes still withdraw freshness before a reread,
            // even when the detailed feed is pending.
            publishHomeAccountChange(scope.serverId, [sessionId], { source: 'catch-up-pending', changeKinds: ['share'] });
            expect(repository.getSnapshot(address, query).freshness).toBe('stale');
            await waitForHomeGovernance(() => expect(repository.getSnapshot(address, query).freshness).toBe('fresh'));
        } finally { stop(); }
    });

    it('publishes one broad revalidation per blocked cursor and connection, not one per catch-up', async () => {
        const { PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        const { subscribeHomeAccountChange } = await import('./runtime/orchestration/homeAccountChange');
        await restoreTestAccount({});
        const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness;
        const broad: unknown[] = [];
        const release = subscribeHomeAccountChange(event => {
            if (event.source === 'catch-up-pending' && event.changeKinds === undefined) broad.push(event);
        }, { includeCatchUpPending: true });
        const blockedPage = (cursor: number) => ({ changes: [{ cursor, changedAt: 1, kind: 'account',
            entityId: `${PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1}unrecognized`, hint: null }], nextCursor: cursor });
        let feedReads = 0;
        try {
            // Every read re-serves the blocked row; a catch-up spin fails here.
            changesResponse.mockImplementation(async () => {
                feedReads++;
                if (feedReads > 50) throw new Error('Catch-up kept reading the feed');
                return blockedPage(1);
            });
            for (let catchUp = 0; catchUp < 3; catchUp++) await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            expect(broad).toHaveLength(1);
            await syncRuntime!.resumeSync('manual');
            await runtime.resumeViaChanges({ accountId: ACCOUNT_ID });
            expect(broad).toHaveLength(2);
        } finally { release(); changesResponse.mockImplementation(async () => ({ changes: [], nextCursor: 1 })); }
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
        const currentMachine = () => ({ ...machine, access: { ...machine.access!, role } });
        await restoreTestAccount({ runtimeRequest: (path, init) => {
            if (path === '/v1/machines') return jsonResponse([currentMachine()]);
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(
                init?.body, id => id === machine.id ? currentMachine() : null,
            );
            return undefined;
        } });
        const { sync } = await import('./syncEngine');
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { storage } = await import('./domains/state/storage');
        const refresh = sync as unknown as { refreshMachines(): Promise<void> };
        await refresh.refreshMachines();
        expect(storage.getState().machines['shared-machine']?.access?.role).toBe('use');
        role = 'manage';
        changesResponse.mockResolvedValueOnce({ changes: [{ kind: 'machineRecipientAccess', entityId: machine.id, cursor: 1, changedAt: 1 }], nextCursor: 1 });
        await runtime.handleUpdate(accountChangeWake('grant-changed'));
        await vi.waitFor(() => expect(storage.getState().machines['shared-machine']?.access?.role).toBe('manage'));
    });

    it('prepares only the Machine named by a remote recipient-access change and ignores a generic Machine content change', async () => {
        const { Encryption } = await import('./encryption/encryption');
        const { encodeBase64, decodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
        const { computeMachineOwnerEnvelopeFingerprintV1 } = await import('@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const secret = new Uint8Array(32).fill(73);
        const author = await Encryption.create(secret);
        author.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const ids = ['remote-recipient-a', 'remote-recipient-b'];
        const keys = new Map(ids.map((id, index) => [id, new Uint8Array(32).fill(index + 81)]));
        await author.initializeMachines(keys);
        const access = { custodian: { accountId: 'custodian', displayName: 'Custodian' }, role: 'manage' as const,
            resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        const rows = await Promise.all(ids.map(async id => {
            const machine = createMachineFixture({ id, access, storageMode: 'e2ee' });
            const envelope = encodeBase64(await author.encryptEncryptionKey(keys.get(id)!));
            return { id: machine.id, seq: machine.seq, createdAt: machine.createdAt, updatedAt: machine.updatedAt,
                active: machine.active, activeAt: machine.activeAt, metadataVersion: machine.metadataVersion,
                access, storageMode: 'e2ee' as const, kind: 'persistent' as const, revokedAt: null, replacedByMachineId: null,
                metadata: await author.getMachineEncryption(id)!.encryptMetadata(machine.metadata!),
                daemonState: null, daemonStateVersion: 1,
                keyBasis: { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 1 },
                dataEncryptionKey: envelope };
        }));
        const rowsById = new Map(rows.map(row => [row.id, row]));
        const envelopeReads: string[] = [];
        await restoreTestAccount({ credentials: { token: ACCOUNT_TOKEN, secret: encodeBase64(secret, 'base64url') },
            accountMode: 'e2ee', runtimeRequest: (path, init) => {
                if (path === '/v1/machines') return jsonResponse(rows);
                if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(
                    init?.body, id => rowsById.get(id) ?? null,
                );
                if (!path.endsWith('/data-key-envelopes')) return undefined;
                const machineId = path.split('/')[3]!;
                const machine = rowsById.get(machineId);
                if (!machine?.dataEncryptionKey) return jsonResponse({ kind: 'refused', code: 'machine_unavailable' });
                envelopeReads.push(machineId);
                return jsonResponse({ machineId, custodianAccountId: 'custodian', encryptionMode: 'e2ee',
                    machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(machine.keyBasis!.dataEncryptionKey!)),
                    callerDataEncryptionKey: machine.dataEncryptionKey, nextCursor: null,
                    content: { metadata: machine.metadata, metadataVersion: machine.metadataVersion,
                        daemonState: machine.daemonState, daemonStateVersion: machine.daemonStateVersion }, recipients: [] });
            } });
        const { sync } = await import('./syncEngine');
        const runtime = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const refresh = sync as unknown as { refreshMachines(): Promise<void> };
        await refresh.refreshMachines();
        await vi.waitFor(() => expect(envelopeReads.slice().sort()).toEqual(ids.flatMap(id => [id, id]).sort()));
        envelopeReads.length = 0;

        changesResponse.mockResolvedValueOnce({ changes: [{ kind: 'machine', entityId: ids[1]!, cursor: 1, changedAt: 1 }], nextCursor: 1 });
        await runtime.handleUpdate(accountChangeWake('daemon-content-changed'));
        await runtime.resumeInFlight;
        expect(envelopeReads).toEqual([]);

        changesResponse.mockResolvedValueOnce({ changes: [{ kind: 'machineRecipientAccess', entityId: ids[0]!, cursor: 2, changedAt: 2 }], nextCursor: 2 });
        await runtime.handleUpdate(accountChangeWake('remote-grant-changed'));
        await vi.waitFor(() => expect(envelopeReads).toEqual([ids[0], ids[0]]));
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

    it.each([true, false])('boots and renews the embed session with only its explicit child credential and session corridor (approve: %s)', async (approvalGranted) => {
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
        let approvalListReads = 0;
        let serveApprovalWake = false;
        let approvalWakeCursor = 9;
        const approvalDecisions: unknown[] = [];
        const onCredentialRejected = vi.fn();
        const self = AccountApiTokenSelfV1Schema.parse({
            accountId: ACCOUNT_ID, accountEncryptionMode: 'plain',
            credentialId: '00000000-0000-4000-8000-000000000001',
            parentTokenId: '00000000-0000-4000-8000-000000000002', expiresAt: null,
            grant: { v: 1, actions: { families: ['messaging', 'session_transcripts'], ids: [] },
                targets: { sessions: ['embed'], machines: [] }, approve: approvalGranted,
                origins: ['http://localhost:5199'], models: null, permissionModes: null, create: null },
            embedConfig: null,
        });
        const approval = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 10, updatedAtMs: 11,
            createdBy: { surface: 'agent', sessionId: 'embed' }, requestedSurface: 'agent',
            qualifiedActionId: 'dev.leads-fixture/actions/update-stage', input: { leadId: 'verdant', stage: 'qualified' },
            sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' },
            policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), approvalInputCustody: 'live_only',
            replayPlacement: { serverId: 'daemon-local-profile', machineId: 'fixture-machine', defaultSessionId: 'embed' },
            summary: 'Update this lead’s stage?',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'session', sessionId: 'embed', starterDepth: 0, turnDepth: 0 },
                accountId: ACCOUNT_ID, serverId: 'daemon-local-profile', machineId: 'fixture-machine', sessionId: 'embed',
                actionId: 'action.invoke', requestId: 'approval-request' },
        });
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            paths.push(url.pathname);
            expect(new Headers(init?.headers).get('authorization')).toBe(
                url.pathname === '/v1/features' ? null : `Bearer ${expectedToken}`,
            );
            if (url.pathname === '/v1/auth/api-tokens/self') return jsonResponse(self);
            if (url.pathname === '/v1/features') return currentAccountStoredContentCompatibilityFeaturesResponse();
            if (url.pathname === '/v2/cursor') return credentialRejected
                ? new Response(null, { status: 401 }) : jsonResponse({ cursor: 8, changesFloor: 0 });
            if (url.pathname === '/v2/changes') {
                expect(url.searchParams.get('sessionId')).toBe('embed');
                changesAfter.push(url.searchParams.get('after') ?? '');
                return jsonResponse({
                    changes: serveApprovalWake
                        ? [{ cursor: approvalWakeCursor, kind: 'session', entityId: 'embed', changedAt: 12, hint: null }]
                        : [],
                    nextCursor: approvalWakeCursor,
                });
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
            if (url.pathname === '/v1/actions/approval.request.list') {
                approvalListReads += 1;
                if (!approvalGranted) return new Response(JSON.stringify({ error: 'credential_scope_denied' }), { status: 403 });
                return jsonResponse({
                v: 1, actionId: 'approval.request.list', execution: { ok: true, result: {
                    items: [{ artifactId: 'embed-approval', status: 'open', actionId: 'action.invoke',
                        summary: approval.summary, sessionId: 'embed', updatedAtMs: approval.updatedAtMs }],
                    nextCursor: null, queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false },
                } },
                });
            }
            if (url.pathname === '/v1/actions/approval.request.get') return jsonResponse({
                v: 1, actionId: 'approval.request.get', execution: { ok: true, result: {
                    artifactId: 'embed-approval', request: approval,
                    queryPlan: { kind: 'approval_artifact_id_lookup', backingStore: 'ArtifactStore',
                        boundedBy: 'approval artifact id', hydratedTranscripts: false },
                } },
            });
            if (url.pathname === '/v1/actions/approval.request.decide') {
                approvalDecisions.push(JSON.parse(String(init?.body)));
                return jsonResponse({ v: 1, actionId: 'approval.request.decide', execution: { ok: true, result: {
                    artifactId: 'embed-approval', status: 'executed', execution: { executedAtMs: 12, ok: true },
                } } });
            }
            throw new Error(`Account request escaped embed: ${url.pathname}`);
        }));
        const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
        const { createEmbedSessionRuntime } = await import('@/embed/runtime/createEmbedSessionRuntime');
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl: 'http://localhost:53288' });
        try {
        await runtime.initialize({ sessionId: 'embed', parentOrigin: 'http://localhost:5199', credential: {
            token: expectedToken, expiresAt: new Date(Date.now() + 900_000).toISOString(),
        } });
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', displayedSessionId: 'embed' });
        if (approvalGranted) {
            // Readiness no longer waits for the independent approval inventory.
            // Its existing pushed owner must still publish the admitted card.
            const { storage } = await import('@/sync/domains/state/storage');
            await vi.waitFor(() => expect(storage.getState().artifacts['embed-approval']).toBeDefined());
        }
        expect(paths).toContain('/v2/sessions/embed');
        expect(paths).toContain('/v1/sessions/embed/messages');
        expect(paths).toContain('/v2/sessions/embed/pending');
        expect(paths.includes('/v1/actions/approval.request.list')).toBe(approvalGranted);
        expect(paths.includes('/v1/actions/approval.request.get')).toBe(approvalGranted);
        expect(paths.every((path) => path.includes('/embed') || path.startsWith('/v1/actions/approval.request.')
            || path === '/v2/cursor' || path === '/v1/features' || path === '/v1/auth/api-tokens/self')).toBe(true);
        expect(storedCredentialRead).not.toHaveBeenCalled();
        expect(scopedCredentialRead).not.toHaveBeenCalled();
        expect(apiRequest).not.toHaveBeenCalled();
        expect(kvStore.size).toBe(0);
        const state = (await import('@/sync/domains/state/storage')).storage;
        const retainedTranscriptBeforeRenewal = state.getState().sessionMessages.embed;
        const retainedTurnsBeforeRenewal = state.getState().sessions.embed?.sessionTurns;
        expect(retainedTurnsBeforeRenewal).toBeDefined();
        expect(state.getState().isDataReady).toBe(true);
        if (approvalGranted) expect(state.getState().artifacts['embed-approval']).toMatchObject({
            title: approval.summary, sessions: ['embed'], header: { kind: 'target_action_approval.v1' },
        });
        else expect(state.getState().artifacts['embed-approval']).toBeUndefined();
        const { listOpenApprovalArtifactsForSession } = await import('./domains/artifacts/approvalArtifacts');
        const selected = listOpenApprovalArtifactsForSession(Object.values(state.getState().artifacts), {
            serverId: 'http://localhost:53288', sessionId: 'embed',
        });
        expect(selected.map(entry => entry.artifact.id)).toEqual(approvalGranted ? ['embed-approval'] : []);
        if (approvalGranted) {
            const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
            const previousAuth = getCurrentAuth();
            const refuseCredentialMutation = async (): Promise<never> => { throw new Error('Injected credential'); };
            setCurrentAuth({ isAuthenticated: true, credentials: { token: expectedToken }, credentialAuthorityKind: 'api_token',
                login: refuseCredentialMutation, loginWithCredentials: refuseCredentialMutation, logout: refuseCredentialMutation,
                refreshFromActiveServer: async () => {} });
            let decisionHook: { unmount(): Promise<void> } | undefined;
            try {
                const { isApprovalReplayRouteUnavailable, useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
                expect(isApprovalReplayRouteUnavailable(approval)).toBe(false);
                const hook = await renderHook(() => useApprovalDecisionHandler(selected[0].artifact, selected[0].approval, 'embed', 'http://localhost:53288'));
                decisionHook = hook;
                await expect(hook.getCurrent()('approve')).resolves.toBe(true);
                expect(approvalDecisions).toEqual([{ v: 1, target: { kind: 'session', sessionId: 'embed' },
                    input: { artifactId: 'embed-approval', decision: 'approve' } }]);
            } finally { await decisionHook?.unmount(); setCurrentAuth(previousAuth); }
        }
        expect((sync as unknown as SyncAccountChangeCatchUpHarness).changesCursor).toBe('8');
        const initialContext = sync.getEmbedSessionRequestContext();
        paths.length = 0;
        expectedToken = 'hap_v1_renewed';
        accessLevel = 'edit';
        serveApprovalWake = true;
        await sync.create({ token: expectedToken }, null, undefined, {
            scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
            endpointUrl: 'http://localhost:53288', accountMode: 'plain', approvalGranted, isCurrent: () => true, onCredentialRejected,
        });
        expect(paths).toContain('/v2/sessions/embed');
        expect(paths).toContain('/v2/changes');
        expect(changesAfter).toEqual(['8']);
        expect(paths).not.toContain('/v1/features/authenticated');
        expect(paths).not.toContain('/v2/cursor');
        expect(approvalListReads).toBe(approvalGranted ? 2 : 0);
        expect(state.getState().sessionMessages.embed).toBe(retainedTranscriptBeforeRenewal);
        expect(state.getState().sessions.embed?.sessionTurns).toBe(retainedTurnsBeforeRenewal);
        expect(state.getState().sessions.embed?.access?.capabilities.submitAgentInput).toBe(true);
        expect(initialize.mock.calls.map(([configuration]) => configuration.token))
            .toEqual(['hap_v1_child', 'hap_v1_renewed']);
        await expect(initialContext!.request('/v2/sessions/embed')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });

        // An auth renewal with no exact Session/share row must not reread approvals.
        paths.length = 0;
        expectedToken = 'hap_v1_final';
        serveApprovalWake = false;
        await sync.create({ token: expectedToken }, null, undefined, {
            scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
            endpointUrl: 'http://localhost:53288', accountMode: 'plain', approvalGranted, isCurrent: () => true, onCredentialRejected,
        });
        expect(changesAfter).toEqual(['8', '9']);
        expect(approvalListReads).toBe(approvalGranted ? 2 : 0);
        expect(paths).not.toContain('/v1/actions/approval.request.list');
        expect(paths).not.toContain('/v1/actions/approval.request.get');
        expect(initialize.mock.calls.map(([configuration]) => configuration.token))
            .toEqual(['hap_v1_child', 'hap_v1_renewed', 'hap_v1_final']);

        // Deliver the same content-free, credential-qualified Session wake the
        // Artifact writer publishes, through the real socket listener and feed.
        serveApprovalWake = true;
        approvalWakeCursor = 10;
        const approvalWake = sockets.at(-1)?.listenersAny()[0];
        expect(approvalWake).toBeDefined();
        approvalWake?.('update', { id: 'approval-wake', seq: 10, createdAt: 12,
            body: { t: 'account-change', changeKinds: ['session'], entityIds: ['embed'] } });
        await vi.waitFor(() => expect(changesAfter).toEqual(['8', '9', '9']));
        await vi.waitFor(() => expect(approvalListReads).toBe(approvalGranted ? 3 : 0));
        serveApprovalWake = false;

        if (approvalGranted) {
            await sync.create({ token: expectedToken }, null, undefined, {
                scope: { kind: 'embedSession', sessionId: 'embed' }, accountId: ACCOUNT_ID,
                endpointUrl: 'http://localhost:53288', accountMode: 'plain', approvalGranted: false,
                isCurrent: () => true, onCredentialRejected,
            });
            expect(state.getState().isDataReady).toBe(true);
            expect(state.getState().artifacts['embed-approval']).toBeUndefined();
            expect(state.getState().sessionMessages.embed).toBe(retainedTranscriptBeforeRenewal);
            expect(approvalListReads).toBe(3);
        }

        const onUpdate = sockets.at(-1)?.listenersAny()[0];
        const before = (await import('@/sync/domains/state/storage')).storage.getState().sessions.embed?.access;
        onUpdate?.('update', { id: 'u', seq: 1, createdAt: 2, body: { t: 'update-session', id: 'embed',
            access: { role: 'owner', capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) } } });
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
        } finally { runtime.dispose(); }
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
        const { SessionDisplayProjectionV1Schema, projectSessionDisplayV1} = await import('@happier-dev/protocol/sessions');
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

    it('keeps acquired Collection reads quiet through initial connect and catches one missed change', async () => {
        await restoreTestAccount();
        const { watchActivePluginCollectionUiQuery, queryActivePluginCollectionUiQuery } = await import('@/sync/api/plugins/data/queryPluginCollectionUiQuery');
        const { buildPluginDomainAccountChangeEntityId } = await import('@happier-dev/protocol/changes');
        let readCursor = 42;
        let reads = 0;
        const readStarted = createDeferred<void>();
        const readRelease = createDeferred<void>();
        domainHttp.mockImplementation(async ({ url, init }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/plugins/data/ui-query') {
                reads++;
                const snapshotCursor = readCursor;
                readStarted.resolve();
                await readRelease.promise;
                return collectionResponse('current', snapshotCursor);
            }
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? jsonResponse({});
        });
        const hint = { pluginDomain: 'dataCollection' as const, pluginId: DATA_PLUGIN_ID, collectionId: 'tasks',
            contractDigest: 'a'.repeat(43), revision: 1, full: true as const };
        const change = (cursor: number) => ({ cursor, kind: 'pluginDomain' as const,
            entityId: buildPluginDomainAccountChangeEntityId(hint), changedAt: cursor, hint });
        let page = [change(40)];
        changesResponse.mockImplementation(async ({ url }) => {
            const after = Number(new URL(url).searchParams.get('after'));
            return { changes: page.filter(entry => entry.cursor > after), nextCursor: Math.max(after, ...page.map(entry => entry.cursor)) };
        });
        const pending: Promise<unknown>[] = [];
        const invalidated = vi.fn(() => { pending.push(queryActivePluginCollectionUiQuery({ descriptor, request: queryRequest })); });
        const watch = watchActivePluginCollectionUiQuery({ descriptor, request: queryRequest, onInvalidated: invalidated });
        const initialRead = queryActivePluginCollectionUiQuery({ descriptor, request: queryRequest });
        try {
            await readStarted.promise;
            expect(reads).toBe(1);
            const socket = sockets.findLast(candidate => candidate.listeners('connect').length > 0);
            if (!socket) throw new Error('Expected Account socket');
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            const runtime = syncRuntime as unknown as SyncAccountChangeWakeSchedulingHarness;
            await runtime.resumeInFlight;
            await syncRuntime!.resumeSync('manual');
            expect(changesResponse).toHaveBeenCalled();
            expect(invalidated).not.toHaveBeenCalled();
            expect(reads).toBe(1);
            readRelease.resolve();
            await initialRead;
            expect(invalidated).not.toHaveBeenCalled();
            socket.connected = false;
            for (const listener of socket.listeners('disconnect')) listener('transport close');
            readCursor = 43;
            page = [change(43)];
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            await runtime.resumeInFlight;
            await Promise.all(pending.splice(0));
            expect(invalidated).toHaveBeenCalledTimes(1);
            expect(reads).toBe(2);
            await syncRuntime!.resumeSync('manual');
            expect(invalidated).toHaveBeenCalledTimes(1);
            expect(reads).toBe(2);
        } finally { readRelease.resolve(); watch.dispose(); await Promise.allSettled([initialRead, ...pending]); }
    });

    it.each(['ready', 'failed', 'disposed'] as const)('retains a genuine Collection change during first-read acquisition (%s)', async outcome => {
        await restoreTestAccount();
        const { watchActivePluginCollectionUiQuery, queryActivePluginCollectionUiQuery } = await import('@/sync/api/plugins/data/queryPluginCollectionUiQuery');
        const { buildPluginDomainAccountChangeEntityId } = await import('@happier-dev/protocol/changes');
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        domainHttp.mockImplementation(async ({ url, init }) => {
            const path = new URL(url).pathname;
            if (path === '/v1/plugins/data/ui-query') {
                started.resolve(); await release.promise;
                return outcome === 'failed' ? jsonResponse({ error: 'collection_unavailable' }) : collectionResponse('current', 42);
            }
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? jsonResponse({});
        });
        const invalidated = vi.fn();
        const watch = watchActivePluginCollectionUiQuery({ descriptor, request: queryRequest, onInvalidated: invalidated });
        const read = queryActivePluginCollectionUiQuery({ descriptor, request: queryRequest });
        const settled = read.catch(() => undefined);
        try {
            await started.promise;
            const hint = { pluginDomain: 'dataCollection' as const, pluginId: DATA_PLUGIN_ID, collectionId: 'tasks',
                contractDigest: 'a'.repeat(43), revision: 1, full: true as const };
            changesResponse.mockResolvedValueOnce({ changes: [{ cursor: 43, kind: 'pluginDomain',
                entityId: buildPluginDomainAccountChangeEntityId(hint), changedAt: 43, hint }], nextCursor: 43 });
            await syncRuntime!.resumeSync('manual');
            expect(invalidated).not.toHaveBeenCalled();
            if (outcome === 'disposed') watch.dispose();
            release.resolve(); await settled;
            expect(invalidated).toHaveBeenCalledTimes(outcome === 'disposed' ? 0 : 1);
        } finally { release.resolve(); watch.dispose(); await settled; }
    });

    it('does not assign another query acquisition basis to an unread Collection observer', async () => {
        await restoreTestAccount();
        const { watchActivePluginCollectionUiQuery, queryActivePluginCollectionUiQuery } = await import('@/sync/api/plugins/data/queryPluginCollectionUiQuery');
        const { buildPluginDomainAccountChangeEntityId } = await import('@happier-dev/protocol/changes');
        domainHttp.mockImplementation(async ({ url, init }) => new URL(url).pathname === '/v1/plugins/data/ui-query'
            ? collectionResponse('current', 42) : createEmptyAccountBootstrapHttpResponse(new URL(url).pathname, init) ?? jsonResponse({}));
        const invalidated = vi.fn();
        const watch = watchActivePluginCollectionUiQuery({ descriptor: { ...descriptor, id: 'other' },
            request: { ...queryRequest, uiQueryId: 'other' }, onInvalidated: invalidated });
        try {
            await queryActivePluginCollectionUiQuery({ descriptor, request: queryRequest });
            const hint = { pluginDomain: 'dataCollection' as const, pluginId: DATA_PLUGIN_ID, collectionId: 'tasks',
                contractDigest: 'a'.repeat(43), revision: 1, full: true as const };
            changesResponse.mockResolvedValueOnce({ changes: [{ cursor: 40, kind: 'pluginDomain',
                entityId: buildPluginDomainAccountChangeEntityId(hint), changedAt: 40, hint }], nextCursor: 40 });
            await syncRuntime!.resumeSync('manual');
            expect(invalidated).toHaveBeenCalledTimes(1);
        } finally { watch.dispose(); }
    });

    it('repairs pre-snapshot collection observations without invalidating fresh observations acquired during repair', async () => {
        let forceRepair = false;
        domainHttp.mockImplementation(async ({ url, init }) =>
            createEmptyAccountBootstrapHttpResponse(new URL(url).pathname, init) ?? jsonResponse({}));
        await restoreTestAccount({ physicalRequest(url) {
            if (!forceRepair || new URL(url).pathname !== '/v2/changes') return undefined;
            forceRepair = false;
            return Promise.resolve(new Response(JSON.stringify({ error: 'cursor_gone', currentCursor: 0 }), { status: 410 }));
        } });
        const { watchActivePluginCollectionUiQuery, publishActivePluginCollectionUiQueryChanges } = await import('@/sync/api/plugins/data/queryPluginCollectionUiQuery');
        const { buildPluginDomainAccountChangeEntityId } = await import('@happier-dev/protocol/changes');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { watchActiveScopedPluginSettingsChanges, publishActiveScopedPluginSettingsChanges } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsChangeWatch');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the restored Account lifetime');
        const incumbent = vi.fn();
        const fresh = vi.fn();
        const incumbentSettings = vi.fn();
        const freshSettings = vi.fn();
        const oldWatch = watchActivePluginCollectionUiQuery({ descriptor, request: queryRequest, onInvalidated: incumbent });
        const settingsInput = { pluginId: SETTINGS_PLUGIN_ID, lifetime,
            target: { kind: 'account' as const, serverIdentityId: lifetime.scope.serverId } };
        const oldSettingsWatch = watchActiveScopedPluginSettingsChanges({ ...settingsInput, onInvalidated: incumbentSettings });
        const snapshotStarted = createDeferred<void>();
        const snapshotRelease = createDeferred<void>();
        profileResponseGate.mockImplementation(async () => { snapshotStarted.resolve(); await snapshotRelease.promise; });
        forceRepair = true;
        const repair = syncRuntime!.resumeSync('manual');
        let newWatch: ReturnType<typeof watchActivePluginCollectionUiQuery> = null;
        let newSettingsWatch: ReturnType<typeof watchActiveScopedPluginSettingsChanges> | undefined;
        try {
            await snapshotStarted.promise;
            // The base cursor precedes this watch and its first read. Replay
            // above that cursor covers changes; completing the old snapshot
            // is not a change to this newly acquired observation.
            newWatch = watchActivePluginCollectionUiQuery({ descriptor, request: queryRequest, onInvalidated: fresh });
            newSettingsWatch = watchActiveScopedPluginSettingsChanges({ ...settingsInput, onInvalidated: freshSettings });
            snapshotRelease.resolve();
            await repair;
            expect(incumbent).toHaveBeenCalledTimes(1);
            expect(fresh).not.toHaveBeenCalled();
            expect(incumbentSettings).toHaveBeenCalledTimes(1);
            expect(freshSettings).not.toHaveBeenCalled();
            const change = { cursor: 1, kind: 'pluginDomain' as const,
                entityId: `pluginDomain/${DATA_PLUGIN_ID}/data-collection/tasks`, changedAt: 1,
                hint: { pluginDomain: 'dataCollection' as const, pluginId: DATA_PLUGIN_ID, collectionId: 'tasks',
                    contractDigest: 'a'.repeat(43), revision: 1, full: true as const } };
            const foreignHint = { ...change.hint, collectionId: 'other' };
            publishActivePluginCollectionUiQueryChanges([{ ...change,
                entityId: buildPluginDomainAccountChangeEntityId(foreignHint), hint: foreignHint }]);
            expect(fresh).not.toHaveBeenCalled();
            publishActivePluginCollectionUiQueryChanges([change]);
            expect(incumbent).toHaveBeenCalledTimes(2);
            expect(fresh).toHaveBeenCalledTimes(1);
            const settingsHint = { pluginDomain: 'settings' as const, pluginId: SETTINGS_PLUGIN_ID, scope: 'account' as const, revision: 1 };
            publishActiveScopedPluginSettingsChanges([{ cursor: 2, kind: 'pluginDomain',
                entityId: buildPluginDomainAccountChangeEntityId(settingsHint), changedAt: 2, hint: settingsHint }]);
            expect(incumbentSettings).toHaveBeenCalledTimes(2);
            expect(freshSettings).toHaveBeenCalledTimes(1);
        } finally {
            snapshotRelease.resolve();
            await repair;
            oldWatch?.dispose();
            newWatch?.dispose();
            oldSettingsWatch.dispose();
            newSettingsWatch?.dispose();
        }
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
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
                // A named Availability change reads only that plugin's intent.
                return jsonResponse(availabilityIntentValue(AVAILABILITY_PLUGIN_ID));
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
        // The named change is read row-level: X's materializations and intent only, no census.
        const catchUpPaths = domainHttp.mock.calls.map(([params]) => new URL(params.url).pathname);
        expect(catchUpPaths).toEqual(expect.arrayContaining([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'],
        ]));
        expect(catchUpPaths).not.toContain(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']);

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
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
                return jsonResponse(successor);
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

    it('recovers draft changes and persists the cursor across Account-change wakes without rereading 188 held drafts', async () => {
        const drafts = await import('./ops/sessionDrafts/sessionDraftRepository');
        const { createSessionDraftCipher } = await import('./encryption/sessionDraftEncryption');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        const { SessionDraftReadRequestV2Schema, SessionDraftListRequestV2Schema, canonicalSessionDraftAddressV2 } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
        const paths: string[] = [];
        let sessionContextAvailable = false;
        let records: import('@happier-dev/protocol/drafts/sessionDraftsV2').SessionDraftRecordV2[] = [];
        await restoreTestAccount({ draftsEnabled: true, onRequest: path => paths.push(path),
            runtimeRequest: (path, init) => {
                if (path === SESSION_DRAFT_V2_ROUTE_LIST) {
                    const { after } = SessionDraftListRequestV2Schema.parse(JSON.parse(String(init?.body)));
                    return jsonResponse({ items: records.slice(after ? 100 : 0, after ? undefined : 100),
                        ...(!after && records.length > 100 ? { nextAfter: canonicalSessionDraftAddressV2(records[99]!.address) } : {}) });
                }
                if (path === '/v2/sessions/draft-context-recovery') return sessionContextAvailable
                    ? jsonResponse({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'draft-context-recovery' }) })
                    : Response.json({}, { status: 404 });
                if (path === '/v2/account/session-drafts/read') {
                    const { address } = SessionDraftReadRequestV2Schema.parse(JSON.parse(String(init?.body)));
                    const record = records.find(record => canonicalSessionDraftAddressV2(record.address) === canonicalSessionDraftAddressV2(address));
                    return jsonResponse(record ? { status: 'present', record } : { status: 'absent' });
                }
                return undefined;
            } });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected restored draft Account');
        const values = new Map<string, string>();
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => ({ mode: 'plain' }), randomBytes: length => new Uint8Array(length) });
        const author = drafts.createSessionDraftRepository({ syncEnabled: false, cipher,
            storage: { getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => values.set(key, value), delete: key => values.delete(key) } });
        records = await Promise.all(Array.from({ length: 188 }, async (_, index) => {
            const address = { kind: 'newSession' as const,
                draftId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` };
            author.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: `retained ${index}` } });
            return { address, revision: 1, content: await cipher.seal(address, author.getSessionDraftSnapshot(scope, address)!.document),
                createdAt: 1, updatedAt: 1 };
        }));
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(drafts.listNewSessionDraftProjections(scope)).toHaveLength(188);
        const { sync } = await import('./syncEngine');
        const socket = sockets.at(-1);
        if (!socket) throw new Error('Expected focused Account transport');
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        await sync.resumeSync('socket-reconnect');
        paths.length = 0;
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('transport close');
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        await sync.resumeSync('socket-reconnect');
        expect(paths.filter(path => path.includes('/session-drafts/'))).toEqual([]);
        expect(drafts.listNewSessionDraftProjections(scope)).toHaveLength(188);

        // A missed socket hint is still repaired by the durable cursor's exact read.
        const previous = records[0]!;
        if (previous.address.kind !== 'newSession') throw new Error('Expected New Session draft');
        author.writeNewSessionDraft({ scope, draftId: previous.address.draftId, materializationIntent: 'userEdit', patch: { text: 'edited on another device' } });
        records[0] = { ...previous, revision: 2, updatedAt: 2,
            content: await cipher.seal(previous.address, author.getSessionDraftSnapshot(scope, previous.address)!.document) };
        changesResponse.mockResolvedValue({ changes: [{ cursor: 1, kind: 'account',
            entityId: `session-draft:new-session/${previous.address.draftId}`, changedAt: 2,
            hint: { v: 2, sessionDraftV2: true, address: previous.address, revision: 2, status: 'present' },
        }], nextCursor: '1' });
        paths.length = 0;
        await sync.resumeSync('socket-reconnect');
        expect(paths.filter(path => path.includes('/session-drafts/'))).toEqual(['/v2/account/session-drafts/read']);
        expect(drafts.getSessionComposerDraftSnapshot(scope, previous.address)?.composer.text.value).toBe('edited on another device');

        // Ordinary Account-change wakes use the same persisted checkpoint owner.
        // A successful traversal must not restart at its old cursor on the next wake.
        const feed = records.map((record, index) => ({
            cursor: index + 2, kind: 'account' as const, changedAt: record.updatedAt,
            entityId: `session-draft:${canonicalSessionDraftAddressV2(record.address)}`,
            hint: { v: 2, sessionDraftV2: true, address: record.address, revision: record.revision, status: 'present' },
        }));
        const requestedCursors: number[] = [];
        changesResponse.mockImplementation(async ({ url }: { url: string }) => {
            const request = new URL(url);
            const after = Number(request.searchParams.get('after'));
            requestedCursors.push(after);
            return { changes: feed.filter(change => change.cursor > after), nextCursor: '189' };
        });
        paths.length = 0;
        const harness = sync as unknown as SyncAccountChangeWakeSchedulingHarness;
        const { loadChangesCursor } = await import('./domains/state/persistence');
        for (let wake = 0; wake < 6; wake += 1) {
            await harness.handleUpdate(accountChangeWake(`held-drafts-${wake}`));
            await harness.resumeInFlight;
            expect(harness.changesCursor).toBe('189');
            expect(loadChangesCursor(harness.getChangesCursorScope())).toBe('189');
        }
        expect(requestedCursors).toEqual([1, 189, 189, 189, 189, 189]);
        expect(paths.filter(path => path.includes('/session-drafts/'))).toEqual([]);
        expect(drafts.getSessionComposerDraftSnapshot(scope, previous.address)?.composer.text.value).toBe('edited on another device');

        // One real revision advance reaches the same composer consumer once.
        author.writeNewSessionDraft({ scope, draftId: previous.address.draftId, materializationIntent: 'userEdit', patch: { text: 'advanced during Account wake' } });
        records[0] = { ...records[0]!, revision: 3, updatedAt: 3,
            content: await cipher.seal(previous.address, author.getSessionDraftSnapshot(scope, previous.address)!.document) };
        feed.push({ ...feed[0]!, cursor: 190, changedAt: 3, hint: { ...feed[0]!.hint, revision: 3 } });
        changesResponse.mockImplementation(async ({ url }: { url: string }) => ({
            changes: feed.filter(change => change.cursor > Number(new URL(url).searchParams.get('after'))), nextCursor: '190',
        }));
        await harness.handleUpdate(accountChangeWake('one-draft-advanced'));
        await harness.resumeInFlight;
        expect(paths.filter(path => path.includes('/session-drafts/'))).toEqual(['/v2/account/session-drafts/read']);
        expect(drafts.getSessionComposerDraftSnapshot(scope, previous.address)?.composer.text.value).toBe('advanced during Account wake');
        expect(loadChangesCursor(harness.getChangesCursorScope())).toBe('190');

        // An incomplete snapshot retains its reconnect recovery until the
        // Session's independently admitted encryption context becomes available.
        const sessionAddress = { kind: 'session' as const, sessionId: 'draft-context-recovery' };
        author.writeExistingSessionDraft({ scope, sessionId: sessionAddress.sessionId, patch: { text: 'recover when its Session is readable' } });
        records.push({ address: sessionAddress, revision: 1, createdAt: 1, updatedAt: 1,
            content: await cipher.seal(sessionAddress, author.getSessionDraftSnapshot(scope, sessionAddress)!.document) });
        changesResponse.mockResolvedValue({ changes: [], nextCursor: '190' });
        await sync.resumeSync('manual');
        expect(drafts.getSessionDraftSnapshot(scope, sessionAddress)).toBeNull();
        sessionContextAvailable = true;
        paths.length = 0;
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('transport close');
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        await sync.resumeSync('socket-reconnect');
        expect(paths.filter(path => path === SESSION_DRAFT_V2_ROUTE_LIST)).toHaveLength(2);
        expect(drafts.getSessionComposerDraftSnapshot(scope, sessionAddress)?.composer.text.value).toBe('recover when its Session is readable');
        paths.length = 0;
        vi.useFakeTimers();
        try {
            await vi.advanceTimersByTimeAsync(180_000);
            expect(paths.filter(path => path.includes('/session-drafts/'))).toEqual([]);
            expect(drafts.listNewSessionDraftProjections(scope)).toHaveLength(188);
        } finally {
            vi.useRealTimers();
            drafts.resetSessionDraftRepositoryForTests();
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
            storage: { getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => values.set(key, value), delete: key => values.delete(key) } });
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
        const disclosures: Array<ReturnType<typeof usePluginSurfaceAccountEncryptionMode>> = [];
        const hook = await renderHook(() => {
            const mode = usePluginSurfaceAccountEncryptionMode({ accountLifetime: lifetime, credentials });
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
});
