import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { encodePlainMachineStoredContent, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, projectLegacySessionAccessCapabilitiesV1, SessionCurrentProjectionRecordV1Schema, type SessionOrganizationSnapshot } from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Socket } from 'socket.io-client';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

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

import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { disconnectActiveServerConnection, switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
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
  resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { WEB_SYNC_INSTANCE_ID_SESSION_KEY } from '@/sync/runtime/webSyncClientIdentity';
import { syncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { normalizeRawMessages } from "@happier-dev/session-core/raw";

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
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

function defaultHomeResponse(path: string): Response {
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
  if (path === '/v1/plugins/availability/intents/list') return Response.json({ availabilityCursor: 0, pluginIds: [] });
  if (path === '/v1/plugins/availability/materializations/read') return Response.json({ availabilityCursor: 0, snapshots: [] });
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

async function restoreTestHome(serverUrl = 'http://localhost:53288', serverIdentityId?: string): Promise<void> {
  await account?.dispose();
  account = await restoreServerAccountForTest({
    serverUrl, serverIdentityId, credentials: { token: TEST_TOKEN },
    request: async (url, init) => {
      const requestUrl = new URL(String(url));
      const path = requestUrl.pathname + requestUrl.search;
      if (requestUrl.pathname === '/health') return Response.json({});
      if (requestUrl.pathname.startsWith('/v1/account/encryption')
        || requestUrl.pathname === '/v1/features' || requestUrl.pathname === '/v1/features/authenticated'
        || requestUrl.pathname.startsWith('/v1/plugins/availability/')
        || requestUrl.pathname === '/v1/account/authoring-memory') return defaultHomeResponse(requestUrl.pathname);
      if (requestUrl.pathname === '/v2/changes') return (await fetchChangesMock(path, init)).clone();
      if (requestUrl.pathname === '/v2/cursor') return (await fetchCurrentChangesCursorMock(path, init)).clone();
      return (await apiSocketRequestMock(path, init)).clone();
    },
  });
  await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
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
    apiSocketRequestMock.mockImplementation(async path => defaultHomeResponse(new URL(path, 'http://localhost').pathname));
    await restoreTestHome();
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

  it('clears lastSocketDisconnectedAtMs when socket becomes connected again', async () => {
    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();

    // subscribeToUpdates installs the socket listeners and should set the timestamp on disconnected.
    (sync as any).subscribeToUpdates();
    emitSocketStatus('disconnected');

    const afterDisconnected = (sync as any).lastSocketDisconnectedAtMs;
    expect(typeof afterDisconnected).toBe('number');


    emitSocketStatus('connected');

    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();
  }, 60_000);

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

    (sync as any).subscribeToUpdates();
    emitSocketStatus('disconnected');

    expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation)
      .toEqual({ phase: 'offline', lastSuccessAt: 1_000 });
  });

  it('uses captured offline duration for loaded transcript catch-up after connected status clears the disconnect timestamp', async () => {
    (sync as any).subscribeToUpdates();


    emitSocketStatus('disconnected');
    const disconnectedAt = (sync as any).lastSocketDisconnectedAtMs;
    expect(typeof disconnectedAt).toBe('number');
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;


    emitSocketStatus('connected');
    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();

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
    (sync as any).subscribeToUpdates();


    emitSocketStatus('disconnected');
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;
    emitSocketStatus('connected');

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
    await materializeLoadedTranscript('s_reconnect_consumed', 20);
    markSessionSurfaceVisible('s_reconnect_consumed');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_consumed: 20 };
    (sync as any).isForeground = true;

    await (sync as any).fetchMessages('s_reconnect_consumed');
    await (sync as any).fetchMessages('s_reconnect_consumed');

    expect(apiSocketRequestMock.mock.calls.filter(([path]) => path.startsWith('/v1/sessions/s_reconnect_consumed/messages?'))).toHaveLength(1);
  }, 60_000);

  it('does not reopen consumed transcript catch-up on duplicate connected statuses without a new disconnect', async () => {
    (sync as any).subscribeToUpdates();


    emitSocketStatus('disconnected');
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;
    emitSocketStatus('connected');

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
    await materializeLoadedTranscript('s_reconnect_duplicate_connected', 20);
    markSessionSurfaceVisible('s_reconnect_duplicate_connected');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_duplicate_connected: 20 };
    (sync as any).isForeground = true;

    await (sync as any).fetchMessages('s_reconnect_duplicate_connected');


    emitSocketStatus('connected');

    await (sync as any).fetchMessages('s_reconnect_duplicate_connected');

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
    const staleListRow = {
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
    };
    let activeSnapshotCalls = 0;
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path.startsWith('/v2/sessions/active')) {
        activeSnapshotCalls += 1;
        if (activeSnapshotCalls === 1) {
          await snapshotReleased;
        }
        return new Response(JSON.stringify({
          sessions: activeSnapshotCalls === 1 ? [staleListRow] : [],
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
    expect(activeSnapshotCalls, JSON.stringify({
      requests: apiSocketRequestMock.mock.calls.map(([path]) => path),
      queue: await (sync as any).sessionsSync.awaitQueue(),
    })).toBe(2);

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
    const staleListRow = {
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
    };
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
    onTestFinished(async () => { releaseOlderSnapshot(); await olderSnapshot; });
    await expect.poll(() => activeSnapshotCalls).toBe(1);

    const exactHydration = (sync as any).fetchSessions({
      requiredHydrationSessionIds: [sessionId],
      prioritizeSessionIds: [sessionId],
      awaitSessionListHydration: true,
    });
    await expect.poll(() => apiSocketRequestMock.mock.calls.some(([path]) => (
      new URL(path, 'http://localhost').pathname === `/v2/sessions/${sessionId}`
    )), { message: 'Exact Home hydration must run independently of the older held snapshot' }).toBe(true);
    await exactHydration;

    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toBeUndefined();

    releaseOlderSnapshot();
    await olderSnapshot;
    await (sync as any).sessionsSync.awaitQueue({ timeoutMs: 2_000 });

    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)).toBeUndefined();
  });

  it('fetches and hydrates cold hidden Voice attention rows when session-list attention placement is off', async () => {
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
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    await (sync as any).fetchSessions();

    const initialSessionsRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/sessions?'));
    expect(initialSessionsRequest).toContain('includeAttention=true');
    await expect.poll(() => Object.keys(storage.getState().sessions).filter((sessionId) => (
      sessionId.startsWith('cold-hidden-voice-')
    )).sort()).toEqual([
      'cold-hidden-voice-late-result',
      'cold-hidden-voice-permission',
    ]);
    expect(storage.getState().sessions['cold-hidden-voice-permission']).toMatchObject({
      agentState: {
        requests: {
          approve: {
            kind: 'permission',
            tool: 'Bash',
          },
        },
      },
    });
    expect(storage.getState().sessions['cold-hidden-voice-late-result']).toMatchObject({
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
        const terminal = page === 101;
        return new Response(JSON.stringify({
          sessions: terminal ? [{
            id: 'attention-page-101',
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
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    await (sync as any).fetchSessions();

    expect(attentionCursors).toHaveLength(100);
    expect(attentionCursors[0]).toBe('attention-1');
    expect(attentionCursors.at(-1)).toBe('attention-100');
    expect(sync.readOrdinarySessionListCoverage().coverage).toBe('incomplete');
    expect(storage.getState().concurrentSessionListCacheByServerId[getActiveServerSnapshot().serverId!]?.listObservation?.phase)
      .not.toBe('ready');

    await sync.fetchMoreSessions();

    expect(attentionCursors).toHaveLength(101);
    expect(attentionCursors.at(-1)).toBe('attention-101');
    expect(storage.getState().sessionListRowsByServerId[getActiveServerSnapshot().serverId!]?.['attention-page-101'])
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
      return new Response(JSON.stringify({ assignments: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
    })).rejects.toThrow(
      'Required session shell hydration failed for s_compatibility_404: invalid_response',
    );

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
        { sessionId: 's_organization_pin', sortKey: '0001', pinnedAt: 1 },
        { sessionId: 's_identity_pin', sortKey: '0002', pinnedAt: 2 },
        { sessionId: 's_unscoped_pin', sortKey: '0003', pinnedAt: 3 },
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
      pins: [{ sessionId: 's_other_pin', sortKey: '0001', pinnedAt: 1 }],
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
      pins: [{ sessionId: 'server-pinned-session', sortKey: 'rank-a', pinnedAt: 1 }],
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
              pins: [{ sessionId: 'server-pinned-session', sortKey: 'rank-a', pinnedAt: 1 }],
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
        return new Response(JSON.stringify({ error: 'preview_not_found', reasonCode: 'preview_not_found' }), {
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    routeApiSocketRequestsThroughFetch(fetchMock);


    await (sync as any).fetchMachines();

    expect(storage.getState().machines).toEqual({});
    expect(storage.getState().machineDisplayById).toEqual({});
    expect(storage.getState().machineListByServerId[activeServerId]).toEqual([]);
  }, 60_000);

  it('refreshes sessions on socket reconnect (recovers missed activity ephemerals)', async () => {
    // Ensure serverFetch has an active server target.

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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    // Minimal Sync prerequisites to allow resumeSync to proceed.
    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('/v2/sessions')]),
    );
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'stale-profile-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(fetchCurrentChangesCursorMock).toHaveBeenCalledTimes(1);
    const serverScope = getActiveServerSnapshot().serverId;
    const instanceId = globalThis.sessionStorage?.getItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY) ?? undefined;
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
    sessionStorage.setItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY, 'tab-a');
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    routeApiSocketRequestsThroughFetch(fetchMock);

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect({
      instanceId: sessionStorage.getItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY),
      instanceCursor: loadChangesCursor({ serverScope: activeServerId, accountId: 'test', instanceId: 'tab-a' }),
      staleProfileCursor: loadChangesCursor({ serverScope: activeServerId, accountId: 'test-account', instanceId: 'tab-a' }),
    }).toMatchObject({
      instanceId: 'tab-a',
      instanceCursor: '12',
      staleProfileCursor: null,
    });
  }, 60_000);

  it('persists direct-session tail cursors under the current tab instance scope', async () => {
    const sessionStorage = new MemoryWebStorage();
    const localStorage = new MemoryWebStorage();
    sessionStorage.setItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY, 'tab-a');
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
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test', instanceId: 'tab-a' })).toBe(tailCursor);
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    const instanceId = globalThis.sessionStorage?.getItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY) ?? undefined;
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test', instanceId })).toBe(
      'happier_external_cursor_v1:dGFpbC0x',
    );
  }, 60_000);

  it('persists a safe cursor lag tripwire only after two over-threshold checks', () => {
    (sync as any).rememberBlockedChangesCursorLag({
      blockedCursor: 'cursor-2',
      blockedReason: 'unsupported-kind',
      safeAdvanceCursor: 'cursor-1',
      nowMs: 1_000,
    });

    (sync as any).evaluateSafeCursorLagTripwireNow(301_000);
    expect(syncReliabilityTelemetry.snapshot().persistedEvents.map((event) => event.name)).not.toContain('sync.cursor.safeCursorLagExceeded');

    (sync as any).evaluateSafeCursorLagTripwireNow(331_000);
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
