import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionRunListResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  act,
  createDeferred,
  createMachineFixture,
  createPlainSessionByIdResponseFixture,
  createSessionFixture,
  createSessionMessagesFixture,
  createToolCallMessageFixture,
  renderHook,
  standardCleanup,
} from '@/dev/testkit';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

// Install SDK ports before importing the real app-entry module graph. Collection
// loads ordinary modules; the runtime bridge and Account lifetimes remain below.
const network = await installSessionOpsNetworkBoundary();
await import('@/sync/syncEngine');
let storage: typeof import('@/sync/domains/state/storage')['storage'];
let previous: ReturnType<typeof storage.getState>;
let home: Awaited<ReturnType<typeof network.addHome>>;
const sessionReads = new Map<string, Session>();

const historicalRuns = ExecutionRunListResponseSchema.parse({ runs: [{
  runId: 'run-1', callId: 'call-1', sidechainId: 'call-1', intent: 'delegate',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
  ioMode: 'request_response', status: 'succeeded', startedAtMs: 1,
}] });

beforeAll(async () => {
  await initializeRealAppRuntimeForTests();
  ({ storage } = await import('@/sync/domains/state/storage'));
});

beforeEach(async () => {
  network.resetRequests();
  previous = storage.getState();
  sessionReads.clear();
  home = await network.addHome('https://execution-support.test', 'account-execution-support');
  const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
  await setActiveServer({ serverId: home.id });
  storage.setState({
    sessions: {}, sessionMessages: {}, machines: {}, machineListByServerId: {},
    sessionListRowsByServerId: {}, sessionListIndexByServerId: {},
    ordinarySessionListMembershipByServerId: {}, concurrentSessionListCacheByServerId: {},
    settings: { ...previous.settings, experiments: true, featureToggles: { 'execution.runs': true } },
  });
  network.respond(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { runs: [] });
  network.setHttpResponder(async input => {
    const url = new URL(String(input));
    const match = /^\/v2\/sessions\/([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    const session = sessionReads.get(JSON.stringify([url.origin, decodeURIComponent(match[1]!)]));
    return session ? Response.json(createPlainSessionByIdResponseFixture(session)) : null;
  });
});

afterEach(async () => {
  await standardCleanup();
  const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  serverScopedRpcSocketPool.resetForTests();
  storage.setState(previous, true);
});

afterAll(async () => { await network?.dispose(); });

function seedSession(id: string, server = home, options: Readonly<{ direct?: boolean; machineId?: string }> = {}) {
  const session = createSessionFixture({
    id, serverId: server.id, active: true,
    metadata: { path: '/repo', host: 'tester.local', ...(options.machineId ? { machineId: options.machineId } : {}) },
  });
  sessionReads.set(JSON.stringify([new URL(server.serverUrl).origin, id]), session);
  const state = storage.getState();
  storage.setState({
    ...(options.direct === false ? {} : { sessions: { ...state.sessions, [id]: session } }),
    sessionListRowsByServerId: {
      ...state.sessionListRowsByServerId,
      [server.id]: { ...state.sessionListRowsByServerId[server.id], [id]: buildSessionListRenderableFromSession(session) },
    },
    ordinarySessionListMembershipByServerId: {
      ...state.ordinarySessionListMembershipByServerId,
      [server.id]: [...new Set([...(state.ordinarySessionListMembershipByServerId[server.id] ?? []), id])],
    },
  });
  return session;
}

function listRequests() {
  return network.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST);
}

async function renderSupport(sessionId: string, serverId?: string) {
  const { useSessionExecutionRunsSupported } = await import('./useSessionExecutionRunsSupported');
  const initialProps: { sessionId: string; serverId?: string } = { sessionId, serverId };
  return renderHook(
    (props: { sessionId: string; serverId?: string }) => useSessionExecutionRunsSupported(props.sessionId, props.serverId),
    { initialProps },
  );
}

async function expectSupport(hook: Awaited<ReturnType<typeof renderSupport>>, value: boolean) {
  await waitForHomeGovernance(() => { expect(hook.getCurrent()).toBe(value); });
}

async function warmLiveSupport(sessionId: string, server = home) {
  const machineId = `machine-${sessionId}-${server.id}`;
  seedSession(sessionId, server, { machineId });
  const machine = createMachineFixture({ id: machineId });
  storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId, [server.id]: [machine] } });
  network.setRpcResponder(async request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST
    ? { runs: [] }
    : { protocolVersion: 1, results: { 'tool.executionRuns': {
      ok: true, checkedAt: 1, data: { backends: { codex: { available: true, intents: ['delegate'] } } },
    } } });
  const { prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');
  await prefetchMachineCapabilities({ machineId, serverId: server.id, request: { requests: [{ id: 'tool.executionRuns' }] } });
  return machineId;
}

describe('useSessionExecutionRunsSupported', () => {
  it('keeps the shell support reader idle for admitted text arrivals while execution-run support stays fresh', async () => {
    const sessionId = 'session-streaming-support';
    seedSession(sessionId);
    storage.getState().applyMessages(sessionId, Array.from({ length: 1_000 }, (_, index): NormalizedMessage => ({
      id: `prefix-${index}`, localId: null, createdAt: index + 1,
      isSidechain: false, role: 'agent',
      content: [{ type: 'text', text: `earlier paragraph ${index}`, uuid: `prefix-${index}`, parentUUID: null }],
    })));
    // This boolean is consumed by SessionViewFocusedSurfaceContentBody. Keep the
    // real store, support hook, capability policy and historical RPC beneath it.
    const { useSessionExecutionRunsSupported } = await import('./useSessionExecutionRunsSupported');
    const counts = createRenderCommitCounter();
    const hook = await renderHook(() => {
      useRenderCommitCounter(counts);
      return useSessionExecutionRunsSupported(sessionId, home.id);
    });
    await waitForHomeGovernance(() => { expect(listRequests()).toHaveLength(1); });
    await act(async () => { await Promise.resolve(); });
    expect(hook.getCurrent()).toBe(false);
    counts.reset();
    const signalMembership = storage.getState().sessionMessages[sessionId]?.executionRunSignalMessageIds;
    expect(signalMembership?.size).toBe(0);
    const beforeVersion = storage.getState().sessionMessages[sessionId]?.messagesVersion ?? 0;
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        storage.getState().applyMessages(sessionId, [{
          id: `stream-${index}`, localId: null, createdAt: index + 10,
          isSidechain: false, role: 'agent',
          content: [{ type: 'text', text: `paragraph ${index}`, uuid: `stream-${index}`, parentUUID: null }],
        }]);
      });
    }
    expect(storage.getState().sessionMessages[sessionId]?.messagesVersion).toBe(beforeVersion + 5);
    expect(counts.read()).toEqual({ renders: 0, commits: 0 });
    expect(listRequests()).toHaveLength(1);

    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        storage.getState().applyMessages(sessionId, [{
          id: 'tail', localId: 'tail', createdAt: 10, isSidechain: false, role: 'agent',
          content: [{ type: 'text', text: `streamed tail ${index}`, uuid: 'tail', parentUUID: null }],
          meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'tail',
            segmentState: 'streaming', startedAtMs: 10, updatedAtMs: index + 11 } },
        }]);
      });
    }
    expect(storage.getState().sessionMessages[sessionId]?.messagesVersion).toBe(beforeVersion + 10);
    expect(storage.getState().sessionMessages[sessionId]?.executionRunSignalMessageIds).toBe(signalMembership);
    expect(counts.read()).toEqual({ renders: 0, commits: 0 });

    await act(async () => {
      storage.getState().applyMessages(sessionId, [{
        id: 'run-start', localId: null, createdAt: 30, isSidechain: false, role: 'agent',
        content: [{ type: 'tool-call', id: 'run-tool', name: 'SubAgentRun', input: { runId: 'run-1' },
          description: null, uuid: 'run-start', parentUUID: null }],
      }]);
    });
    expect(hook.getCurrent()).toBe(true);
    expect(counts.read().commits).toBeGreaterThan(0);
    await act(async () => { storage.getState().replaceSessionMessages(sessionId, []); });
    expect(hook.getCurrent()).toBe(false);
    await hook.unmount();
  });

  it('tracks a late execution-run result and retires its signal with transcript replacement and eviction', async () => {
    const sessionId = 'session-late-signal';
    seedSession(sessionId);
    storage.getState().applyMessages(sessionId, [{
      id: 'start', localId: null, createdAt: 1, role: 'agent', isSidechain: false,
      content: [{ type: 'tool-call', id: 'start-tool', name: 'execution_run_start', input: {},
        description: null, uuid: 'start', parentUUID: null }],
    }]);
    const hook = await renderSupport(sessionId, home.id);
    await waitForHomeGovernance(() => { expect(listRequests()).toHaveLength(1); });
    await act(async () => { await Promise.resolve(); });
    expect(hook.getCurrent()).toBe(false);
    await act(async () => {
      storage.getState().applyMessages(sessionId, [{
        id: 'result', localId: null, createdAt: 2, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-result', tool_use_id: 'start-tool', content: 'started run_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          is_error: false, uuid: 'result', parentUUID: null }],
      }]);
    });
    expect(hook.getCurrent()).toBe(true);
    await act(async () => { storage.getState().replaceSessionMessages(sessionId, []); });
    expect(hook.getCurrent()).toBe(false);
    await act(async () => {
      storage.getState().replaceSessionMessages(sessionId, [{
        id: 'restored', localId: null, createdAt: 3, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-call', id: 'restored-tool', name: 'SubAgentRun', input: { runId: 'run-restored' },
          description: null, uuid: 'restored', parentUUID: null }],
      }]);
    });
    expect(hook.getCurrent()).toBe(true);
    await act(async () => { storage.getState().evictSessionMessages(sessionId); });
    expect(hook.getCurrent()).toBe(false);
    await hook.unmount();
  });

  it('returns true immediately when the loaded transcript already contains execution-run signals', async () => {
    seedSession('session-transcript');
    const message = createToolCallMessageFixture();
    message.tool = { ...message.tool, name: 'SubAgentRun', input: { runId: 'run-1' }, result: {} };
    storage.setState({ sessionMessages: { 'session-transcript': createSessionMessagesFixture({
      isLoaded: true, messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message },
    }) } });

    const hook = await renderSupport('session-transcript');

    expect(hook.getCurrent()).toBe(true);
    expect(listRequests()).toEqual([]);
  });

  it('probes the session runs list and enables support when historical runs exist', async () => {
    seedSession('session-historical');
    network.respond(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, historicalRuns);

    const hook = await renderSupport('session-historical');

    await expectSupport(hook, true);
    expect(listRequests()).toMatchObject([{ serverUrl: home.serverUrl, targetId: 'session-historical', payload: {} }]);
  });

  it('keeps support disabled when the historical probe returns no runs', async () => {
    seedSession('session-empty');
    const probe = createDeferred<typeof historicalRuns>();
    network.setRpcResponder(async () => probe.promise);
    const hook = await renderSupport('session-empty');

    await waitForHomeGovernance(() => { expect(listRequests()).toHaveLength(1); });
    await act(async () => { probe.resolve({ runs: [] }); });
    expect(hook.getCurrent()).toBe(false);
  });

  it('serves every mounted support reader of one Session from one historical list read', async () => {
    // P03-MOBILE-IOS-FLOWS: opening a Session mounts this reader in the Session shell and in the
    // launchability owner; live iOS counted 2 app list reads (+4 daemon verifies) per open.
    seedSession('session-shared-probe');
    network.respond(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, historicalRuns);
    const { useSessionExecutionRunsSupported } = await import('./useSessionExecutionRunsSupported');
    const hook = await renderHook(() => [
      useSessionExecutionRunsSupported('session-shared-probe', home.id),
      useSessionExecutionRunsSupported('session-shared-probe', home.id),
    ]);

    await waitForHomeGovernance(() => { expect(hook.getCurrent()).toEqual([true, true]); });
    expect(listRequests()).toHaveLength(1);
  });

  it('clears historical support when the Session changes before its next probe resolves', async () => {
    seedSession('session-with-runs');
    seedSession('session-without-runs');
    const nextProbe = createDeferred<typeof historicalRuns>();
    network.setRpcResponder(async request => request.targetId === 'session-with-runs' ? historicalRuns : nextProbe.promise);
    const hook = await renderSupport('session-with-runs');
    await expectSupport(hook, true);

    await hook.rerender({ sessionId: 'session-without-runs' });

    expect(hook.getCurrent()).toBe(false);
    await act(async () => { nextProbe.resolve({ runs: [] }); });
  });

  it('uses the loaded direct Session Home for live execution-run support', async () => {
    const machineId = await warmLiveSupport('session-direct');
    const hook = await renderSupport('session-direct');

    expect(hook.getCurrent()).toBe(true);
    expect(network.requests).toEqual(expect.arrayContaining([expect.objectContaining({ serverUrl: home.serverUrl, targetId: machineId })]));
    expect(listRequests()).toEqual([]);
  });

  it('resolves a bare Session through its unique membership on the active Home', async () => {
    await warmLiveSupport('session-list-only');
    storage.setState({ sessions: {} });
    const hook = await renderSupport('session-list-only');

    expect(hook.getCurrent()).toBe(true);
    expect(listRequests()).toEqual([]);
  });

  it('recomputes bare Session support when its unique Home membership changes', async () => {
    seedSession('session-reactive', home, { direct: false });
    const hook = await renderSupport('session-reactive');
    await waitForHomeGovernance(() => { expect(listRequests()).toHaveLength(1); });
    expect(hook.getCurrent()).toBe(false);
    const other = await network.addHome('https://execution-support-other.test', 'account-execution-other');
    await act(async () => {
      await warmLiveSupport('session-reactive', other);
      const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
      await setActiveServer({ serverId: other.id });
      storage.setState({ sessions: {}, sessionListRowsByServerId: {
        [other.id]: storage.getState().sessionListRowsByServerId[other.id],
      }, ordinarySessionListMembershipByServerId: { [other.id]: ['session-reactive'] } });
    });

    await expectSupport(hook, true);
  });

  it('prefers the explicit canonical Home for live support when the Session id exists on another Home', async () => {
    const other = await network.addHome('https://execution-support-explicit.test', 'account-execution-explicit');
    await warmLiveSupport('same-session-live', other);
    seedSession('same-session-live', home);
    const hook = await renderSupport('same-session-live', other.id);

    expect(hook.getCurrent()).toBe(true);
    expect(listRequests()).toEqual([]);
  });

  it('keeps historical support on the explicit Home when the same Session id is loaded from another Home', async () => {
    const other = await network.addHome('https://execution-support-history.test', 'account-execution-history');
    seedSession('same-session-history', other, { direct: false });
    seedSession('same-session-history', home);
    network.respond(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, historicalRuns);
    network.respond(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { run: historicalRuns.runs[0] });
    const { sessionExecutionRunList, sessionExecutionRunGet, sessionExecutionRunStart } = await import('@/sync/ops/sessionExecutionRuns');

    await expect(sessionExecutionRunList('same-session-history', {}, { serverId: other.id })).resolves.toEqual(historicalRuns);
    await expect(sessionExecutionRunGet('same-session-history', { runId: 'run-1' }, { serverId: other.id }))
      .resolves.toEqual({ run: historicalRuns.runs[0] });
    await expect(sessionExecutionRunStart('same-session-history', {
      intent: 'delegate', backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      instructions: 'Inspect', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response',
    }, { serverId: other.id })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_home_unavailable' });
    expect(network.requests).toMatchObject([
      { serverUrl: other.serverUrl, targetId: 'same-session-history', method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, payload: {} },
      { serverUrl: other.serverUrl, targetId: 'same-session-history', method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, payload: { runId: 'run-1' } },
    ]);
    const hook = await renderSupport('same-session-history', other.id);

    await expectSupport(hook, true);
    expect(listRequests()).toMatchObject([
      { serverUrl: other.serverUrl, targetId: 'same-session-history', payload: {} },
      { serverUrl: other.serverUrl, targetId: 'same-session-history', payload: {} },
    ]);
  });

  it.each(['missing_credentials', 'wrong_account'] as const)('refuses explicit Home reads with %s without using the ambient Home', async refusal => {
    const other = await network.addHome('https://execution-support-refused.test', 'account-execution-refused');
    seedSession('same-session-refused', other, { direct: false });
    seedSession('same-session-refused', home);
    if (refusal === 'missing_credentials') {
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      expect(await TokenStorage.removeCredentialsForServerUrl(other.serverUrl, { serverId: other.id })).toBe(true);
    }
    const options = refusal === 'wrong_account'
      ? { scope: { serverId: other.id, accountId: 'retired-account' } }
      : { serverId: other.id };
    const { sessionExecutionRunList, sessionExecutionRunGet } = await import('@/sync/ops/sessionExecutionRuns');
    await expect(sessionExecutionRunList('same-session-refused', {}, options)).resolves.toMatchObject({ ok: false });
    await expect(sessionExecutionRunGet('same-session-refused', { runId: 'run-1' }, options)).resolves.toMatchObject({ ok: false });
    expect(network.requests).toEqual([]);
  });
});
