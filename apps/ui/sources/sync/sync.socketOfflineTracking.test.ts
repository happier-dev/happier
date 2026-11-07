import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionSystemRecordStoredSchema} from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { type SessionOrganizationSnapshot } from '@happier-dev/protocol/sessions/organization/snapshot';
import { createMachineFixture, createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit';
import type { Socket } from 'socket.io-client';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
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

// IndexedDB is a device persistence boundary; reducers and outbox ownership stay real.
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
  const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
  return createBrowserRecordStorageModuleMock();
});

const apiSocketRequestMock = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response(
    JSON.stringify({ messages: [], nextAfterSeq: null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )),
);
const fetchChangesMock = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
);
const fetchCurrentChangesCursorMock = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
);
const machineExternalSessionTranscriptPageMock = vi.hoisted(() =>
  vi.fn<(payload: unknown) => Promise<unknown>>(),
);
const machineExternalSessionTranscriptReadAfterMock = vi.hoisted(() =>
  vi.fn<(payload: unknown) => Promise<unknown>>(),
);

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
const platformOS = vi.hoisted(() => ({ current: 'web' as 'web' | 'ios' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                get OS() {
                                                    return platformOS.current;
                                                },
                                            },
                                            AppState: {
                                                currentState: 'active',
                                                addEventListener: appStateAddListener as any,
                                            },
                                        }
    );
});

const sockets: Socket[] = [];
installDisconnectedServerSocketBoundary((socket) => {
  sockets.push(socket);
  // SDK emissions are the transport boundary; no Engine.IO engine is opened.
  vi.spyOn(socket, 'emit').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload)
      || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Malformed external-session Socket RPC');
    }
    if (payload.method.endsWith(`:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE}`)) {
      return { ok: true, result: await machineExternalSessionTranscriptPageMock(payload.params) };
    }
    if (payload.method.endsWith(`:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER}`)) {
      return { ok: true, result: await machineExternalSessionTranscriptReadAfterMock(payload.params) };
    }
    throw new Error(`Unexpected external-session Socket RPC: ${payload.method}`);
  });
});

function emitSocketStatus(status: 'connected' | 'disconnected'): void {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('No restored Home socket');
  socket.connected = status === 'connected';
  if (status === 'connected') {
    for (const listener of socket.listeners('connect')) listener();
  } else {
    for (const listener of socket.listeners('disconnect')) listener('transport close');
  }
}

vi.mock('@/log', () => ({
  log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Crash reporting is the external default-on error boundary; the real helper is inert without a DSN.
const crashReports = vi.hoisted(() => ({ captureExceptionIfEnabled: vi.fn() }));
vi.mock('@/utils/system/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/system/sentry')>()),
  captureExceptionIfEnabled: crashReports.captureExceptionIfEnabled,
}));

import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { disconnectActiveServerConnection, switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { invalidateServerReachabilitySupervisor } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { publishHomeAccountChange, subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
await loadSyncSingletonForTests();
const { sync } = await import('./sync');
import { storage } from './domains/state/storage';
import type { Machine, Session } from './domains/state/storageTypes';
import { loadChangesCursor, loadExternalSessionTailCursor, saveProfile } from './domains/state/persistence';
import { profileDefaults } from './domains/profiles/profile';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { captureActiveServerRuntimeTarget, publishActiveServerRuntimeOrigin } from '@/sync/domains/server/serverProfiles';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
  readMountedSessionRealtimeScmConsumerScopes,
  registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import {
  markSessionSurfaceVisible,
  retainVisibleSessionListSurfaces,
  resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import type { WebSyncClientIdentity } from '@/sync/runtime/webSyncClientIdentity';
import { syncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { normalizeRawMessages } from "@happier-dev/session-core/raw";
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { InvalidateSync } from '@/utils/sessions/sync';
import { createPlainV2SessionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { countStoreNotifications } from '@/dev/testkit/performance/counts';
import { captureSessionFullPublicationBaseline, sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { getSessionStatus, readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { createDeferred, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { useSessionListRenderableWithServerScope } from '@/sync/store/hooks';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { readSessionListRowRefreshAtMs } from '@/components/sessions/shell/sessionListRowViewModels';

class MemoryWebStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function installWebSelectionBoundary(): void {
  // Tab selection requires the browser host as well as its device storage.
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
}

function connectWithoutForegroundResume(): void {
  (sync as any).isForeground = false;
  emitSocketStatus('connected');
  (sync as any).isForeground = true;
}

function routeApiSocketRequestsThroughFetch(
  fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  apiSocketRequestMock.mockImplementation((path, init) => fetchMock(path, init));
}

function stubSnapshotRefreshFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url: string =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
    return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
  });
  vi.stubGlobal('fetch', fetchMock);
  routeApiSocketRequestsThroughFetch(fetchMock);
  return fetchMock;
}

/**
 * The first native viewport is served by the same older-page loader every
 * prepend uses, so its page size is asserted on a `beforeSeq` page rather than
 * on the initial `/messages` fetch, which carries no page-size policy of its
 * own.
 */
function expectApiSocketOlderMessageRequest(params: {
  sessionId: string;
  beforeSeq: string;
  limit: string;
}): void {
  const requestPath = '/v1/sessions/' + encodeURIComponent(params.sessionId) + '/messages';
  const calls = apiSocketRequestMock.mock.calls as Array<[string, RequestInit | undefined]>;
  const call = calls.find(([path]) => String(path).startsWith(requestPath + '?')
    && new URLSearchParams(String(path).split('?')[1] ?? '').has('beforeSeq'));
  expect(call).toBeDefined();
  if (!call) throw new Error('Expected apiSocket older-page request for ' + requestPath);
  const [path, init] = call;
  expect(init).toEqual(expect.objectContaining({ method: 'GET' }));
  const [, query = ''] = String(path).split('?');
  const searchParams = new URLSearchParams(query);
  expect(searchParams.get('scope')).toBe('main');
  expect(searchParams.get('beforeSeq')).toBe(params.beforeSeq);
  expect(searchParams.get('limit')).toBe(params.limit);
  expect(searchParams.has('afterSeq')).toBe(false);
  expect(searchParams.has('sidechainId')).toBe(false);
}

function hostedSessionRows() {
  return Object.values(storage.getState().sessions).map(session => ({
    id: session.id, seq: session.seq ?? 0,
    createdAt: session.createdAt ?? 1, updatedAt: session.updatedAt ?? 1,
    active: session.active ?? false, activeAt: session.activeAt ?? 1,
    encryptionMode: 'plain', dataEncryptionKey: null,
    metadata: JSON.stringify(session.metadata ?? {}), metadataVersion: session.metadataVersion ?? 1,
    agentState: session.agentState ? JSON.stringify(session.agentState) : null,
    agentStateVersion: session.agentStateVersion ?? 0, share: null,
  }));
}

async function admitHostedSessions(): Promise<void> {
  const sessions = hostedSessionRows();
  const responder = apiSocketRequestMock.getMockImplementation()!;
  apiSocketRequestMock.mockImplementation(async (path, init) => {
    const pathname = new URL(path, 'http://localhost').pathname;
    if (pathname === '/v2/sessions') return Response.json({ sessions, nextCursor: null, hasNext: false });
    if (pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
    return responder(path, init);
  });
  try {
    await (sync as any).fetchSessions({ awaitSessionListHydration: true });
  } finally {
    apiSocketRequestMock.mockImplementation(responder);
    apiSocketRequestMock.mockClear();
  }
}

async function materializeLoadedTranscript(sessionId: string, seq: number): Promise<void> {
  await admitHostedSessions();
  // Loaded flags alone describe a blank cache, whose real owner must snapshot.
  // These catch-up cases require an accepted row, not just a sequence hint.
  storage.getState().applyMessages(sessionId, normalizeRawMessages([{
    id: `${sessionId}-accepted`, localId: null, seq, createdAt: seq,
    raw: { role: 'user', content: { type: 'text', text: 'accepted before reconnect' } },
  }]));
  storage.getState().applyMessagesLoaded(sessionId);
}

function expectApiSocketMessageRequest(params: {
  sessionId: string;
  afterSeq: string;
  limit: string;
}): void {
  const requestPath = `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages`;
  const calls = apiSocketRequestMock.mock.calls as Array<[string, RequestInit | undefined]>;
  const call = calls.find(([path]) => String(path).startsWith(`${requestPath}?`));
  expect(call).toBeDefined();
  if (!call) {
    throw new Error(`Expected apiSocket request for ${requestPath}`);
  }
  const [path, init] = call;
  expect(init).toEqual(expect.objectContaining({ method: 'GET' }));

  const [, query = ''] = String(path).split('?');
  const searchParams = new URLSearchParams(query);
  expect(searchParams.get('scope')).toBe('main');
  expect(searchParams.get('afterSeq')).toBe(params.afterSeq);
  expect(searchParams.get('limit')).toBe(params.limit);
  expect(searchParams.has('beforeSeq')).toBe(false);
  expect(searchParams.has('sidechainId')).toBe(false);
}

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
const TEST_TOKEN = 'hdr.eyJzdWIiOiJ0ZXN0In0.sig';

function changesResponse(page: { status: 'ok'; changes: unknown[]; nextCursor: string } | { status: 'cursor-gone'; currentCursor: string } | { status: 'error' }): Response {
  if (page.status === 'cursor-gone') return Response.json({ error: 'cursor-gone', currentCursor: Number(page.currentCursor) }, { status: 410 });
  if (page.status === 'error') return Response.json({}, { status: 503 });
  return Response.json({ changes: page.changes, nextCursor: Number(page.nextCursor) });
}

function cursorResponse(page: { status: 'ok'; cursor: string } | { status: 'error' }): Response {
  return page.status === 'ok' ? Response.json({ cursor: Number(page.cursor), changesFloor: 0 }) : Response.json({}, { status: 503 });
}

function defaultHomeResponse(path: string, init?: RequestInit): Response {
  if (path === '/health') return Response.json({});
  if (path === '/v1/auth/ping') return Response.json({});
  if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
  if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
  if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
  if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
  if (path === '/v1/account/encryption/currentness') return Response.json({
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
  });
  if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
  if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'test' });
  if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
  if (path === '/v2/session-organization') return Response.json({ snapshot: {
    schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [],
    tagAssignments: [], orderEntries: [], labels: [],
  } });
  if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
  if (path === '/v1/sessions/active') return Response.json({ sessions: [] });
  if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
  if (path === '/v1/machines/pools/list') return Response.json({ pools: [] });
  if (path === '/v1/friends') return Response.json({ friends: [] });
  if (path === '/v1/feed') return Response.json({ items: [], hasMore: false });
  if (path === '/v1/kv') return Response.json({ items: [] });
  if (path === '/v1/plugins/availability/intents/list'
    || path === '/v1/plugins/availability/materializations/read') {
    const bootstrapResponse = createEmptyAccountBootstrapHttpResponse(path, init);
    if (bootstrapResponse) return bootstrapResponse;
  }
  if (path === '/v3/automations') return Response.json({ automations: [], nextCursor: null });
  if (path.includes('/messages')) return Response.json({ messages: [], nextAfterSeq: null, nextBeforeSeq: null, hasMore: false });
  return Response.json({ error: 'not_found' }, { status: 404 });
}

function currentOwnerSessionWireRow(row: Record<string, unknown>) {
  // These exact-detail fixtures are authenticated owner rows. Advertised
  // current access projections must carry explicit ownership/responsibility.
  return SessionCurrentProjectionRecordV1Schema.parse({
    ...row,
    effectiveAccess: {
      v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
    },
    responsibleAccountId: null,
    responsibleAccount: null,
  });
}

async function applyTestCarrier(homeCarrier: HomeCarrier): Promise<void> {
  // Cold acquisition publishes its verified carrier before applying Sync.
  // Retire the baseline HTTPS lifetime rather than mutating its live target.
  await disconnectActiveServerConnection();
  const target = captureActiveServerRuntimeTarget();
  expect(publishActiveServerRuntimeOrigin({
    target, leaseId: homeCarrier.endpointId, homeCarrier, carrier: 'iroh',
  })).toBe(true);
  await switchConnectionToActiveServer();
  await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
}

async function restoreTestHome(serverUrl = 'http://localhost:53288', serverIdentityId?: string,
  onSessionReadBatch?: () => void): Promise<void> {
  await account?.dispose();
  account = await restoreServerAccountForTest({
    serverUrl, serverIdentityId, credentials: { token: TEST_TOKEN },
    request: async (url, init) => {
      if (new URL(String(url)).pathname === '/v2/sessions/read-batch') onSessionReadBatch?.();
      return await createSessionReadBatchFetchBoundary(async (url, init) => {
      const requestUrl = new URL(String(url));
      const path = requestUrl.pathname + requestUrl.search;
      if (requestUrl.pathname === '/health') return Response.json({});
      if (requestUrl.pathname.startsWith('/v1/account/encryption')
        || requestUrl.pathname === '/v1/features' || requestUrl.pathname === '/v1/features/authenticated'
        || requestUrl.pathname.startsWith('/v1/plugins/availability/')
        || requestUrl.pathname === '/v1/account/authoring-memory') return defaultHomeResponse(requestUrl.pathname, init);
      if (requestUrl.pathname === '/v2/changes') return (await fetchChangesMock(path, init)).clone();
      if (requestUrl.pathname === '/v2/cursor') return (await fetchCurrentChangesCursorMock(path, init)).clone();
      return (await apiSocketRequestMock(path, init)).clone();
      })(url, init);
    },
  });
  await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
}

async function observeSystemRecordForWakeTest(sessionId = 'observed-wake-record') {
  const address = { serverId: getActiveServerSnapshot().serverId, sessionId };
  const query = { type: 'list', namespace: 'activity', kind: 'workflow_run.v1' } as const;
  const recordPath = `/v2/sessions/${address.sessionId}/system-records`;
  let recordId = `${sessionId}-record-before-wake`;
  const fallback = apiSocketRequestMock.getMockImplementation()!;
  apiSocketRequestMock.mockImplementation(async (path, init) => {
    const pathname = new URL(path, 'http://localhost').pathname;
    if (pathname === `/v2/sessions/${address.sessionId}`) return Response.json({ session: currentOwnerSessionWireRow({
      id: address.sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
      metadata: JSON.stringify({ path: '/observed-wake-record', host: 'localhost' }), metadataVersion: 1,
      agentState: null, agentStateVersion: 0, share: null,
    }) });
    if (pathname === recordPath) return Response.json({ records: [SessionSystemRecordStoredSchema.parse({
      id: recordId, address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId: 'run-one' },
      content: { t: 'plain', v: { v: 1 } }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    })], nextCursor: null, hasNext: false });
    return fallback(path, init);
  });
  const result = await sync.withSessionSystemRecordRuntime(address, async runtime => {
    onTestFinished(runtime.repository.subscribe(address, query, () => {}));
    await runtime.repository.refresh(address, query);
    return runtime.repository;
  });
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Observed record fixture failed: ${result.status}`);
  expect(result.value.getSnapshot(address, query)).toMatchObject({ freshness: 'fresh', loading: 'idle',
    data: { records: [{ id: recordId }] } });
  return { address, query, repository: result.value,
    setRecordId: (next: string) => { recordId = next; },
    readCount: () => apiSocketRequestMock.mock.calls.filter(([path]) => new URL(path, 'http://localhost').pathname === recordPath).length,
  };
}

describe('sync socket offline tracking', () => {
  const initialStorageState = storage.getState();

  beforeEach(async () => {
    platformOS.current = 'web';
    vi.stubGlobal('sessionStorage', new MemoryWebStorage());
    vi.stubGlobal('localStorage', new MemoryWebStorage());
    await account?.dispose();
    account = undefined;
    await loadSyncSingletonForTests();
    storage.setState(initialStorageState, true);
    kvStore.clear();
    sockets.length = 0;
    webLocks = installWebLockManagerMock();
    resetSessionSurfaceVisibilityForTests();
    syncReliabilityTelemetry.reset();
    resetServerFeaturesClientForTests();
    fetchChangesMock.mockReset();
    fetchChangesMock.mockImplementation(async () => changesResponse({
      status: 'ok' as const,
      changes: [],
      nextCursor: '0',
    }));
    fetchCurrentChangesCursorMock.mockReset();
    fetchCurrentChangesCursorMock.mockImplementation(async () => cursorResponse({ status: 'ok', cursor: '0' }));
    machineExternalSessionTranscriptPageMock.mockReset();
    machineExternalSessionTranscriptPageMock.mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    machineExternalSessionTranscriptReadAfterMock.mockReset();
    machineExternalSessionTranscriptReadAfterMock.mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      truncated: false,
    });
    apiSocketRequestMock.mockReset();
    apiSocketRequestMock.mockImplementation(async (path, init) => defaultHomeResponse(new URL(path, 'http://localhost').pathname, init));
    await restoreTestHome();
    // Restoration runs Sync's guarded subscription lifecycle. Individual cases
    // deliver SDK events without registering another set of private listeners.
    apiSocketRequestMock.mockClear();
    fetchChangesMock.mockClear();
    fetchCurrentChangesCursorMock.mockClear();
    (sync as any).lastSocketDisconnectedAtMs = null;
    (sync as any).lastSocketOfflineDurationMs = null;
    (sync as any).changesCursor = null;
    appStateAddListener.mockClear();
  });

  afterEach(async () => {
    await account?.dispose();
    account = undefined;
    webLocks.restore();
    vi.unstubAllGlobals();
  });

  it.each(['socket ingress', 'row projection', 'cache-only ingress',
    'empty observation hydrated', 'empty observation cache-only', 'empty observation durable-only',
    'empty observation durable-then-ephemeral hydrated', 'empty observation durable-then-ephemeral cache-only',
    'reset observation hydrated', 'reset observation cache-only',
    'fresh hydration hydrated', 'fresh hydration cache-only'] as const)('recovers a mounted stale Session row from a late heartbeat without unrelated writes: %s', async (boundary) => {
    vi.useFakeTimers();
    const now = Date.now();
    const serverId = getActiveServerSnapshot().serverId;
    const session = createSessionFixture({ id: 'mounted-late-heartbeat', serverId, encryptionMode: 'plain',
      active: true, activeAt: now, presence: 'online', updatedAt: now, meaningfulActivityAt: now,
      thinking: false, thinkingAt: now, latestTurnStatus: 'completed', latestTurnStatusObservedAt: now });
    if (boundary.includes('cache-only')) storage.getState().applyServerScopedSessionListRows(serverId,
      [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
    else storage.getState().applySessions([session]);
    const socket = sockets.at(-1);
    if (!socket) throw new Error('Expected the restored Home socket');
    const heartbeat = (activeAt: number) => {
      for (const listener of socket.listenersAny()) listener('ephemeral', {
        type: 'activity', id: session.id, active: true, activeAt, thinking: false,
      });
    };
    if (!boundary.startsWith('empty observation')) heartbeat(now);
    if (boundary.startsWith('reset observation')) {
      const accumulator = Reflect.get(sync, 'activityAccumulator') as { reset(): void };
      accumulator.reset();
    }
    if (boundary.startsWith('empty observation') || boundary.startsWith('reset observation')) {
      expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })).toBeUndefined();
    }
    const hook = await renderHook(() => {
      const row = useSessionListRenderableWithServerScope(serverId, session.id);
      const runtimeNowMs = useSessionListRuntimeNowMs();
      useSessionListRuntimeWake(readSessionListRowRefreshAtMs({ session: row, reminderAtMs: null }, runtimeNowMs));
      return row ? getSessionStatus(row, runtimeNowMs) : null;
    });
    const notifications = countStoreNotifications(storage);
    try {
      expect(hook.getCurrent()?.awareness.freshness).toBe('live');
      await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
      expect(hook.getCurrent()?.awareness.freshness).toBe('stale');
      notifications.reset();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        if (boundary.startsWith('fresh hydration')) {
          if (boundary.includes('cache-only')) storage.getState().applyServerScopedSessionListRowPatches(serverId,
            [{ sessionId: session.id, patch: { activeAt: now + 130_001 } }]);
          else storage.getState().applySessions([{ ...session, activeAt: now + 130_001 }]);
          notifications.reset();
        }
        if (boundary.includes('durable-')) {
          for (const listener of socket.listenersAny()) listener('update', {
            id: 'durable-only-late-beat', seq: 2, createdAt: now + 130_001,
            body: { t: 'update-session', id: session.id, sid: session.id, active: true, activeAt: now + 130_001 },
          });
        } else heartbeat(now + 130_001);
        await vi.advanceTimersByTimeAsync(loadSyncTuning().activityUpdateDebounceMs + 100);
        if (boundary === 'row projection') storage.getState().applyServerScopedSessionListRowPatches(serverId,
          [{ sessionId: session.id, patch: { activeAt: now + 130_001 } }]);
      });
      const durableOnly = boundary.includes('durable-');
      const alreadyFresh = boundary.startsWith('fresh hydration');
      expect(notifications.read().filter(keys => keys.includes('sessionListRowsByServerId'))).toHaveLength(durableOnly || alreadyFresh ? 0 : 1);
      expect(hook.getCurrent()?.awareness.freshness).toBe(durableOnly ? 'stale' : 'live');
      if (durableOnly) expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })?.presence).toBeUndefined();
      if (boundary === 'empty observation durable-only') {
        const row = storage.getState().sessionListRowsByServerId[serverId][session.id];
        expect(getSessionStatus(row, Date.now()).awareness.freshness).not.toBe('live');
      }
      expect(storage.getState().sessionListRowsByServerId[serverId][session.id].updatedAt).toBe(now);
      if (boundary.includes('durable-then-ephemeral')) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
          heartbeat(now + 130_002);
          await vi.advanceTimersByTimeAsync(loadSyncTuning().activityUpdateDebounceMs + 100);
        });
        expect(notifications.read().filter(keys => keys.includes('sessionListRowsByServerId'))).toHaveLength(1);
        expect(hook.getCurrent()?.awareness.freshness).toBe('live');
      }
    } finally {
      notifications.stop();
      await hook.unmount();
      vi.useRealTimers();
    }
  });

  it.each(['hydrated', 'cache-only', 'absent'] as const)('keeps finished Session content quiet through two live heartbeats: %s', async (kind) => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const serverId = getActiveServerSnapshot().serverId;
    const session = createSessionFixture({
      id: 'finished-heartbeat', serverId, encryptionMode: 'plain', updatedAt: now,
      meaningfulActivityAt: now, active: true, activeAt: now, presence: 'online',
      thinking: false, thinkingAt: now, latestTurnStatus: 'completed', latestTurnStatusObservedAt: now,
    });
    storage.getState().applySessions(Array.from({ length: 1_000 }, (_, index) =>
      createSessionFixture({ ...session, id: `unrelated-finished-${index}` })));
    if (kind === 'hydrated') storage.getState().applySessions([session]);
    if (kind === 'cache-only') storage.getState().applyServerScopedSessionListRows(serverId,
      [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
    const socket = sockets.at(-1);
    if (!socket) throw new Error('Expected the restored Home socket');
    const listeners = socket.listenersAny();
    expect(listeners.length).toBeGreaterThan(0);
    const heartbeat = (activeAt: number) => {
      for (const listener of listeners) listener('ephemeral', {
        type: 'activity', id: session.id, active: true, activeAt, thinking: false,
      });
    };
    const notifications = countStoreNotifications(storage);
    try {
      for (let beat = 1; beat <= 2; beat += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        heartbeat(now + beat * 60_000);
        // Released server-v0.2.16 (22ac8263cfdbcdb845441b9044ff18199cf7652e)
        // builds this durable liveness envelope, including the sid identity alias.
        // It carries no Session content update or Session-local sequence.
        if (kind !== 'absent') for (const listener of listeners) listener('update', {
          id: `alive-${beat}`, seq: beat + 1, createdAt: now + beat * 60_000,
          body: { t: 'update-session', id: session.id, sid: session.id, active: true, activeAt: now + beat * 60_000 },
        });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const contentKeys = new Set(['sessions', 'sessionListRowsByServerId', 'sessionListRenderableDelta']);
      expect(notifications.read().filter(keys => keys.some(key => contentKeys.has(key)))).toEqual([]);
      expect(notifications.read()).toEqual([]);
      expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })).toMatchObject({
        active: true, activeAt: now + 120_000, presence: 'online',
      });
      if (kind === 'absent') {
        expect(storage.getState().sessions[session.id]).toBeUndefined();
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[session.id]).toBeUndefined();
      } else {
        const row = storage.getState().sessionListRowsByServerId[serverId][session.id];
        expect(row.updatedAt).toBe(now);
        expect(row.serverId).toBe(serverId);
        expect(projectUiSessionAwareness(row, now + 239_999).freshness).toBe('live');
        expect(projectUiSessionAwareness(row, now + 240_001).freshness).toBe('stale');
        expect(readSessionStatusNextRefreshAtMs(row, now + 120_001)).toBe(now + 240_001);

        // A delayed HTTP snapshot has equal content currentness but older runtime facts.
        if (kind === 'hydrated') {
          storage.getState().applySessions([{ ...session, metadataVersion: session.metadataVersion + 1,
            metadata: { ...session.metadata!, path: '/fresh-semantic-content' } }]);
          expect(storage.getState().sessions[session.id].metadata?.path).toBe('/fresh-semantic-content');
          expect(projectUiSessionAwareness(storage.getState().sessions[session.id], now + 239_999).freshness).toBe('live');
        }
        // Contradictory aliases are rejected at the identity boundary, not
        // classified as liveness after their original identity is discarded.
        if (kind === 'hydrated') {
          notifications.reset();
          const beforeAlias = sessionRuntimeObservations.read({ serverId, sessionId: session.id });
          for (const listener of listeners) listener('update', {
            id: 'mismatched-alias', seq: 4, createdAt: now + 122_000,
            body: { t: 'update-session', id: session.id, sid: 'different-session', active: true, activeAt: now + 122_000 },
          });
          await vi.advanceTimersByTimeAsync(1_000);
          expect(notifications.read()).toEqual([]);
          expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })).toBe(beforeAlias);
        }
        notifications.reset();
        for (const listener of listeners) listener('ephemeral', {
          type: 'activity', id: session.id, active: false, activeAt: now + 123_000, thinking: false,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id].presence).toBe(now + 123_000);
        expect(notifications.read().filter(keys => keys.some(key => contentKeys.has(key)))).toHaveLength(1);
        notifications.reset();
        heartbeat(now + 124_000);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(storage.getState().sessionListRowsByServerId[serverId][session.id].presence).toBe('online');
        expect(notifications.read().filter(keys => keys.some(key => contentKeys.has(key)))).toHaveLength(1);
        // A retained content row is older than the liveness budget by this point.
        // Fresh observations, not that frozen content timestamp, define recovery.
        notifications.reset();
        for (let beat = 3; beat <= 6; beat += 1) {
          await vi.advanceTimersByTimeAsync(60_000);
          heartbeat(now + beat * 60_000);
          await vi.advanceTimersByTimeAsync(loadSyncTuning().activityUpdateDebounceMs + 100);
        }
        expect(notifications.read().filter(keys => keys.some(key => contentKeys.has(key)))).toEqual([]);
        expect(notifications.read()).toEqual([]);
        expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })?.activeAt).toBe(now + 360_000);
        storage.getState().deleteSession(session.id, serverId);
        expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })).toBeUndefined();
      }
    } finally {
      notifications.stop();
      vi.useRealTimers();
      await account?.dispose();
      account = undefined;
      heartbeat(now + 125_000);
      expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })).toBeUndefined();
    }
  });

  it.each(['Session', 'list row', 'row patch', 'row merge', 'inventory reconcile'] as const)('keeps full hydrated Session heartbeat publications quiet through the real Sync owner: %s', async (path) => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const serverId = getActiveServerSnapshot().serverId;
    const session = createSessionFixture({ id: 'hydrated-heartbeat-publication', serverId,
      encryptionMode: 'plain', active: true, activeAt: now, presence: 'online', updatedAt: now,
      thinking: false, thinkingAt: now, meaningfulActivityAt: now,
      latestTurnStatus: 'completed', latestTurnStatusObservedAt: now });
    storage.getState().applySessions(Array.from({ length: 1_000 }, (_, index) =>
      createSessionFixture({ ...session, id: `unrelated-hydrated-heartbeat-${index}` })));
    storage.getState().applySessions([session]);
    storage.getState().applyServerScopedSessionListRows(serverId,
      [storage.getState().sessionListRowsByServerId[serverId][session.id]], { source: 'ordinary', mode: 'append' });
    const retained = storage.getState().sessions[session.id];
    const row = storage.getState().sessionListRowsByServerId[serverId][session.id];
    const apply = Reflect.get(sync, 'applySessions') as (sessions: Session[]) => void;
    const notifications = countStoreNotifications(storage);
    try {
      for (let beat = 1; beat <= 2; beat += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        const clocks = { activeAt: now + beat * 60_000, updatedAt: now + beat * 60_000 };
        if (path === 'Session') apply([{ ...retained, ...clocks }]);
        else if (path === 'list row') storage.getState().applyServerScopedSessionListRows(serverId,
          [{ ...row, ...clocks }], { source: 'ordinary', mode: 'append' });
        else if (path === 'row patch') storage.getState().applyServerScopedSessionListRowPatches(serverId,
          [{ sessionId: session.id, patch: clocks }]);
        else if (path === 'row merge') storage.getState().mergeSessionListRowsForServerScope(serverId, [{ ...row, ...clocks }]);
        else storage.getState().reconcileSessionListRowsForServerScope(serverId, [{ ...row, ...clocks }],
          storage.getState().sessionListRowsByServerId[serverId], captureSessionFullPublicationBaseline(serverId, [session.id]));
      }
      if (path === 'Session') {
        const duplicate = { ...retained, activeAt: now + 120_000, updatedAt: now + 120_000 };
        apply([duplicate, duplicate]);
      }
      expect(notifications.read()).toEqual([]);
      expect(storage.getState().sessions[session.id]).toBe(retained);
      expect(storage.getState().sessionListRowsByServerId[serverId][session.id]).toBe(row);
      expect(sessionRuntimeObservations.read({ serverId, sessionId: session.id })?.activeAt).toBe(now + 120_000);
    } finally {
      notifications.stop();
      vi.useRealTimers();
    }
  });

  it('publishes one Rename commit, not its socket receipt or HTTP owner-projection echo', async () => {
    const now = Date.now();
    let row = createPlainV2SessionRecordFixture({ id: 'rename-echo-publication', active: true,
      activeAt: now - 10_000, updatedAt: now - 5_000,
      metadata: { path: '/rename-echo', host: 'localhost', summary: { text: 'Before', updatedAt: 1 } } });
    const fallback = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      if (new URL(path, 'http://localhost').pathname !== `/v2/sessions/${row.id}`) return fallback(path, init);
      if (init?.method === 'PATCH') {
        const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
        if (patch.mode !== 'owner') throw new Error('Expected a complete owner tuple Rename');
        row = { ...row, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
          agentState: patch.agentState.ciphertext, metadataVersion: patch.sharedMetadata.expectedVersion + 1,
          agentStateVersion: patch.agentState.expectedVersion + 1, updatedAt: now };
        return Response.json({ success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } });
      }
      return Response.json({ session: currentOwnerSessionWireRow({ ...row, meaningfulActivityAt: row.createdAt }) });
    });
    await sync.ensureSessionVisibleForMessageRoute(row.id, { forceRefresh: true, hydrateMessages: false });
    const socket = sockets.at(-1);
    if (!socket) throw new Error('Expected the restored Home socket');
    const notifications = countStoreNotifications(storage);
    const contentPublications = () => notifications.read().filter(keys => keys.includes('sessions'));
    try {
      await sync.patchSessionMetadataWithRetry(row.id, metadata => ({ ...metadata,
        summary: { text: 'Renamed', updatedAt: now } }));
      const committed = storage.getState().sessions[row.id];
      const afterCommit = contentPublications().length;
      // The durable socket echo carries the same admitted tuple and a newer
      // commit receipt clock, without another content or presence fact.
      for (const listener of socket.listenersAny()) listener('update', {
        id: 'rename-echo', seq: 1, createdAt: row.updatedAt,
        body: { t: 'update-session', id: row.id, sid: row.id, metadataLayoutVersion: 1,
          metadata: { value: row.metadata, version: row.metadataVersion },
          agentState: { value: row.agentState, version: row.agentStateVersion } },
      });
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const afterSocket = contentPublications().length;
      await sync.ensureSessionVisibleForMessageRoute(row.id, { forceRefresh: true, hydrateMessages: false });
      console.info('Rename publication contract:', { afterCommit, afterSocket, afterHttp: contentPublications().length });
      expect([afterCommit, afterSocket, contentPublications().length]).toEqual([1, 1, 1]);
      expect(notifications.read().filter(keys => keys.includes('sessionListRowsByServerId'))).toHaveLength(1);
      expect(storage.getState().sessions[row.id]).toBe(committed);
      expect(storage.getState().sessions[row.id].ownerMetadataView?.summary?.text).toBe('Renamed');
      notifications.reset();
      row = createPlainV2SessionRecordFixture({ ...row, metadataVersion: row.metadataVersion + 1,
        metadata: { path: '/rename-echo', host: 'localhost', summary: { text: 'Later real change', updatedAt: now + 1 } } });
      await sync.ensureSessionVisibleForMessageRoute(row.id, { forceRefresh: true, hydrateMessages: false });
      expect(contentPublications()).toHaveLength(1);
      expect(notifications.read().filter(keys => keys.includes('sessionListRowsByServerId'))).toHaveLength(1);
      expect(storage.getState().sessions[row.id].ownerMetadataView?.summary?.text).toBe('Later real change');
    } finally { notifications.stop(); }
  });

  it('publishes semantic hydration facts even when both liveness carrier clocks advance', () => {
    const serverId = getActiveServerSnapshot().serverId;
    const seed = createSessionFixture({ id: 'semantic-heartbeat-controls', serverId,
      active: true, presence: 'online', activeAt: 1, updatedAt: 1, thinking: false, thinkingAt: 0 });
    storage.getState().applySessions([seed]);
    const apply = Reflect.get(sync, 'applySessions') as (sessions: Session[]) => void;
    const changes: ReadonlyArray<Partial<Session>> = [
      { pendingRequestObservedAt: 10 }, { transcriptShareable: false },
      { hasOtherNamedCollaborator: true }, { composerOptionsInput: null },
      { currentStorageState: 'machine_only' }, { acceptedThroughServerSeq: 10 },
      { materializedThroughSourceAt: 10 }, { publishedThroughServerSeq: 10 },
      { metadataProjection: 'sessionOnly' }, { receivedRuleCount: 2 },
      { responsibleAccountId: 'responsible-account' }, { seq: 10 },
      { metadataVersion: 2, metadata: { path: '/real-semantic-change', host: 'localhost' } },
      { pendingCount: 2, pendingVersion: 2 },
    ];
    for (const [index, change] of changes.entries()) {
      const previous = storage.getState().sessions[seed.id];
      const clock = 20 + index;
      apply([{ ...previous, ...change, activeAt: clock, updatedAt: clock }]);
      expect(storage.getState().sessions[seed.id]).not.toBe(previous);
      expect(storage.getState().sessions[seed.id]).toMatchObject(change);
    }
    const previous = storage.getState().sessions[seed.id];
    apply([{ ...previous, updatedAt: 100 }]);
    expect(storage.getState().sessions[seed.id]).toBe(previous);
    expect(sessionRuntimeObservations.read({ serverId, sessionId: seed.id })?.fullPublicationUpdatedAt).toBe(100);
    const activeAtOnly = storage.getState().sessions[seed.id];
    apply([{ ...activeAtOnly, activeAt: 101 }]);
    expect(storage.getState().sessions[seed.id].activeAt).toBe(101);
    expect(storage.getState().sessions[seed.id]).not.toBe(activeAtOnly);
    const authority = Symbol('publication-authority');
    const withFutureFact = { ...storage.getState().sessions[seed.id], activeAt: 200, updatedAt: 200,
      futureAuthorityFact: { allowed: false }, [authority]: { scope: 'exact' } };
    apply([withFutureFact]);
    expect(Reflect.get(storage.getState().sessions[seed.id], 'futureAuthorityFact')).toEqual({ allowed: false });
    expect(Reflect.get(storage.getState().sessions[seed.id], authority)).toEqual({ scope: 'exact' });
    const futurePrevious = storage.getState().sessions[seed.id];
    const changedFutureFact = { ...futurePrevious, activeAt: 201, updatedAt: 201,
      futureAuthorityFact: { allowed: true }, [authority]: { scope: 'changed' } };
    apply([changedFutureFact]);
    expect(storage.getState().sessions[seed.id]).not.toBe(futurePrevious);
    expect(Reflect.get(storage.getState().sessions[seed.id], 'futureAuthorityFact')).toEqual({ allowed: true });
    expect(Reflect.get(storage.getState().sessions[seed.id], authority)).toEqual({ scope: 'changed' });
    const stopped = { ...storage.getState().sessions[seed.id], active: false, activeAt: 202, updatedAt: 202, presence: 202 };
    apply([stopped]);
    const offline = storage.getState().sessions[seed.id];
    apply([{ ...offline, activeAt: 203, updatedAt: 203, presence: 203 }]);
    expect(storage.getState().sessions[seed.id]).not.toBe(offline);
    expect(storage.getState().sessions[seed.id].activeAt).toBe(203);
  });

  it('retains newer presence and raw receipt ordering without publishing timestamp-only echoes', () => {
    const serverId = getActiveServerSnapshot().serverId;
    const seed = createSessionFixture({ id: 'delayed-carrier', serverId, active: true,
      presence: 'online', activeAt: 100, updatedAt: 100, meaningfulActivityAt: 100 });
    storage.getState().applyServerScopedSessionListRows(serverId,
      [buildSessionListRenderableFromSession(seed)], { source: 'ordinary', mode: 'append' });
    const patch = (value: Partial<SessionListRenderableSession>) => storage.getState().applyServerScopedSessionListRowPatches(serverId,
      [{ sessionId: seed.id, patch: value }]);
    const address = { serverId, sessionId: seed.id };
    sessionRuntimeObservations.observe(address, { active: false, activeAt: 123, presence: 123 });
    patch({ active: false, activeAt: 123, presence: 123 });
    sessionRuntimeObservations.observe(address, { active: true, activeAt: 124, presence: 'online' });
    patch({ active: true, activeAt: 124, presence: 'online' });
    const retained = storage.getState().sessionListRowsByServerId[serverId][seed.id];
    const notifications = countStoreNotifications(storage);
    try {
      patch({ active: true, activeAt: 120, updatedAt: 120 });
      expect(storage.getState().sessionListRowsByServerId[serverId][seed.id]).toBe(retained);
      expect(notifications.read()).toEqual([]);
      expect(sessionRuntimeObservations.read(address)).toMatchObject({ activeAt: 124, presence: 'online' });
      patch({ activeAt: 124, updatedAt: 125 });
      expect(storage.getState().sessionListRowsByServerId[serverId][seed.id]).toBe(retained);
      expect(sessionRuntimeObservations.read(address)?.fullPublicationUpdatedAt).toBe(125);
      expect(notifications.read()).toHaveLength(0);
      notifications.reset();
      patch({ activeAt: 121, updatedAt: 126, hasOtherNamedCollaborator: true });
      expect(storage.getState().sessionListRowsByServerId[serverId][seed.id]).toMatchObject({
        activeAt: 124, updatedAt: 126, hasOtherNamedCollaborator: true,
      });
      expect(notifications.read()).toHaveLength(1);
    } finally {
      notifications.stop();
    }
  });

  it.each(['advisory Session', 'advisory Account', 'legacy'] as const)(
    'revalidates observed Session System Records before held catch-up answers: %s', async wake => {
      const observed = await observeSystemRecordForWakeTest();
      const unrelated = await observeSystemRecordForWakeTest('unrelated-wake-record');
      Reflect.set(sync, 'isForeground', true);
      Reflect.set(sync, 'changesCursor', '0');
      const socket = sockets.at(-1);
      if (!socket) throw new Error('Expected the restored Home socket');
      let releaseFeed!: (response: Response) => void;
      const heldFeed = new Promise<Response>(resolve => { releaseFeed = resolve; });
      fetchChangesMock.mockImplementationOnce(async () => await heldFeed);
      try {
        // Start real catch-up and leave its first HTTP page unanswered. The
        // initial coarse wake is allowed to settle the observed record first.
        for (const listener of socket.listenersAny()) listener('update', {
          id: 'held-record-catch-up', seq: 1, createdAt: 1, body: { t: 'account-change' },
        });
        await vi.waitFor(() => expect(fetchChangesMock).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(observed.repository.getSnapshot(observed.address, observed.query))
          .toMatchObject({ freshness: 'fresh', loading: 'idle' }));
        await vi.waitFor(() => expect(unrelated.repository.getSnapshot(unrelated.address, unrelated.query))
          .toMatchObject({ freshness: 'fresh', loading: 'idle' }));
        const before = observed.readCount();
        const unrelatedBefore = unrelated.readCount();
        const unrelatedSnapshot = unrelated.repository.getSnapshot(unrelated.address, unrelated.query);
        observed.setRecordId('record-after-advisory-wake');
        publishHomeAccountChange(observed.address.serverId, wake === 'legacy' ? undefined : [observed.address.sessionId], {
          source: 'catch-up-pending',
          ...(wake === 'advisory Session' ? { changeKinds: ['session'] as const }
            : wake === 'advisory Account' ? { changeKinds: ['account'] as const } : {}),
        });
        await vi.waitFor(() => expect(observed.readCount()).toBe(before + 1));
        expect(fetchChangesMock).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(observed.repository.getSnapshot(observed.address, observed.query))
          .toMatchObject({ freshness: 'fresh', loading: 'idle', data: { records: [{ id: 'record-after-advisory-wake' }] } }));
        if (wake === 'advisory Session') {
          expect(unrelated.repository.getSnapshot(unrelated.address, unrelated.query)).toBe(unrelatedSnapshot);
          expect(unrelated.readCount()).toBe(unrelatedBefore);
        } else {
          await vi.waitFor(() => expect(unrelated.readCount()).toBe(unrelatedBefore + 1));
        }
      } finally {
        releaseFeed(changesResponse({ status: 'ok', nextCursor: '1', changes: [] }));
        await (Reflect.get(sync, 'resumeInFlight') as Promise<unknown> | null);
      }
    },
  );

  it('routes committed socket wake facts to pending readers while legacy and security wakes remain coarse', async () => {
    await restoreTestHome();
    const observed = await observeSystemRecordForWakeTest();
    Reflect.set(sync, 'isForeground', true);
    Reflect.set(sync, 'changesCursor', '0');
    const socket = sockets.at(-1);
    if (!socket) throw new Error('Expected the restored Home socket');
    const pending: HomeAccountChangeEvent[] = [];
    const detailed: HomeAccountChangeEvent[] = [];
    const release = subscribeHomeAccountChange(event => {
      if (event.source === 'catch-up-pending') pending.push(event);
      else detailed.push(event);
    }, { includeCatchUpPending: true });
    onTestFinished(release);
    for (const [index, changeKinds] of [['session'], ['account'], ['future-kind'], [], undefined].entries()) {
      const cursor = index + 1;
      const before = observed.readCount();
      observed.setRecordId(`record-after-sdk-wake-${cursor}`);
      let releaseFeed!: (response: Response) => void;
      const heldFeed = new Promise<Response>(resolve => { releaseFeed = resolve; });
      fetchChangesMock.mockImplementationOnce(async () => await heldFeed);
      try {
        for (const listener of socket.listenersAny()) listener('update', {
          id: `routing-wake-${cursor}`, seq: cursor, createdAt: 1,
          body: { t: 'account-change', ...(changeKinds ? { changeKinds } : {}), entityIds: [observed.address.sessionId] },
        });
        expect(pending).toHaveLength(cursor);
        expect(pending[index]).not.toHaveProperty('feedPageConsumed');
        if (index === 0) expect(pending[index]).toMatchObject({ changeKinds: ['session'], entityIds: [observed.address.sessionId] });
        else {
          expect(pending[index].changeKinds).toBeUndefined();
          expect(pending[index].entityIds).toBeUndefined();
        }
        await vi.waitFor(() => expect(fetchChangesMock).toHaveBeenCalledTimes(cursor));
        await vi.waitFor(() => expect(observed.readCount()).toBe(before + 1));
        await vi.waitFor(() => expect(observed.repository.getSnapshot(observed.address, observed.query))
          .toMatchObject({ freshness: 'fresh', loading: 'idle', data: { records: [{ id: `record-after-sdk-wake-${cursor}` }] } }));
      } finally {
        releaseFeed(changesResponse({ status: 'ok', nextCursor: String(cursor), changes: index === 1
          ? [{ cursor, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 1 } }]
          : [] }));
        await (Reflect.get(sync, 'resumeInFlight') as Promise<unknown> | null);
      }
      if (index === 1) {
        // This receipt comes from Sync's real detailed-page publisher. Its
        // independent consumption proof must not re-read the observed record
        // a second time merely because the advisory wake already supplied ids.
        expect(detailed).toContainEqual(expect.objectContaining({ entityIds: ['self'], feedPageConsumed: true }));
        await vi.waitFor(() => expect(observed.repository.getSnapshot(observed.address, observed.query))
          .toMatchObject({ freshness: 'fresh', loading: 'idle' }));
        expect(observed.readCount()).toBe(before + 1);
      }
    }
  });

  it.each(['listed', 'unlisted'] as const)('keeps visible Session content quiet when hintless AccountChange heartbeats demand real HTTP hydration: %s', async (membership) => {
    const now = Date.now();
    let batchRequests = 0;
    const rows = Array.from({ length: membership === 'listed' ? 2 : 1 }, (_, index) => ({
      id: `account-change-heartbeat-${index}`,
      activeAt: now - 30_095 + index * 7_118,
      updatedAt: now - 20_000 + index * 6_194,
      metadataVersion: 9,
      summary: 'READY',
    }));
    const fallback = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      for (const row of rows) {
        if (pathname === `/v2/sessions/${row.id}`) {
          return Response.json({ session: currentOwnerSessionWireRow({
            id: row.id, seq: 0, createdAt: 1, updatedAt: row.updatedAt, active: true, activeAt: row.activeAt,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
            metadata: JSON.stringify({ path: '/account-change-heartbeat', host: 'localhost',
              summary: { text: row.summary, updatedAt: now - 20_000 } }), metadataVersion: row.metadataVersion,
            latestTurnId: 'ready-turn', latestTurnStatus: 'completed', latestTurnStatusObservedAt: now - 35_000,
            agentState: null, agentStateVersion: 0, share: null,
          }) });
        }
      }
      return fallback(path, init);
    });
    await restoreTestHome(undefined, undefined, () => { batchRequests += 1; });
    const serverId = getActiveServerSnapshot().serverId;
    for (const row of rows) {
      await sync.ensureSessionVisibleForMessageRoute(row.id, { forceRefresh: true, hydrateMessages: false });
      expect(storage.getState().sessions[row.id]).toMatchObject({ active: true, thinking: false,
        metadataVersion: 9, latestTurnStatus: 'completed' });
    }
    if (membership === 'listed') {
      storage.getState().applyServerScopedSessionListRows(serverId,
        rows.map(row => buildSessionListRenderableFromSession(storage.getState().sessions[row.id])),
        { source: 'ordinary', mode: 'append' });
    }
    for (const row of rows) expect((storage.getState().ordinarySessionListMembershipByServerId[serverId] ?? []).includes(row.id))
      .toBe(membership === 'listed');
    const release = retainVisibleSessionListSurfaces(rows.map(row => ({ serverId, sessionId: row.id })));
    for (const row of rows) await sync.ensureSessionVisibleForMessageRoute(row.id, { hydrateMessages: false });
    const socket = sockets.at(-1);
    if (!socket) throw new Error('Expected the restored Home socket');
    let cursor = 0;
    const deliverChange = async (row: typeof rows[number]) => {
      cursor += 1;
      fetchChangesMock.mockResolvedValueOnce(changesResponse({ status: 'ok', nextCursor: String(cursor),
        changes: [{ cursor, kind: 'session', entityId: row.id, changedAt: row.updatedAt, hint: null }] }));
      for (const listener of socket.listenersAny()) listener('update', {
        id: `account-change-${cursor}`, seq: cursor, createdAt: row.updatedAt,
        body: { t: 'account-change', changeKinds: ['session'], entityIds: [row.id] },
      });
      const resume = Reflect.get(sync, 'resumeInFlight') as Promise<void> | null;
      expect(resume).not.toBeNull();
      await resume;
    };
    // Establish this visible owner's actual read shape before measuring idle
    // beats, including the real socket witness and independent HTTP clock pair.
    for (const row of rows) for (const listener of socket.listenersAny()) listener('ephemeral', {
      type: 'activity', id: row.id, active: true, activeAt: row.activeAt, thinking: false,
    });
    await new Promise(resolve => setTimeout(resolve, loadSyncTuning().activityUpdateDebounceMs + 100));
    for (const row of rows) await deliverChange(row);
    const retained = rows.map(row => storage.getState().sessions[row.id]);
    batchRequests = 0;
    const notifications = countStoreNotifications(storage);
    // Only the clock boundary is virtual: real HTTP/batch scheduling stays live.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      for (let beat = 1; beat <= 2; beat += 1) {
        for (const [index, row] of rows.entries()) {
          vi.setSystemTime(now + beat * 60_000 - 6_000 + index * 6_000);
          // Capture-shaped deltas are not equal: heartbeat receipt follows its
          // activity fact, and the two READY Sessions arrive six seconds apart.
          row.activeAt += index === 0 ? 60_012 : 60_006;
          row.updatedAt += index === 0 ? 60_131 : 60_110;
          await deliverChange(row);
        }
        expect(notifications.read().filter(keys => keys.some(key => key === 'sessions'
          || key === 'sessionListRowsByServerId' || key === 'sessionListRenderableDelta'))).toEqual([]);
      }
      expect(fetchChangesMock).toHaveBeenCalled();
      expect(batchRequests).toBe(rows.length * 2);
      for (const [index, row] of rows.entries()) {
        expect(storage.getState().sessions[row.id]).toBe(retained[index]);
        expect(sessionRuntimeObservations.read({ serverId, sessionId: row.id })?.activeAt).toBe(row.activeAt);
      }
      if (membership === 'listed') expect(notifications.read()).toEqual([]);
      else {
        expect(notifications.read()).toHaveLength(4);
        expect(notifications.read().flat()).toEqual(Array<string>(4).fill('concurrentSessionListCacheByServerId'));
      }
      console.info('HTTP heartbeat publication contract:', { membership, sessionCount: rows.length,
        batchRequests, rootPublications: notifications.read() });
      if (membership === 'listed') {
        notifications.reset();
        vi.setSystemTime(now + 126_000);
        rows[0].metadataVersion += 1;
        rows[0].summary = 'real content change';
        rows[0].updatedAt += 6_000;
        rows[0].activeAt += 6_000;
        await deliverChange(rows[0]);
        expect(storage.getState().sessions[rows[0].id]).toMatchObject({ metadataVersion: 10,
          metadata: { summary: { text: 'real content change' } } });
        expect(storage.getState().sessions[rows[1].id]).toBe(retained[1]);
        expect(notifications.read().filter(keys => keys.includes('sessions'))).toHaveLength(1);
      }
    } finally {
      notifications.stop();
      vi.useRealTimers();
      release();
    }
  });

  it.each(['online', 'unknown', 'newer stop'] as const)('keeps full hydration freshness tied to its actual observation witness: %s', async (witness) => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const serverId = getActiveServerSnapshot().serverId;
    const session = createSessionFixture({ id: 'hydration-observation-witness', serverId,
      active: true, activeAt: now, updatedAt: now, meaningfulActivityAt: now,
      presence: 'online', thinking: false, thinkingAt: 0 });
    storage.getState().applySessions([session]);
    const retained = storage.getState().sessions[session.id];
    const address = { serverId, sessionId: session.id };
    if (witness === 'online') sessionRuntimeObservations.observe(address, {
      active: true, activeAt: now, thinking: false, presence: 'online',
    });
    if (witness === 'newer stop') sessionRuntimeObservations.observe(address, {
      active: false, activeAt: now + 140_000, thinking: false, presence: now + 140_000,
    });
    const apply = Reflect.get(sync, 'applySessions') as (sessions: Session[]) => void;
    const notifications = countStoreNotifications(storage);
    try {
      await vi.advanceTimersByTimeAsync(130_001);
      apply([{ ...retained, activeAt: now + 130_001, updatedAt: now + 130_001 }]);
      expect(notifications.read()).toHaveLength(witness === 'online' ? 1 : 0);
      expect(storage.getState().sessions[session.id].updatedAt).toBe(retained.updatedAt);
      const row = storage.getState().sessionListRowsByServerId[serverId][session.id];
      if (witness === 'online') expect(getSessionStatus(row, Date.now()).awareness.freshness).toBe('live');
      else expect(getSessionStatus(row, Date.now()).awareness.freshness).not.toBe('live');
      notifications.reset();
      await vi.advanceTimersByTimeAsync(60_000);
      apply([{ ...storage.getState().sessions[session.id], activeAt: now + 190_001, updatedAt: now + 190_001 }]);
      expect(notifications.read()).toEqual([]);
      if (witness === 'newer stop') expect(sessionRuntimeObservations.read(address)?.presence).not.toBe('online');
    } finally {
      notifications.stop();
      vi.useRealTimers();
    }
  });

  it.each(['session', 'share'] as const)('retires an offscreen Session after a content-free %s change proves exact absence', async (kind) => {
    const serverId = getActiveServerSnapshot().serverId;
    const sessionId = 'offscreen-access-withdrawn';
    const session = createSessionFixture({ id: sessionId, serverId });
    storage.getState().applySessions([session]);
    storage.getState().applyServerScopedSessionListRows(serverId, [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
    fetchChangesMock.mockResolvedValueOnce(changesResponse({ status: 'ok', nextCursor: '1',
      changes: [{ cursor: 1, kind, entityId: sessionId, changedAt: 1 }] }));
    const fallback = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => new URL(path, 'http://localhost').pathname === `/v2/sessions/${sessionId}`
      ? Response.json({ error: 'Session not found' }, { status: 404 }) : fallback(path, init));
    const resume = Reflect.get(sync, 'resumeViaChanges') as (opts: { accountId: string; allowOfflineSnapshotRefresh: boolean }) => Promise<unknown>;
    await resume.call(sync, { accountId: 'test', allowOfflineSnapshotRefresh: false });
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]).toBeUndefined();
    expect(Reflect.get(sync, 'changesCursor')).toBe('1');
    expect(apiSocketRequestMock.mock.calls.some(([path]) => new URL(path, 'http://localhost').pathname === `/v2/sessions/${sessionId}`)).toBe(true);
  });

  it('refreshes an accessible offscreen changed Session only as a list projection', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const sessionId = 'offscreen-access-current';
    const session = createSessionFixture({ id: sessionId, serverId });
    storage.getState().applyServerScopedSessionListRows(serverId, [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
    fetchChangesMock.mockResolvedValueOnce(changesResponse({ status: 'ok', nextCursor: '1',
      changes: [{ cursor: 1, kind: 'session', entityId: sessionId, changedAt: 1 }] }));
    const fallback = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => new URL(path, 'http://localhost').pathname === `/v2/sessions/${sessionId}`
      ? Response.json({ session: currentOwnerSessionWireRow({ id: sessionId, seq: 9, createdAt: 1, updatedAt: 9,
          active: true, activeAt: 9, encryptionMode: 'plain', dataEncryptionKey: null,
          metadataLayoutVersion: 0, metadata: JSON.stringify({ name: 'Current title' }), metadataVersion: 2,
          agentState: JSON.stringify({ controlledByUser: true }), agentStateVersion: 2, share: null,
          pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 0 }) }) : fallback(path, init));
    const resume = Reflect.get(sync, 'resumeViaChanges') as (opts: { accountId: string; allowOfflineSnapshotRefresh: boolean }) => Promise<unknown>;
    await resume.call(sync, { accountId: 'test', allowOfflineSnapshotRefresh: false });
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]).toMatchObject({
      seq: 9, hasPendingPermissionRequests: true, metadata: { name: 'Current title' },
    });
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(Reflect.get(sync, 'changesCursor')).toBe('1');
  });

  it('holds the change cursor when an offscreen exact projection cannot be read', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const sessionId = 'offscreen-access-offline';
    const session = createSessionFixture({ id: sessionId, serverId });
    storage.getState().applyServerScopedSessionListRows(serverId, [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
    fetchChangesMock.mockResolvedValueOnce(changesResponse({ status: 'ok', nextCursor: '1',
      changes: [{ cursor: 1, kind: 'session', entityId: sessionId, changedAt: 1 }] }));
    const fallback = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => new URL(path, 'http://localhost').pathname === `/v2/sessions/${sessionId}`
      ? Response.json({ error: 'unavailable' }, { status: 503 }) : fallback(path, init));
    const resume = Reflect.get(sync, 'resumeViaChanges') as (opts: { accountId: string; allowOfflineSnapshotRefresh: boolean }) => Promise<unknown>;
    await resume.call(sync, { accountId: 'test', allowOfflineSnapshotRefresh: false });
    expect(Reflect.get(sync, 'changesCursor')).not.toBe('1');
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]).toBeDefined();
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
  });

  it('clears lastSocketDisconnectedAtMs when socket becomes connected again', async () => {
    expect(storage.getState().isDataReady).toBe(true);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('The real fixture Account was not admitted');
    expect(readPluginAccountAvailability(lifetime.scope).readMaterializations()).toMatchObject({
      kind: 'available', availabilityCursor: 0,
    });
    // Ready must represent a completed critical bootstrap, not an expired queue wait.
    const availabilityQueue = Reflect.get(sync, 'pluginAvailabilitySync') as InvalidateSync;
    expect(await availabilityQueue.awaitQueue({ timeoutMs: loadSyncTuning().invalidateSyncAwaitTimeoutMs }))
      .toEqual({ status: 'completed' });
    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();

    // The restored Sync owner already subscribes; deliver at its SDK boundary.
    emitSocketStatus('disconnected');

    const afterDisconnected = (sync as any).lastSocketDisconnectedAtMs;
    expect(typeof afterDisconnected).toBe('number');


    emitSocketStatus('connected');

    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();
  }, 60_000);

  it('checks the Account Settings head once on the next read and on reconnect after a socket gap', async () => {
    const { retainAccountSettingsRawSnapshot, readCurrentAccountSettingsRawSnapshot } = await import('@/sync/engine/settings/accountSettingsRawSnapshot');
    const { bindAccountEncryptionObservation } = await import('@/sync/http/accountEncryptionObservationBinding');
    const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
    const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'socket-gap-account' };
    const credentials = { token: 'socket-gap-token' };
    let probes = 0;
    const request = bindAccountEncryptionObservation(async () => {
      probes++;
      return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 5 }));
    }, { credentials, credentialScopeKey: resolveAuthCredentialsScopeKey(credentials), isCurrent: () => true } as never);
    const ports = { credentials, request, readBaseline: async () => { throw new Error('The unmoved head must not read the document'); } };
    retainAccountSettingsRawSnapshot(scope, 5, { delivered: true });
    await readCurrentAccountSettingsRawSnapshot(scope, ports);
    expect(probes).toBe(0);
    emitSocketStatus('connected');
    const invalidate = vi.spyOn(Reflect.get(sync, 'settingsSync') as InvalidateSync, 'invalidate');
    emitSocketStatus('disconnected');
    expect(invalidate).not.toHaveBeenCalled();
    emitSocketStatus('connected');
    await readCurrentAccountSettingsRawSnapshot(scope, ports);
    await readCurrentAccountSettingsRawSnapshot(scope, ports);
    expect(probes).toBe(1);
    expect(invalidate).toHaveBeenCalled();
    invalidate.mockRestore();
  });

  it('publishes active ordinary Session-list offline state without erasing its last success', () => {
    const serverId = getActiveServerSnapshot().serverId;
    expect(serverId).not.toBe('');
    storage.setState((state) => ({
      ...state,
      concurrentSessionListCacheByServerId: {
        ...state.concurrentSessionListCacheByServerId,
        [serverId]: {
          serverName: 'Active Home',
          listObservation: { phase: 'ready', lastSuccessAt: 1_000 },
        },
      },
    }));

    emitSocketStatus('disconnected');

    expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation)
      .toEqual({ phase: 'offline', lastSuccessAt: 1_000 });
  });

  it('uses captured offline duration for loaded transcript catch-up after connected status clears the disconnect timestamp', async () => {
    // Admit the already-loaded transcript before simulating transport loss.
    // Awaiting HTTP fixture admission after reconnect permits unrelated pending
    // dial failure/recovery to replace the downtime this case is exercising.
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_reconnect_gap: {
          id: 's_reconnect_gap',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    await materializeLoadedTranscript('s_reconnect_gap', 20);
    markSessionSurfaceVisible('s_reconnect_gap');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_gap: 20 };
    (sync as any).isForeground = true;

    emitSocketStatus('disconnected');
    expect(typeof (sync as any).lastSocketDisconnectedAtMs).toBe('number');
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;
    emitSocketStatus('connected');
    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();
    await (sync as any).fetchMessages('s_reconnect_gap');
    expectApiSocketMessageRequest({ sessionId: 's_reconnect_gap', afterSeq: '20', limit: '150' });
  }, 60_000);

  it('uses the native history-page size for the first viewport without shrinking catch-up pages', async () => {
    platformOS.current = 'ios';
    (sync as any).syncTuning = {
      ...loadSyncTuning(),
      transcriptNativeOlderMessagesPageSize: 37,
    };
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_native_initial_page: {
          id: 's_native_initial_page',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
        s_native_catchup_page: {
          id: 's_native_catchup_page',
          seq: 21,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    await admitHostedSessions();
    // A loaded but zero-row transcript with a non-zero session hint is a blank
    // projection the owner repairs with a snapshot, not an `afterSeq` page
    // (`sync.ts#fetchMessages` `needsSnapshotLoad`), so the catch-up half is
    // established by letting that snapshot materialize one row first.
    apiSocketRequestMock.mockImplementation(async (requestPath) => {
      const path = String(requestPath);
      const isCatchupSnapshot = path.startsWith('/v1/sessions/s_native_catchup_page/messages?')
        && !new URLSearchParams(path.split('?')[1] ?? '').has('afterSeq');
      return new Response(JSON.stringify({
        messages: isCatchupSnapshot
          ? [{
              id: 'm20',
              seq: 20,
              localId: null,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'materialized' } } },
              createdAt: 20,
              updatedAt: 20,
            }]
          : [],
        hasMore: false,
        nextAfterSeq: null,
        nextBeforeSeq: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    (sync as any).isForeground = true;
    markSessionSurfaceVisible('s_native_catchup_page');
    await (sync as any).fetchMessages('s_native_catchup_page');
    apiSocketRequestMock.mockClear();

    // The native transcript owns no page-size policy of its own: it reads this
    // one tuning value (`ChatListInternal#resolveSyncLoadOlderOptions`) and
    // hands it to the same older-page loader every prepend uses, so the first
    // viewport and a later prepend request the same bounded page.
    const nativeFirstViewportLimit = sync.getSyncTuning().transcriptNativeOlderMessagesPageSize;
    expect(nativeFirstViewportLimit).toBe(37);

    await (sync as any).loadOlderMessagesFromCursor('s_native_initial_page', 21, {
      limit: nativeFirstViewportLimit,
    });
    await (sync as any).fetchMessages('s_native_catchup_page');

    expectApiSocketOlderMessageRequest({ sessionId: 's_native_initial_page', beforeSeq: '21', limit: '37' });
    expectApiSocketMessageRequest({ sessionId: 's_native_catchup_page', afterSeq: '20', limit: '150' });
  }, 60_000);

  it('uses deferred durable transcript seq for visible catch-up when the stored session seq is stale', async () => {
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_deferred_durable_gap: {
          id: 's_deferred_durable_gap',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    await materializeLoadedTranscript('s_deferred_durable_gap', 7);
    markSessionSurfaceVisible('s_deferred_durable_gap');
    (sync as any).sessionMaterializedMaxSeqById = { s_deferred_durable_gap: 7 };
    (sync as any).isForeground = true;
    (sync as any).markSessionTranscriptDeferred('s_deferred_durable_gap', {
      updateType: 'new-message',
      seq: 8,
      messageId: 'm8',
    });

    await (sync as any).fetchMessages('s_deferred_durable_gap');

    expectApiSocketMessageRequest({ sessionId: 's_deferred_durable_gap', afterSeq: '7', limit: '150' });
  }, 60_000);

  it('does not reuse captured offline duration for the same loaded transcript after catch-up succeeds', async () => {
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_reconnect_consumed: {
          id: 's_reconnect_consumed',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    const sessionRow = currentOwnerSessionWireRow({ ...hostedSessionRows()[0], archivedAt: null });
    const responder = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      if (pathname === '/v2/sessions') return Response.json({ sessions: [sessionRow], nextCursor: null, hasNext: false });
      if (pathname === '/v2/sessions/s_reconnect_consumed') return Response.json({ session: sessionRow });
      return responder(path, init);
    });
    onTestFinished(() => { apiSocketRequestMock.mockImplementation(responder); });
    await materializeLoadedTranscript('s_reconnect_consumed', 20);
    markSessionSurfaceVisible('s_reconnect_consumed');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_consumed: 20 };
    (sync as any).isForeground = true;

    // Admission can replace the transport. Reconnect its current Socket only
    // after the accepted Session, transcript and visible interest exist.
    emitSocketStatus('connected');
    const disconnectedAt = Date.now() - 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(disconnectedAt);
    try {
      emitSocketStatus('disconnected');
    } finally {
      clock.mockRestore();
    }
    // Join the recovery already started by the real transport-close listener;
    // its stop/start must settle before the external Socket reconnects.
    await invalidateServerReachabilitySupervisor({
      serverUrl: getActiveServerSnapshot().serverUrl,
      token: TEST_TOKEN,
    });
    emitSocketStatus('connected');
    expect(Reflect.get(sync, 'lastSocketDisconnectedAtMs')).toBeNull();

    await sync.refreshSessionMessages('s_reconnect_consumed');
    await sync.refreshSessionMessages('s_reconnect_consumed');

    expect(apiSocketRequestMock.mock.calls.filter(([path]) => path.startsWith('/v1/sessions/s_reconnect_consumed/messages?'))).toHaveLength(1);
  }, 60_000);

  it('does not reopen consumed transcript catch-up on duplicate connected statuses without a new disconnect', async () => {
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_reconnect_duplicate_connected: {
          id: 's_reconnect_duplicate_connected',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    const sessionRow = currentOwnerSessionWireRow({ ...hostedSessionRows()[0], archivedAt: null });
    const responder = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      if (pathname === '/v2/sessions') return Response.json({ sessions: [sessionRow], nextCursor: null, hasNext: false });
      if (pathname === '/v2/sessions/s_reconnect_duplicate_connected') return Response.json({ session: sessionRow });
      return responder(path, init);
    });
    onTestFinished(() => { apiSocketRequestMock.mockImplementation(responder); });
    await materializeLoadedTranscript('s_reconnect_duplicate_connected', 20);
    markSessionSurfaceVisible('s_reconnect_duplicate_connected');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_duplicate_connected: 20 };
    (sync as any).isForeground = true;

    emitSocketStatus('connected');
    const disconnectedAt = Date.now() - 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(disconnectedAt);
    try {
      emitSocketStatus('disconnected');
    } finally {
      clock.mockRestore();
    }
    await invalidateServerReachabilitySupervisor({
      serverUrl: getActiveServerSnapshot().serverUrl,
      token: TEST_TOKEN,
    });
    emitSocketStatus('connected');
    expect(Reflect.get(sync, 'lastSocketDisconnectedAtMs')).toBeNull();

    await sync.refreshSessionMessages('s_reconnect_duplicate_connected');
    emitSocketStatus('connected');
    await sync.refreshSessionMessages('s_reconnect_duplicate_connected');

    expect(apiSocketRequestMock.mock.calls.filter(([path]) => path.startsWith('/v1/sessions/s_reconnect_duplicate_connected/messages?'))).toHaveLength(1);
  }, 60_000);

  it('includes the turns projection for socket turn-projection hydration', async () => {
    apiSocketRequestMock.mockImplementation(async (requestPath) => {
      const path = String(requestPath);
      if (new URL(path, 'http://localhost').pathname === '/v2/sessions/s_socket_turn_projection') {
        return new Response(JSON.stringify({
          session: currentOwnerSessionWireRow({
            id: 's_socket_turn_projection',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: false,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({
              path: '/workspace',
              host: 'localhost',
              flavor: 'codex',
              codexBackendMode: 'appServer',
            }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: false }),
            share: null,
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (path === '/v1/sessions/s_socket_turn_projection/turns') {
        return new Response(JSON.stringify({
          v: 1,
          sessionId: 's_socket_turn_projection',
          latestTurnId: 'turn-1',
          updatedAt: 4,
          turns: [
            {
              turnId: 'turn-1',
              status: 'completed',
              startedAt: 1,
              updatedAt: 4,
              terminalAt: 4,
              transcriptAnchors: {
                startUserMessageSeq: 3,
                userMessageSeqs: [3],
                startSeqInclusive: 3,
                endSeqInclusive: 4,
              },
              rollback: { state: 'eligible', updatedAt: 4 },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await (sync as any).hydrateSessionFromSocketUpdate(
      's_socket_turn_projection',
      'socket-update-turn-projection',
      null,
    );

    expect(apiSocketRequestMock.mock.calls.map((call) => String((call as readonly unknown[])[0] ?? ''))).toContain(
      '/v1/sessions/s_socket_turn_projection/turns',
    );
    expect(storage.getState().sessions.s_socket_turn_projection?.rollbackEligibleTurnStarts).toEqual([3]);
  }, 60_000);

  it('clears active server machine cache during server-scoped runtime reset', () => {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const staleMachine: Machine = {
      id: 'machine-stale',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { host: 'stale', platform: 'darwin', happyCliVersion: 'test', happyHomeDir: '/stale/.happier', homeDir: '/stale' },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 0,
      revokedAt: null,
    };

    storage.setState((state) => ({
      ...state,
      isDataReady: true,
      machines: { [staleMachine.id]: staleMachine },
      machineDisplayById: { [staleMachine.id]: staleMachine },
      machineListByServerId: { [activeServerId]: [staleMachine] },
      machineListStatusByServerId: { [activeServerId]: 'idle' },
    }), true);

    (sync as any).resetServerScopedRuntimeState();

    expect(storage.getState().machines).toEqual({});
    expect(storage.getState().machineDisplayById).toEqual({});
    expect(storage.getState().machineListByServerId).not.toHaveProperty(activeServerId);
    expect(storage.getState().machineListStatusByServerId).not.toHaveProperty(activeServerId);
  });

  it('clears mounted SCM transcript consumers during server-scoped runtime reset', () => {
    const unregister = registerSessionRealtimeScmConsumerScope({ serverId: null, sessionId: 'stale-scm-session' });

    try {
      expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual([
        {
          serverId: null,
          sessionId: 'stale-scm-session',
          needsMutationTranscript: true,
        },
      ]);

      (sync as any).resetServerScopedRuntimeState();

      expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual([]);
    } finally {
      unregister();
    }
  });

  it('coalesces concurrent default session snapshot fetches', async () => {

    let resolveSessions!: () => void;
    const sessionResponseReady = new Promise<void>((resolve) => {
      resolveSessions = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (new URL(url, 'http://localhost').pathname === '/v2/sessions') {
        await sessionResponseReady;
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    const sessionFetchCalls = () => fetchMock.mock.calls.filter((call) => {
      const input = call[0];
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      return new URL(url, 'http://localhost').pathname === '/v2/sessions';
    });

    const firstFetch = (sync as any).fetchSessions();
    onTestFinished(async () => {
      resolveSessions();
      await firstFetch;
    });
    await expect.poll(() => sessionFetchCalls().length).toBe(1);

    const secondFetch = (sync as any).fetchSessions();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(sessionFetchCalls()).toHaveLength(1);

    resolveSessions();
    await Promise.all([firstFetch, secondFetch]);
  });

  it('does not advance the ordinary Session-list frontier when the in-flight snapshot was superseded', async () => {

    let resolveSessions!: () => void;
    const sessionResponseReady = new Promise<void>((resolve) => {
      resolveSessions = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (new URL(url, 'http://localhost').pathname === '/v2/sessions') {
        await sessionResponseReady;
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: 'superseded-page-2', hasNext: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    const sessionFetchCalls = () => fetchMock.mock.calls.filter((call) => {
      const input = call[0];
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      return new URL(url, 'http://localhost').pathname === '/v2/sessions';
    });

    const supersededFetch = (sync as any).fetchSessions();
    onTestFinished(async () => {
      resolveSessions();
      await supersededFetch;
    });
    await expect.poll(() => sessionFetchCalls().length).toBe(1);

    // The snapshot this read belongs to is retired while its page is in flight.
    (sync as any).invalidateSessionListSnapshot();
    resolveSessions();
    await supersededFetch;

    // No row of that page was applied, so its cursor must not be adopted:
    // adopting it would skip the page for every later continuation.
    expect((sync as any).readOrdinarySessionListFrontier()).toEqual({
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: null,
      attentionHasNext: false,
      metadataUpgradeRequiredCount: 0,
    });
  });

  it.each([
    [
      'delete-session',
      (sessionId: string) => ({ t: 'delete-session' as const, sid: sessionId }),
    ],
    [
      'session-share-revoked',
      (sessionId: string) => ({
        t: 'session-share-revoked' as const,
        sessionId,
        shareId: 'voice-history-share',
      }),
    ],
  ])('does not restore a deleted Voice History carrier from an older in-flight session snapshot after %s', async (
    updateKind,
    buildUpdateBody,
  ) => {
    connectWithoutForegroundResume();
    stubSnapshotRefreshFetch();

    const sessionId = `voice-history-carrier-deleted-during-snapshot-${updateKind}`;
    const ownerMetadata = {
      path: '/tmp/voice-history',
      host: 'test-host',
      systemSessionV1: {
        v: 1,
        key: 'voice_transcript_history',
        hidden: true,
      },
    } as const;
    const existingCarrier = {
      id: sessionId,
      serverId: getActiveServerSnapshot().serverId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      encryptionMode: 'plain',
      metadata: ownerMetadata,
      metadataVersion: 1,
      agentState: {},
      agentStateVersion: 1,
      thinking: false,
      thinkingAt: 0,
      presence: 2,
    } satisfies Session;
    storage.getState().applySessions([existingCarrier]);

    let releaseSnapshot!: () => void;
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const staleListRow = currentOwnerSessionWireRow({
      id: sessionId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify(ownerMetadata),
      metadataVersion: 1,
      agentState: JSON.stringify({}),
      agentStateVersion: 1,
      dataEncryptionKey: null,
      share: null,
    });
    let activeSnapshotCalls = 0;
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path.startsWith('/v2/sessions/active')) {
        const snapshotCall = ++activeSnapshotCalls;
        if (snapshotCall === 1) {
          await snapshotReleased;
        }
        return new Response(JSON.stringify({
          sessions: snapshotCall === 1 ? [staleListRow] : [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path.startsWith('/v2/sessions?')) {
        return new Response(JSON.stringify({
          sessions: [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const snapshotFetch = (sync as any).fetchSessions({ awaitSessionListHydration: true });
    onTestFinished(async () => { releaseSnapshot(); await snapshotFetch; });
    await expect.poll(() => apiSocketRequestMock.mock.calls.some(([path]) => (
      path.startsWith('/v2/sessions/active')
    ))).toBe(true);

    await (sync as any).handleUpdate({
      id: `delete-voice-history-carrier-during-snapshot-${updateKind}`,
      seq: 10,
      createdAt: 10,
      body: buildUpdateBody(sessionId),
    });
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toBeUndefined();

    releaseSnapshot();
    await snapshotFetch;
    await (sync as any).sessionsSync.awaitQueue();
    // Retirement fences this Home's row, even when the read already carried it.
    // A second list request is incidental; absence after the stale response is
    // the observable contract.
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toBeUndefined();
  });

  it('does not restore a Voice History carrier from an older session snapshot when exact hydration reports it absent', async () => {
    connectWithoutForegroundResume();
    stubSnapshotRefreshFetch();

    const sessionId = 'voice-history-carrier-absent-during-snapshot';
    const ownerMetadata = {
      path: '/tmp/voice-history',
      host: 'test-host',
      systemSessionV1: {
        v: 1,
        key: 'voice_transcript_history',
        hidden: true,
      },
    } as const;
    storage.getState().applySessions([{
      id: sessionId,
      serverId: getActiveServerSnapshot().serverId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      encryptionMode: 'plain',
      metadata: ownerMetadata,
      metadataVersion: 1,
      agentState: {},
      agentStateVersion: 1,
      thinking: false,
      thinkingAt: 0,
      presence: 2,
    } satisfies Session]);

    let releaseOlderSnapshot!: () => void;
    const olderSnapshotReleased = new Promise<void>((resolve) => {
      releaseOlderSnapshot = resolve;
    });
    const staleListRow = currentOwnerSessionWireRow({
      id: sessionId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify(ownerMetadata),
      metadataVersion: 1,
      agentState: JSON.stringify({}),
      agentStateVersion: 1,
      dataEncryptionKey: null,
      share: null,
    });
    let activeSnapshotCalls = 0;
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path.startsWith('/v2/sessions/active')) {
        const snapshotCall = ++activeSnapshotCalls;
        if (snapshotCall === 1) {
          await olderSnapshotReleased;
        }
        return new Response(JSON.stringify({
          sessions: snapshotCall === 1 ? [staleListRow] : [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (new URL(path, 'http://localhost').pathname === `/v2/sessions/${sessionId}`) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path.startsWith('/v2/sessions?')) {
        return new Response(JSON.stringify({
          sessions: [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const originalSyncTuning = (sync as any).syncTuning;
    (sync as any).syncTuning = {
      ...originalSyncTuning,
      // The stale list response is the thing under test. Do not let optional
      // list hydration issue a second exact read that masks its resurrection.
      sessionListEagerHydrationCount: 0,
      sessionListBackgroundHydrationMaxRows: 0,
    };
    onTestFinished(() => {
      (sync as any).syncTuning = originalSyncTuning;
    });

    const olderSnapshot = (sync as any).fetchSessions();
    try {
      await expect.poll(() => activeSnapshotCalls).toBe(1);

      const exactHydration = await sync.ensureSessionVisibleForMessageRoute(sessionId, {
        forceRefresh: true,
        hydrateMessages: false,
      });
      expect(exactHydration).toMatchObject({ kind: 'missing', cause: 'not_found' });
      expect(apiSocketRequestMock.mock.calls.some(([path]) => (
        new URL(path, 'http://localhost').pathname === `/v2/sessions/${sessionId}`
      ))).toBe(true);
      // The unresolved-owner transcript path retires only after this exact
      // owner proves absence, through this same public local retirement owner.
      sync.retireLocalSession(sessionId, exactHydration.serverId);

      expect(storage.getState().sessions[sessionId]).toBeUndefined();
      expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toBeUndefined();
    } finally {
      // Release before Account disposal, including when an assertion fails.
      releaseOlderSnapshot();
      await olderSnapshot;
    }
    await (sync as any).sessionsSync.awaitQueue({ timeoutMs: 2_000 });

    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toBeUndefined();
  });

  it('keeps cold hidden Voice attention rows as list projections until demanded when attention placement is off', async () => {
    storage.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        sessionListAttentionPromotionModeV1: 'off',
      },
    }), true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/sessions')) {
        const sessions = url.includes('includeAttention=true')
          ? [
              {
                id: 'cold-hidden-voice-permission',
                seq: 2,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                archivedAt: null,
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                  path: '/tmp/cold-hidden-voice-permission',
                  host: 'test-host',
                  systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
                }),
                metadataVersion: 1,
                agentState: JSON.stringify({
                  requests: {
                    approve: {
                      tool: 'Bash',
                      kind: 'permission',
                      arguments: { command: 'git status' },
                      createdAt: 10,
                    },
                  },
                }),
                agentStateVersion: 1,
                dataEncryptionKey: null,
                share: null,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: 10,
                lastViewedSessionSeq: 2,
                latestReadyEventSeq: 2,
              },
              {
                id: 'cold-hidden-voice-late-result',
                seq: 4,
                createdAt: 1,
                updatedAt: 20,
                active: false,
                activeAt: 20,
                archivedAt: null,
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                  path: '/tmp/cold-hidden-voice-late-result',
                  host: 'test-host',
                  systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
                }),
                metadataVersion: 1,
                agentState: JSON.stringify({}),
                agentStateVersion: 1,
                dataEncryptionKey: null,
                share: null,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                lastViewedSessionSeq: 2,
                latestReadyEventSeq: 4,
                latestReadyEventAt: 20,
              },
            ]
          : [];
        return new Response(
          JSON.stringify({ sessions, nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    await (sync as any).fetchSessions();

    const initialSessionsRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/sessions?'));
    expect(initialSessionsRequest).toContain('includeAttention=true');
    expect(Object.keys(storage.getState().sessions).filter((sessionId) => (
      sessionId.startsWith('cold-hidden-voice-')
    )).sort()).toEqual([]);
    const rows = storage.getState().sessionListRowsByServerId[getActiveServerSnapshot().serverId];
    expect(rows['cold-hidden-voice-permission']).toMatchObject({
      hasPendingPermissionRequests: true,
      metadata: { hiddenSystemSession: true },
    });
    expect(rows['cold-hidden-voice-late-result']).toMatchObject({
      latestReadyEventSeq: 4,
      lastViewedSessionSeq: 2,
    });
  });

  it('resumes the bounded ordinary attention frontier through fetchMoreSessions without restarting page one', async () => {
    const attentionCursors: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/session-organization')) {
        return new Response(JSON.stringify({
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
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v2/sessions/active')) {
        return new Response(JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/sessions')) {
        const parsed = new URL(url, 'http://localhost');
        const attentionCursor = parsed.searchParams.get('attentionCursor');
        if (!attentionCursor) {
          return new Response(JSON.stringify({
            sessions: [],
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: 'attention-1',
            attentionHasNext: true,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        attentionCursors.push(attentionCursor);
        const page = Number(attentionCursor.split('-')[1]);
        const terminal = page === 2;
        return new Response(JSON.stringify({
          sessions: terminal ? [{
            id: 'attention-page-2',
            seq: 1,
            createdAt: 1,
            updatedAt: 101,
            active: true,
            activeAt: 101,
            archivedAt: null,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/tmp/attention-page-101', host: 'test-host' }),
            metadataVersion: 1,
            agentState: JSON.stringify({}),
            agentStateVersion: 1,
            dataEncryptionKey: null,
            share: null,
          }] : [],
          nextCursor: null,
          hasNext: false,
          attentionNextCursor: terminal ? null : `attention-${page + 1}`,
          attentionHasNext: !terminal,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    await (sync as any).fetchSessions();

    expect(attentionCursors).toEqual([]);
    expect(sync.readOrdinarySessionListLifecycle().frontier).toMatchObject({ attentionNextCursor: 'attention-1', attentionHasNext: true });
    expect(sync.readOrdinarySessionListCoverage().coverage).toBe('incomplete');
    expect(storage.getState().concurrentSessionListCacheByServerId[getActiveServerSnapshot().serverId!]?.listObservation?.phase)
      .not.toBe('ready');

    await sync.fetchMoreSessions();

    expect(attentionCursors).toEqual(['attention-1']);
    expect(sync.readOrdinarySessionListLifecycle().frontier).toMatchObject({ attentionNextCursor: 'attention-2', attentionHasNext: true });
    expect(sync.readOrdinarySessionListCoverage().coverage).toBe('incomplete');

    await sync.fetchMoreSessions();

    expect(attentionCursors).toEqual(['attention-1', 'attention-2']);
    expect(storage.getState().sessionListRowsByServerId[getActiveServerSnapshot().serverId!]?.['attention-page-2'])
      .toBeDefined();
    expect(sync.readOrdinarySessionListCoverage().coverage).toBe('complete');
  });

  it('does not prefetch session folder assignments for every session snapshot page', async () => {

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({
            sessions: [{
              id: 'snapshot-session',
              seq: 1,
              createdAt: 1,
              updatedAt: 1,
              active: true,
              activeAt: 1,
              archivedAt: null,
              metadata: 'metadata-snapshot-session',
              metadataVersion: 1,
              agentState: null,
              agentStateVersion: 0,
              dataEncryptionKey: null,
              share: null,
            }],
            nextCursor: null,
            hasNext: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    await (sync as any).fetchSessions();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(fetchMock.mock.calls.some((call) => {
      const input = call[0];
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      return url.includes('/v2/session-folder-assignments');
    })).toBe(false);
  });

  it('hydrates a required changed session by id when the bounded session snapshot omits it', async () => {
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (new URL(path, 'http://localhost').pathname === '/v2/sessions/s_required_changed') {
        return new Response(JSON.stringify({
          session: currentOwnerSessionWireRow({
            id: 's_required_changed',
            createdAt: 1,
            updatedAt: 35,
            seq: 7,
            active: false,
            activeAt: 34,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ path: '/workspace', host: 'localhost' }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: false }),
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 35,
            runtimeActivityRevision: 35,
            share: null,
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return snapshotRefreshFetch(path);
    });

    await (sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_required_changed'],
      prioritizeSessionIds: ['s_required_changed'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    });

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_required_changed?accessProjectionVersion=1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_required_changed).toEqual(expect.objectContaining({
      id: 's_required_changed',
      active: false,
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      runtimeActivityRevision: 35,
    }));
  });

  it('retires a required changed session when exact hydration proves it was deleted', async () => {
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_deleted_while_offline: {
          id: 's_deleted_while_offline',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (new URL(path, 'http://localhost').pathname === '/v2/sessions/s_deleted_while_offline') {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return snapshotRefreshFetch(path);
    });

    await (sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_deleted_while_offline'],
      prioritizeSessionIds: ['s_deleted_while_offline'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    });

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_deleted_while_offline?accessProjectionVersion=1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_deleted_while_offline).toBeUndefined();
  });

  it.each([
    [403, 'team_authentication_required'],
    [503, 'team_authentication_unavailable'],
  ] as const)('settles a required changed Team Session refused by Team authentication (%s) without failing catch-up', async (status, error) => {
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_team_auth: {
          id: 's_team_auth',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (new URL(path, 'http://localhost').pathname === '/v2/sessions/s_team_auth') {
        return new Response(JSON.stringify({ error }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return snapshotRefreshFetch(path);
    });

    // The Team refuses this credential for this Session only. Catch-up settles
    // it (the Account cursor can advance) and keeps the retained row; it is
    // neither an Account sign-out nor proof of deletion.
    await (sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_team_auth'],
      prioritizeSessionIds: ['s_team_auth'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    });

    expect(storage.getState().sessions.s_team_auth).toEqual(expect.objectContaining({ id: 's_team_auth' }));
  });

  it('keeps a required changed session when exact hydration receives an unparseable 404', async () => {
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_compatibility_404: {
          id: 's_compatibility_404',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (new URL(path, 'http://localhost').pathname === '/v2/sessions/s_compatibility_404') {
        return new Response('Not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return snapshotRefreshFetch(path);
    });

    await expect((sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_compatibility_404'],
      prioritizeSessionIds: ['s_compatibility_404'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    })).rejects.toThrow('Required session shell hydration failed for s_compatibility_404: invalid_response');

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_compatibility_404?accessProjectionVersion=1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_compatibility_404).toEqual(expect.objectContaining({
      id: 's_compatibility_404',
    }));
  });

  it('keeps a required changed session when a current-text hydration 404 carries route metadata', async () => {
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_current_text_extra_404: {
          id: 's_current_text_extra_404',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (new URL(path, 'http://localhost').pathname === '/v2/sessions/s_current_text_extra_404') {
        return new Response(JSON.stringify({
          error: 'Session not found',
          path: '/v2/sessions/s_current_text_extra_404',
          method: 'GET',
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return snapshotRefreshFetch(path);
    });

    const hydrationError = await (sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_current_text_extra_404'],
      prioritizeSessionIds: ['s_current_text_extra_404'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_current_text_extra_404?accessProjectionVersion=1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_current_text_extra_404).toEqual(expect.objectContaining({
      id: 's_current_text_extra_404',
    }));
    expect(hydrationError).toBeInstanceOf(Error);
    expect(hydrationError).toMatchObject({
      message: 'Required session shell hydration failed for s_current_text_extra_404: invalid_response',
    });
  });

  it('waits for settings before bootstrapping sessions so pinned ids are available on first load', async () => {
    const events: string[] = [];
    let releaseSettings!: () => void;
    let markSettingsStarted!: () => void;
    const settingsStarted = new Promise<void>(resolve => { markSettingsStarted = resolve; });
    const settingsReleased = new Promise<void>(resolve => { releaseSettings = resolve; });
    apiSocketRequestMock.mockImplementation(async path => {
      const pathname = new URL(path, 'http://localhost').pathname;
      if (pathname === '/v2/account/settings') {
        events.push('settings:start');
        markSettingsStarted();
        await settingsReleased;
        events.push('settings:end');
        return defaultHomeResponse(pathname);
      }
      if (pathname === '/v2/sessions') events.push('sessions:request');
      return defaultHomeResponse(pathname);
    });
    const restoredHome = restoreTestHome();
    try {
      await settingsStarted;
      expect(events).not.toContain('sessions:request');
    } finally {
      releaseSettings();
    }
    await restoredHome;
    expect(events).toContain('sessions:request');
    expect(events.indexOf('settings:end')).toBeLessThan(events.indexOf('sessions:request'));
  });

  it('loads session organization before the initial session bootstrap request', async () => {
    const serverUrl = 'http://localhost:53289';
    await restoreTestHome(serverUrl, 'srv_test_identity');
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(activeServerId).toBe('srv_test_identity');

    const organizationSnapshot: SessionOrganizationSnapshot = {
      schemaVersion: 1,
      version: 1,
      pins: [
        { sessionId: 's_organization_pin', sortKey: '0001', pinnedAt: 1, listPinned: true, railPinned: false },
        { sessionId: 's_identity_pin', sortKey: '0002', pinnedAt: 2, listPinned: true, railPinned: false },
        { sessionId: 's_unscoped_pin', sortKey: '0003', pinnedAt: 3, listPinned: true, railPinned: false },
      ],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    };
    storage.getState().applySessionOrganizationSnapshot('other-server', {
      ...organizationSnapshot,
      pins: [{ sessionId: 's_other_pin', sortKey: '0001', pinnedAt: 1, listPinned: true, railPinned: false }],
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/session-organization')) {
        return new Response(JSON.stringify({ snapshot: organizationSnapshot }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    apiSocketRequestMock.mockImplementation(async (path) => {
      if (
        path.startsWith('/v2/sessions/')
        && !path.startsWith('/v2/sessions/active')
      ) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return fetchMock(path);
    });

    await (sync as any).fetchSessions();

    const initialSessionsRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/sessions'));
    const organizationSnapshotRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/session-organization'));
    expect(initialSessionsRequest).toBeDefined();
    expect(initialSessionsRequest).not.toContain('pinnedSessionIds=');
    expect(organizationSnapshotRequest).toBeDefined();
    expect(organizationSnapshotRequest).toContain('includeAllFolderAssignments=true');
    expect(organizationSnapshotRequest).toContain('includeAllTagAssignments=true');
    // The band the list paints on first frame includes sessions the user asked to keep in it, so
    // the list's own organization fetch has to ask for standings; the server omits them otherwise.
    expect(organizationSnapshotRequest).toContain('includeAttentionStandings=true');
  });

  it('marks server-backed pinned rows as required hydration during session list fetches', async () => {
    const serverUrl = 'http://localhost:53291';
    await restoreTestHome(serverUrl, 'srv_required_pin_hydration');
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(activeServerId).toBe('srv_required_pin_hydration');

    storage.getState().applySessionOrganizationSnapshot(activeServerId, {
      schemaVersion: 1,
      version: 7,
      pins: [{ sessionId: 'server-pinned-session', sortKey: 'rank-a', pinnedAt: 1, listPinned: true, railPinned: false }],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/session-organization')) {
        return new Response(
          JSON.stringify({
            snapshot: {
              schemaVersion: 1,
              version: 7,
              pins: [{ sessionId: 'server-pinned-session', sortKey: 'rank-a', pinnedAt: 1, listPinned: true, railPinned: false }],
              folders: [],
              folderAssignments: [],
              tags: [{
                tagId: 'tag-important',
                tagKey: 'opaque-tag-important',
                sortKey: null,
                display: { t: 'plain', v: { label: 'Important' } },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 1,
              }],
              tagAssignments: [{ sessionId: 'server-pinned-session', tagIds: ['tag-important'] }],
              orderEntries: [],
              labels: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/sessions')) {
        expect(url.includes('pinnedSessionIds')).toBe(false);
        return new Response(
          JSON.stringify({
            sessions: [{
              id: 'server-pinned-session',
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: false,
              activeAt: 1,
              archivedAt: null,
              encryptionMode: 'plain',
              metadata: JSON.stringify({ path: '/pinned', host: 'host' }),
              metadataVersion: 2,
              agentState: null,
              agentStateVersion: 0,
              dataEncryptionKey: null,
              share: null,
            }],
            nextCursor: null,
            hasNext: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    const originalSyncTuning = (sync as any).syncTuning;
    (sync as any).syncTuning = {
      ...loadSyncTuning(),
      sessionListEagerHydrationCount: 0,
      sessionListBackgroundHydrationMaxRows: 0,
    };
    syncPerformanceTelemetry.configure({
      enabled: true,
      slowThresholdMs: 1_000_000,
      flushIntervalMs: 60_000,
    });
    syncPerformanceTelemetry.reset();

    try {
      await (sync as any).fetchSessions();
    } finally {
      (sync as any).syncTuning = originalSyncTuning;
    }

    expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey(activeServerId, 'server-pinned-session')]?.sortKey).toBe('rank-a');
    const priorityEvent = syncPerformanceTelemetry.snapshot().events.find(
      (event) => event.name === 'sync.sessions.snapshot.hydrationPriority',
    );
    expect(priorityEvent?.fields).toEqual(expect.objectContaining({
      required: 1,
      priority: 0,
      skippedBackground: 0,
    }));
  });

  it('continues clean session bootstrap when optional session organization route is unavailable', async () => {
    const serverUrl = 'http://localhost:53290';
    await restoreTestHome(serverUrl, 'srv_session_org_unavailable');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/session-organization')) {
        return new Response(JSON.stringify({ error: 'Not found', path: '/v2/session-organization' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    await (sync as any).fetchSessions();

    const requestedUrls = fetchMock.mock.calls.map((call) => {
      const input = call[0];
      return typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
    });
    expect(requestedUrls.some((url) => url.includes('/v2/session-organization'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/v2/sessions'))).toBe(true);
  });

  it('reports a failed Machine refresh to its retry owner and accepts the next authoritative inventory', async () => {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const failure = new Error('Machine inventory temporarily unavailable');
    let failed = false;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      if (pathname === '/v1/machines' && !failed) {
        failed = true;
        throw failure;
      }
      return defaultHomeResponse(pathname, init);
    });

    await expect(sync.refreshMachines()).rejects.toBe(failure);
    expect(storage.getState().machineListStatusByServerId[activeServerId]).toBe('error');
    await expect(sync.refreshMachines()).resolves.toBeUndefined();
    expect(storage.getState().machineListByServerId[activeServerId]).toEqual([]);
    expect(storage.getState().machineListStatusByServerId[activeServerId]).toBe('idle');
  }, 60_000);

  it.each(['transport', 'http'] as const)('reports a failed native update %s read to its retry owner and preserves the last known status', async (kind) => {
    const { default: Constants } = await import('expo-constants');
    const previousConfig = Constants.expoConfig;
    Constants.expoConfig = { ...previousConfig, name: 'test', slug: 'test', version: '1.0.0', ios: { bundleIdentifier: 'test.app' } };
    platformOS.current = 'ios';
    onTestFinished(() => { Constants.expoConfig = previousConfig; });
    storage.getState().applyNativeUpdateStatus({ available: true, updateUrl: 'https://example.test/update' });
    const failure = new TypeError('Failed to fetch');
    apiSocketRequestMock.mockImplementationOnce(async () => {
      if (kind === 'transport') throw failure;
      return new Response('', { status: 503 });
    });
    const runtime = sync as unknown as { fetchNativeUpdate: () => Promise<void> };

    await expect(runtime.fetchNativeUpdate()).rejects.toThrow();
    expect(storage.getState().nativeUpdateStatus).toEqual({ available: true, updateUrl: 'https://example.test/update' });
    apiSocketRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ update_required: false }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(runtime.fetchNativeUpdate()).resolves.toBeUndefined();
    expect(storage.getState().nativeUpdateStatus).toEqual({ available: false });
  }, 60_000);

  it.each([false, true])('keeps the Session list ready while organization fails and recovers (cached=%s)', async (cached) => {
    const serverId = getActiveServerSnapshot().serverId;
    const fetchMock = stubSnapshotRefreshFetch();
    const failure = new TypeError('Failed to fetch');
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: 'ordinary-organization', metadata: { path: '/organization', host: 'fixture' } });
    let organizationUnavailable = true;
    let organizationReads = 0;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const target = new URL(path, 'http://localhost');
      if (target.pathname === '/v2/session-organization') {
        organizationReads += 1;
        if (organizationUnavailable) throw failure;
      }
      if (target.pathname === '/v2/sessions') return Response.json({
        sessions: [{ ...row, id: target.searchParams.has('cursor') ? 'next-organization' : row.id }],
        nextCursor: target.searchParams.has('cursor') ? null : 'organization-next',
        hasNext: !target.searchParams.has('cursor'),
      });
      return fetchMock(path, init);
    });
    if (cached) storage.setState({ sessionOrganizationSnapshotVersionByServerId: { [serverId]: 0 } });

    crashReports.captureExceptionIfEnabled.mockClear();
    await expect(sync.refreshSessions({ awaitSessionListHydration: true })).resolves.toBeDefined();
    expect(organizationReads).toBeGreaterThan(0);
    // The additive organization failure stays observable without failing the list.
    expect(crashReports.captureExceptionIfEnabled).toHaveBeenCalledWith(failure, expect.objectContaining({
      tags: expect.objectContaining({ operation: 'session_organization_snapshot_refresh' }),
    }));
    expect(storage.getState().sessionListRowsByServerId[serverId][row.id]).toMatchObject({ id: row.id });
    expect(sync.readOrdinarySessionListFrontier()).toMatchObject({ hasNext: true, nextCursor: 'organization-next' });
    const readsBeforeAppend = organizationReads;
    await sync.fetchMoreSessions();
    expect(organizationReads).toBe(readsBeforeAppend);
    expect(storage.getState().sessionListRowsByServerId[serverId]['next-organization']).toMatchObject({ id: 'next-organization' });
    expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('ready');
    organizationUnavailable = false;
    crashReports.captureExceptionIfEnabled.mockClear();
    await expect(sync.refreshSessions({ awaitSessionListHydration: true })).resolves.toBeDefined();
    expect(organizationReads).toBeGreaterThan(readsBeforeAppend);
    expect(crashReports.captureExceptionIfEnabled.mock.calls.filter(([, context]) =>
      context?.tags?.operation === 'session_organization_snapshot_refresh')).toEqual([]);
  }, 60_000);

  it('does no fleet warm-display projection before an exact Machine refresh', async () => {
    const fleet = Array.from({ length: 137 }, (_, index) => createPlainMachineRowFixture({
      id: `warm-cost-${index}`, accountId: 'test',
    }));
    let available = fleet;
    const reads: string[] = [];
    let measuringPreparation = false;
    let preparedEntries = 0;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      if (pathname === '/v1/machines' || pathname === '/v1/machines/read-batch') {
        measuringPreparation = false;
        reads.push(pathname);
        return pathname === '/v1/machines'
          ? Response.json(available)
          : createMachineReadBatchResponseFixture(String(init?.body), id => available.find(row => row.id === id) ?? null);
      }
      return defaultHomeResponse(pathname, init);
    });
    await sync.refreshMachines();
    const untouched = storage.getState().machines['warm-cost-136'];
    const displays = storage.getState().machineDisplayById;
    // Observe the real producer's record without replacing its row identities.
    // Preparation ends at the HTTP boundary, before response reconciliation.
    storage.setState({ machineDisplayById: new Proxy(displays, {
      get(target, key, receiver) {
        if (measuringPreparation && typeof key === 'string' && Object.hasOwn(target, key)) preparedEntries++;
        return Reflect.get(target, key, receiver);
      },
    }) });
    reads.length = 0;
    available = fleet.map(row => row.id === 'warm-cost-0'
      ? createPlainMachineRowFixture({ id: row.id, accountId: 'test', machine: createMachineFixture({
        id: row.id, metadataVersion: row.metadataVersion + 1,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Changed Machine' },
      }) }) : row);
    measuringPreparation = true;
    await sync['fetchMachines'](['warm-cost-0']);
    expect(preparedEntries).toBe(0);
    expect(reads).toEqual(['/v1/machines/read-batch']);
    expect(storage.getState().machines['warm-cost-0']?.metadata?.displayName).toBe('Changed Machine');
    expect(storage.getState().machines['warm-cost-136']).toBe(untouched);
  }, 60_000);

  it('replaces the active machine snapshot so an empty account list clears stale machines', async () => {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const staleMachine: Machine = {
      id: 'machine-stale',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { host: 'stale', platform: 'darwin', happyCliVersion: 'test', happyHomeDir: '/stale/.happier', homeDir: '/stale' },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 0,
      revokedAt: null,
    };

    storage.setState((state) => ({
      ...state,
      isDataReady: true,
      machines: { [staleMachine.id]: staleMachine },
      machineDisplayById: { [staleMachine.id]: staleMachine },
      machineListByServerId: { [activeServerId]: [staleMachine] },
      machineListStatusByServerId: { [activeServerId]: 'idle' },
    }), true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v1/machines')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    await (sync as any).fetchMachines();

    expect(storage.getState().machines).toEqual({});
    expect(storage.getState().machineDisplayById).toEqual({});
    expect(storage.getState().machineListByServerId[activeServerId]).toEqual([]);
  }, 60_000);

  it('reads committed inactive Machine presence on reconnect after its offline push was lost', async () => {
    const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
    const { resolveMachinePickerPresence } = await import('@/sync/domains/machines/identity/resolveMachinePickerPresence');
    const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
    const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'test' };
    const lastSeen = Date.now();
    const original = createMachineFixture({ id: 'restart-recovery-machine', active: true, activeAt: lastSeen, updatedAt: lastSeen });
    const recoveryReadEntered = createDeferred<void>();
    const releaseRecoveryRead = createDeferred<void>();
    let active = true;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      if (pathname !== '/v1/machines') return defaultHomeResponse(pathname, init);
      if (!active) {
        recoveryReadEntered.resolve();
        await releaseRecoveryRead.promise;
      }
      return Response.json([createPlainMachineRowFixture({ id: original.id, accountId: scope.accountId,
        machine: { ...original, active } })]);
    });
    const readMachine = () => {
      const machine = resolveServerScopedMachine(storage.getState(), scope.serverId, original.id);
      if (!machine) throw new Error('Expected the HTTP-admitted Machine');
      return machine;
    };

    emitSocketStatus('connected');
    await sync.refreshMachines();
    expect(readMachine()).toMatchObject({ active: true, activeAt: lastSeen, updatedAt: lastSeen });
    expect(resolveMachinePickerPresence(readMachine(), lastSeen, scope).status).toBe('online');

    // Model the server's committed expiry and restart with no offline packet.
    // Only Date is virtual; the real socket, HTTP reader, reducer and store run.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      emitSocketStatus('disconnected');
      active = false;
      vi.setSystemTime(lastSeen + 60_001);
      expect(resolveMachinePickerPresence(readMachine(), Date.now(), scope).status).toBe('unknown');
      emitSocketStatus('connected');
      await recoveryReadEntered.promise;
      expect(readMachine().active).toBe(true);
      expect(resolveMachinePickerPresence(readMachine(), Date.now(), scope).status).toBe('unknown');

      releaseRecoveryRead.resolve();
      await waitForHomeGovernance(() => expect(readMachine().active).toBe(false));
      expect(readMachine()).toMatchObject({ activeAt: lastSeen, updatedAt: lastSeen });
      expect(readMachineActivity(readMachine())).toMatchObject({ active: false, activeAt: lastSeen });
      expect(storage.getState().machinePresenceByServerId[scope.serverId][original.id]).toMatchObject({ active: false, activeAt: lastSeen });
      expect(resolveMachinePickerPresence(readMachine(), Date.now(), scope).status).toBe('offline');
    } finally {
      releaseRecoveryRead.resolve();
      vi.useRealTimers();
    }
  }, 60_000);

  it('re-enqueues a visible transcript whose first read failed when snapshot refresh resumes', async () => {
    const sessionId = 'visible-never-loaded';
    const fetchMock = stubSnapshotRefreshFetch();
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      if (pathname === '/v2/sessions') return Response.json({ sessions: hostedSessionRows(), nextCursor: null, hasNext: false });
      if (pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
      if (String(path).includes(`/v1/sessions/${sessionId}/messages`)) {
        return new Response(JSON.stringify({ messages: [], hasMore: false, nextBeforeSeq: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return fetchMock(path, init);
    });
    storage.setState((state) => ({
      ...state,
      profile: { ...(state.profile ?? {}), id: 'test-account' } as any,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          id: sessionId,
          seq: 1,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    storage.getState().setSessionTranscriptLoadIssue(sessionId, {
      kind: 'read_failed',
      errorCode: 'network_error',
    });
    markSessionSurfaceVisible(sessionId);

    await (sync as any).snapshotRefreshOnResume({ mode: 'fallback', reason: 'test' });

    expect(apiSocketRequestMock.mock.calls.some(([path]) => String(path).includes(`/v1/sessions/${sessionId}/messages`))).toBe(true);
    expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
    expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toBeNull();
  }, 60_000);

  it('captures a fresh snapshot-base cursor before cursor-gone snapshot repair', async () => {
    fetchChangesMock
      .mockResolvedValueOnce(changesResponse({ status: 'cursor-gone', currentCursor: '9' }))
      .mockResolvedValueOnce(changesResponse({ status: 'ok', changes: [], nextCursor: '12' }));
    fetchCurrentChangesCursorMock.mockResolvedValue(cursorResponse({ status: 'ok', cursor: '12' }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url: string =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : 'url' in input
              ? String(input.url)
              : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/machines')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/artifacts')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/feed')) {
        return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/account/profile')) {
        return new Response(JSON.stringify({ ...profileDefaults, id: 'test-account' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'stale-profile-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    // Exercise cursor-gone recovery, rather than first repairing a missing cursor.
    Reflect.set(sync, 'changesCursor', '8');
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    // The snapshot contract is a fresh cursor after cursor-gone and before the
    // replacement Session list, independent of other owners' frontier reads.
    const cursorGoneCallOrder = fetchChangesMock.mock.invocationCallOrder[0]!;
    const repairCursorOrder = fetchCurrentChangesCursorMock.mock.invocationCallOrder.find(order => order > cursorGoneCallOrder);
    expect(repairCursorOrder).toBeDefined();
    // A background list read may overlap reconnect; observe the repair's list.
    expect(fetchMock.mock.calls.some(([input], index) =>
      new URL(String(input), 'http://localhost').pathname === '/v2/sessions'
      && fetchMock.mock.invocationCallOrder[index]! > repairCursorOrder!,
    )).toBe(true);
    const serverScope = getActiveServerSnapshot().serverId;
    const instanceId = (Reflect.get(sync, 'webSyncClientIdentity') as WebSyncClientIdentity | null)?.instanceId;
    expect(loadChangesCursor({ serverScope, accountId: 'test', instanceId })).toBe('12');
    expect(loadChangesCursor({ serverScope, accountId: 'test-account', instanceId })).toBeNull();
  }, 60_000);

  it('persists snapshot-base cursor fetch failure telemetry when cursor-gone repair cannot capture /v2/cursor', async () => {
    fetchChangesMock.mockResolvedValueOnce(changesResponse({ status: 'cursor-gone', currentCursor: '9' }));
    fetchCurrentChangesCursorMock.mockResolvedValue(cursorResponse({ status: 'error' }));
    stubSnapshotRefreshFetch();

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(syncReliabilityTelemetry.snapshot().persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sync.cursor.snapshotBaseFetchFailed',
          fields: expect.objectContaining({
            trigger: 'cursor-gone',
            fallbackCursor: '9',
            error: 'status:error',
          }),
        }),
      ]),
    );
  }, 60_000);

  it('persists cursor contract anomaly telemetry when /v2/changes repeats the requested after cursor', async () => {
    fetchChangesMock.mockResolvedValueOnce(changesResponse({
      status: 'ok' as const,
      changes: [
        { cursor: 10, kind: 'session' as const, entityId: 's0', changedAt: 1 },
        { cursor: 11, kind: 'session' as const, entityId: 's1', changedAt: 1 },
      ],
      nextCursor: '11',
    }));
    stubSnapshotRefreshFetch();

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).changesCursor = '10';
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(syncReliabilityTelemetry.snapshot().persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sync.cursor.contractAnomaly',
          fields: expect.objectContaining({
            reason: 'returned-after-cursor',
            afterCursor: '10',
            offendingCursor: '10',
            nextCursor: '11',
          }),
        }),
      ]),
    );
  }, 60_000);

  it('persists web reconnect cursors under the current tab instance scope only', async () => {
    const sessionStorage = new MemoryWebStorage();
    const localStorage = new MemoryWebStorage();
    sessionStorage.setItem('happier-sync-instance-id-v1', 'copied-tab');
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('localStorage', localStorage);
    await restoreTestHome();

    fetchChangesMock
      .mockResolvedValueOnce(changesResponse({ status: 'cursor-gone', currentCursor: '9' }))
      .mockResolvedValueOnce(changesResponse({ status: 'ok', changes: [], nextCursor: '12' }));
    fetchCurrentChangesCursorMock.mockResolvedValue(cursorResponse({ status: 'ok', cursor: '12' }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url: string =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : 'url' in input
              ? String(input.url)
              : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/machines')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/artifacts')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/feed')) {
        return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/account/profile')) {
        return new Response(JSON.stringify({ ...profileDefaults, id: 'test-account' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const instanceId = (Reflect.get(sync, 'webSyncClientIdentity') as WebSyncClientIdentity).instanceId;
    expect(instanceId).not.toBe('copied-tab');
    expect({
      instanceCursor: loadChangesCursor({ serverScope: activeServerId, accountId: 'test', instanceId }),
      staleProfileCursor: loadChangesCursor({ serverScope: activeServerId, accountId: 'test-account', instanceId }),
    }).toMatchObject({
      instanceCursor: '12',
      staleProfileCursor: null,
    });
  }, 60_000);

  it('persists direct-session tail cursors under the current tab instance scope', async () => {
    const sessionStorage = new MemoryWebStorage();
    const localStorage = new MemoryWebStorage();
    sessionStorage.setItem('happier-sync-instance-id-v1', 'copied-tab');
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('localStorage', localStorage);
    await restoreTestHome();

    storage.setState((state) => ({
      ...state,
      profile: { ...(state.profile ?? {}), id: 'test-account' } as any,
      sessions: {
        ...state.sessions,
        s1: {
          id: 's1',
          serverId: getActiveServerSnapshot().serverId,
          currentStorageState: 'machine_only',
          metadata: {
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'm1',
              remoteSessionId: 'remote-1',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        } as any,
      },
    }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });

    const tailCursor = 'happier_external_cursor_v1:dGFpbC0y';
    await (sync as any).applyExternalSessionTranscriptItems('s1', [], { nextCursor: tailCursor });

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const instanceId = (Reflect.get(sync, 'webSyncClientIdentity') as WebSyncClientIdentity).instanceId;
    expect(instanceId).not.toBe('copied-tab');
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test', instanceId })).toBe(tailCursor);
  });

  it('catches up loaded direct sessions on resume even when the account changes feed is empty', async () => {
    fetchChangesMock.mockResolvedValue(changesResponse({
      status: 'ok' as const,
      changes: [],
      nextCursor: '0',
    }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url: string =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : 'url' in input
              ? String(input.url)
              : input.toString();
      if (url.includes('/v1/purchases')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/push-token')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/native-update')) {
        return new Response(JSON.stringify({ updateAvailable: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return defaultHomeResponse(new URL(url, 'http://localhost').pathname);
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    storage.setState((state) => ({
      ...state,
      profile: { ...(state.profile ?? {}), id: 'test-account' } as any,
      sessions: {
        ...state.sessions,
        s1: {
          id: 's1',
          serverId: getActiveServerSnapshot().serverId,
          currentStorageState: 'machine_only',
          metadata: {
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'm1',
              remoteSessionId: 'remote-1',
              linkedAtMs: 1,
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        } as any,
      },
    }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    storage.getState().applyMessagesLoaded('s1');
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    const machine = createMachineFixture({ id: 'm1', storageMode: 'plain', activeAt: Date.now() });
    const responder = apiSocketRequestMock.getMockImplementation()!;
    apiSocketRequestMock.mockImplementation(async (path, init) => {
      if (new URL(path, 'http://localhost').pathname === '/v1/machines') return Response.json([{
        ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: null,
      }]);
      return responder(path, init);
    });
    await (sync as any).fetchMachines();
    (sync as any).isForeground = false;
    emitSocketStatus('connected');
    (sync as any).isForeground = true;

    // Establish the same authority identity that a previously loaded direct
    // transcript carries before reconnect catch-up switches to read-after.
    markSessionSurfaceVisible('s1');
    machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
      ok: true,
      items: [{ id: 'accepted-before-resume', createdAtMs: 0,
        raw: { role: 'user', content: { type: 'text', text: 'accepted before resume' } } }],
      nextCursor: null,
      tailCursor: 'happier_external_cursor_v1:YzE',
      hasMore: false,
    });
    await (sync as any).fetchMessages('s1');
    expect(storage.getState().sessionMessages.s1?.isLoaded).toBe(true);
    expect(Object.values(storage.getState().sessionMessages.s1?.messagesById ?? {})
      .filter((message) => message.kind === 'user-text').map((message) => message.text))
      .toEqual(['accepted before resume']);
    expect(sync.getAcceptedExternalSessionTailCursor('s1')).toBe('happier_external_cursor_v1:YzE');
    machineExternalSessionTranscriptReadAfterMock.mockReset();
    machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
      ok: true,
      items: [
        {
          id: 'direct-msg-1',
          createdAtMs: 1,
          raw: { role: 'user', content: { type: 'text', text: 'caught up direct' } },
        },
      ],
      nextCursor: 'happier_external_cursor_v1:dGFpbC0x',
      truncated: false,
    });

    markSessionSurfaceVisible('s1');
    expect(resolveSessionLiveConsumption('s1', resolvePreferredServerIdForSessionId('s1')).isFullContentConsumer).toBe(true);
    await (sync as any).resumeSync('socket-reconnect');
    expect(fetchChangesMock).toHaveBeenCalled();
    expect(syncReliabilityTelemetry.snapshot().persistedEvents
      .filter((event) => event.name === 'sync.externalSession.resumeCatchUpFailed')).toEqual([]);
    expect(storage.getState().getSessionTranscriptLoadIssue('s1')).toBeNull();

    expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      cursor: 'happier_external_cursor_v1:YzE',
    }));
    const sessionMessages = storage.getState().sessionMessages.s1;
    const texts = (sessionMessages?.messageIdsOldestFirst ?? [])
      .map((id) => sessionMessages?.messagesById[id])
      .filter((message): message is NonNullable<typeof message> => Boolean(message))
      .filter((message) => message.kind === 'user-text')
      .map((message) => message.text);
    expect(texts).toEqual(['accepted before resume', 'caught up direct']);
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const instanceId = (Reflect.get(sync, 'webSyncClientIdentity') as WebSyncClientIdentity | null)?.instanceId;
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test', instanceId })).toBe(
      'happier_external_cursor_v1:dGFpbC0x',
    );
  }, 60_000);

  it('evaluates a safe cursor lag tripwire on blocked-cursor events without an idle timer', () => {
    const remember = Reflect.get(sync, 'rememberBlockedChangesCursorLag') as (params: {
      blockedCursor: string; blockedReason: string; safeAdvanceCursor: string | null; nowMs: number;
    }) => void;
    const blocked = {
      blockedCursor: 'cursor-2',
      blockedReason: 'unsupported-kind',
      safeAdvanceCursor: 'cursor-1',
    };
    remember.call(sync, { ...blocked, nowMs: 1_000 });

    remember.call(sync, { ...blocked, nowMs: 301_000 });
    expect(syncReliabilityTelemetry.snapshot().persistedEvents.map((event) => event.name)).not.toContain('sync.cursor.safeCursorLagExceeded');

    remember.call(sync, { ...blocked, nowMs: 331_000 });
    expect(syncReliabilityTelemetry.snapshot().persistedEvents).toEqual([
      expect.objectContaining({
        name: 'sync.cursor.safeCursorLagExceeded',
        fields: expect.objectContaining({
          blockedCursor: 'cursor-2',
          blockedReason: 'unsupported-kind',
          safeAdvanceCursor: 'cursor-1',
        }),
      }),
    ]);
  });

  it('publishes ready for the active Home after an ordinary Session-list fetch succeeds', async () => {
    stubSnapshotRefreshFetch();
    const serverId = getActiveServerSnapshot().serverId;

    await (sync as any).fetchSessions();

    expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation)
      .toMatchObject({ phase: 'ready', lastSuccessAt: expect.any(Number) });
  });

  it('keeps the ordinary Sync list fetch on the applied Home while another Home is staged', async () => {
    installWebSelectionBoundary();
    await restoreTestHome('http://applied-ordinary-home.example.test');
    const appliedProfile = account!.home;
    const stagedProfile = await upsertAndActivateServer({ serverUrl: 'http://staged-ordinary-home.example.test', scope: 'tab' });
    expect(stagedProfile.id).not.toBe(appliedProfile.id);
    expect(getActiveServerSnapshot().serverId).toBe(stagedProfile.id);
    stubSnapshotRefreshFetch();
    await (sync as any).fetchSessions();
    expect(storage.getState().concurrentSessionListCacheByServerId[appliedProfile.id]?.listObservation)
      .toMatchObject({ phase: 'ready', lastSuccessAt: expect.any(Number) });
    const stagedServerId = getActiveServerSnapshot().serverId;
    expect(storage.getState().concurrentSessionListCacheByServerId[stagedServerId]?.listObservation?.phase)
      .not.toBe('ready');
  });

  it('keeps prepared Iroh HTTP work on the applied Home while another Home is staged', async () => {
    await restoreTestHome('https://applied-iroh-home.example.test');
    const appliedProfile = account!.home;
    const carrierRequest = vi.fn(async (url: string, _init: RequestInit) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname === '/v1/account/pets') return Response.json({ ok: true, pets: [] });
      return defaultHomeResponse(requestUrl.pathname);
    });
    const appliedCarrier: HomeCarrier = {
      endpointId: 'iroh-applied-home', readObservedPath: () => 'relay', request: carrierRequest,
      createWebSocket: () => ({}),
    };
    await applyTestCarrier(appliedCarrier);
    const stagedProfile = await upsertAndActivateServer({ serverUrl: 'https://staged-home.example.test', scope: 'device' });
    expect(getActiveServerSnapshot().serverId).toBe(stagedProfile.id);
    expect(stagedProfile.id).not.toBe(appliedProfile.id);
    const stagedFetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Staged global HTTP was used: ${String(input)}`);
    });
    setRuntimeFetch(stagedFetch);
    primeServerFeaturesSnapshot({
      serverId: appliedProfile.id,
      snapshot: {
        status: 'ready',
        features: createRootLayoutFeaturesResponse({
          features: { pets: { sync: { enabled: true } }, social: { friends: { enabled: true } } },
          capabilities: {
            social: { friends: { allowUsername: false, requiredIdentityProviderId: 'github' } },
            oauth: { providers: { github: { enabled: true, configured: true } } },
          },
        }),
      },
    });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'social.friends': true } });
    carrierRequest.mockClear();
    apiSocketRequestMock.mockClear();

    await (sync as any).fetchMachines();
    await (sync as any).fetchAccountPets();
    await (sync as any).fetchSessions();
    await (sync as any).fetchFriends();
    await (sync as any).fetchTodos();
    await (sync as any).fetchFeed();
    await (sync as any).fetchProfile();

    expect(stagedFetch).not.toHaveBeenCalled();
    expect(apiSocketRequestMock).not.toHaveBeenCalled();
    expect(carrierRequest.mock.calls.map(([url]) => new URL(url).origin)).toEqual(
      expect.arrayContaining(['https://applied-iroh-home.example.test']));
    expect(carrierRequest.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(expect.arrayContaining([
      '/v1/machines', '/v1/account/encryption/currentness', '/v1/account/pets', '/v1/friends',
      '/v1/kv', '/v1/feed', '/v1/account/profile', '/v2/session-organization', '/v2/sessions',
    ]));
  });

  it('keeps direct Automation settings on the applied Home while another Home is staged', async () => {
    await restoreTestHome('https://applied-automation-home.example.test');
    const appliedProfile = account!.home;
    const appliedCarrierRequest = vi.fn(async (url: string, init: RequestInit) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname === '/v3/automations/settings') {
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + TEST_TOKEN);
        return Response.json({ maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays' });
      }
      return defaultHomeResponse(requestUrl.pathname);
    });
    const appliedCarrier: HomeCarrier = {
      endpointId: 'iroh-applied-automation-home', readObservedPath: () => 'relay',
      request: appliedCarrierRequest, createWebSocket: () => ({}),
    };
    await applyTestCarrier(appliedCarrier);
    const stagedProfile = await upsertAndActivateServer({
      serverUrl: 'https://staged-automation-home.example.test', scope: 'device',
    });
    expect(getActiveServerSnapshot().serverId).toBe(stagedProfile.id);
    expect(stagedProfile.id).not.toBe(appliedProfile.id);
    const stagedFetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Staged global Automation HTTP was used: ${String(input)}`);
    });
    setRuntimeFetch(stagedFetch);
    const automationFeatures = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    primeServerFeaturesSnapshot({ serverId: appliedProfile.id, snapshot: { status: 'ready', features: automationFeatures } });
    primeServerFeaturesSnapshot({ serverId: stagedProfile.id, snapshot: { status: 'ready', features: automationFeatures } });
    appliedCarrierRequest.mockClear();

    await expect(sync.getAutomationSettings()).resolves.toEqual({
      maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays',
    });
    expect(stagedFetch).not.toHaveBeenCalled();
    expect(appliedCarrierRequest).toHaveBeenCalledWith(
      'https://applied-automation-home.example.test/v3/automations/settings', expect.any(Object));
  });

  it('keeps the selected Home query transport on the applied Home while another Home is staged', async () => {
    installWebSelectionBoundary();
    await restoreTestHome('http://applied-home.example.test');
    const appliedProfile = account!.home;
    const stagedProfile = await upsertAndActivateServer({ serverUrl: 'http://staged-home.example.test', scope: 'tab' });
    expect(getActiveServerSnapshot().serverId).toBe(stagedProfile.id);
    expect(stagedProfile.id).not.toBe(appliedProfile.id);
    apiSocketRequestMock.mockClear();
    await expect(sync.fetchSessionListQueryPage(appliedProfile.id, {
      source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
      membership: 'ordinary', signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ current: true, sessionIds: [] }));
    expect(apiSocketRequestMock).toHaveBeenCalled();
  });
});
