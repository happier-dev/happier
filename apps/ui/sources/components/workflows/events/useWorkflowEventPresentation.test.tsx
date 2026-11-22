import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { ExecutionRunGetResponseSchema, ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceV1Schema } from '@happier-dev/protocol/sessions';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { act, createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import type { WorkflowActivityFact } from '@/sync/domains/workflows/workflowActivityTypes';
import { createMachineExecutionRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';

import { useWorkflowEventPresentation } from './useWorkflowEventPresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

await initializeRealAppRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let disposeExecutor: (() => void) | undefined;
let reads: unknown[] = [];
let workflowResponse: (actionId: string) => Promise<unknown>;
let run = executionRun('Review the deployment changes');
const source = { kind: 'execution_run', machineId: 'event-machine', runId: 'native-event-run' } as const;
const fact = {
  key: 'retained-native-cause', kind: 'run', runId: source.runId, event: 'terminal', sourceRevision: 7,
  occurredAt: 200, coverage: 'retained_cause',
  evidence: { v: 1, kind: 'runLifecycle', source, condition: 'terminal', sourceRevision: 7, occurredAt: 200 },
} as const satisfies WorkflowActivityFact;

function executionRun(title: string) {
  return ExecutionRunPublicStateSchema.parse({ runId: 'native-event-run', callId: 'call', sidechainId: 'sidechain',
    intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { title },
    permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    status: 'succeeded', startedAtMs: 100, finishedAtMs: 200 });
}

beforeAll(async () => { disposeExecutor = await installRealActionExecutorModuleLoader(); });
afterAll(() => disposeExecutor?.());
beforeEach(async () => {
  reads = [];
  workflowResponse = async actionId => { throw new Error(`Unexpected Workflow HTTP request: ${actionId}`); };
  run = executionRun('Review the deployment changes');
  // Only Home HTTP and the Machine Socket SDK are fixtures; lifetime, Action admission and header reads stay real.
  const relay = await createExternalActionAccountHttpBoundary({ serverUrl: 'http://event-native-run.test',
    serverIdentityId: 'srv_event_native_run', accountId: 'event-account', machineId: source.machineId,
    actionId: 'execution.run.get', tokenEpoch: 0, execute: async () => { throw new Error('Detached header reads use Machine RPC'); } });
  const http = createWorkflowActionHttpTransport({ accountId: () => 'event-account',
    machineRows: () => [relay.machine],
    fixtureResponse: actionId => workflowResponse(actionId) });
  connection = await restoreServerAccountForTest({ serverUrl: 'http://event-native-run.test',
    serverIdentityId: 'srv_event_native_run', accountId: 'event-account',
    credentials: { token: createAccountTokenForTests('event-account', { currentAccount: true }) },
    configureSocket: socket => {
      configureConnectedServerSocketBoundary(socket);
      socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
        if (event === SESSION_CONSUMPTION_REPLACE_EVENT) return { ok: true, ...SessionConsumptionReplaceV1Schema.parse(payload) };
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string'
          || !('params' in payload)) throw new Error('Expected Machine RPC wire request');
        const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
        if (payload.method === `${source.machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`) return {
          ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE, request.callId),
        };
        expect(payload.method).toBe(`${source.machineId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`);
        reads.push(request.params);
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
          ExecutionRunGetResponseSchema.parse({ run }), request.callId) };
      });
    },
    request: async (url, init) => await relay.handle(new URL(String(url)), init) ?? await http.fetch(url, init),
  });
  await (await import('@/sync/sync')).sync.refreshMachines();
});
afterEach(async () => { await standardCleanup(); await connection?.dispose(); connection = undefined; });

it('names a retained native cause through the exact Run header and preserves its frozen evidence and route', async () => {
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  // Control: prove this actual Account/Machine read is admitted before attributing the presentation RED.
  expect(await callWorkflowAction({ actionId: 'execution.run.get', input: { runId: source.runId, sessionId: null,
    includeStructured: false, includeLatestToolResult: false }, context: { executionRunTargetMachineId: source.machineId },
    accountLifetime: lifetime, parseResult: value => ExecutionRunGetResponseSchema.parse(value) })).toEqual({ run });
  reads.length = 0;
  const hook = await renderHook(() => useWorkflowEventPresentation(fact, lifetime.scope, undefined, true));
  await expect.poll(() => hook.getCurrent()?.lines[0]?.value).toBe(run.display!.title);
  // The row says where the retained cause ran, never a mechanism word.
  const machine = await renderHook(() => useServerScopedMachineLabel(lifetime.scope.serverId, source.machineId));
  await expect.poll(() => machine.getCurrent()).toEqual(expect.any(String));
  // The row is named by its Run (lab events-A); the line beneath says how it ended and where it ran (F3).
  expect(hook.getCurrent()?.subtitle).toBe(`${t('workflows.events.finishedLine')} ·\u00A0${machine.getCurrent()}`);
  expect(hook.getCurrent()).toMatchObject({ fact,
    title: run.display!.title,
    open: { href: createMachineExecutionRunRoute(lifetime.scope.serverId, source.machineId, source.runId) } });
  expect(reads).toEqual([{ runId: source.runId, includeStructured: false, includeLatestToolResult: false }]);
  run = executionRun('Review the renamed deployment');
  await act(async () => { notifyExecutionRunActivity({ serverId: lifetime.scope.serverId, machineId: source.machineId }, { runId: source.runId }); });
  await expect.poll(() => hook.getCurrent()?.lines[0]?.value).toBe(run.display!.title);
  expect(hook.getCurrent()?.fact).toBe(fact);
});

it('acquires native names only while the retained row is presented', async () => {
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const hook = await renderHook((active: boolean) => useWorkflowEventPresentation(fact, lifetime.scope, undefined, active),
    { initialProps: false });
  expect(reads).toEqual([]);
  await hook.rerender(true);
  await expect.poll(() => hook.getCurrent()?.lines[0]?.value).toBe(run.display!.title);
  await hook.rerender(false);
  const previousReads = reads.length;
  run = executionRun('Review changes received while hidden');
  await act(async () => { notifyExecutionRunActivity({ serverId: lifetime.scope.serverId, machineId: source.machineId }, { runId: source.runId }); });
  expect(reads.length).toBe(previousReads);
  await hook.rerender(true);
  await expect.poll(() => hook.getCurrent()?.lines[0]?.value).toBe(run.display!.title);
});

it('names the Machine from its owner in the event title', async () => {
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const online = { key: 'machine-online', kind: 'machine', machineId: source.machineId, event: 'online',
    sourceRevision: 1, occurredAt: 300, coverage: 'live' } as const satisfies WorkflowActivityFact;
  const machine = await renderHook(() => useServerScopedMachineLabel(lifetime.scope.serverId, source.machineId));
  await expect.poll(() => machine.getCurrent()).toEqual(expect.any(String));
  const hook = await renderHook(() => useWorkflowEventPresentation(online, lifetime.scope));
  expect(hook.getCurrent()).toMatchObject({
    title: t('workflows.events.machineOnline', { machine: machine.getCurrent()! }),
    // A narrow row shortens the Machine's name before its verb.
    rowTitle: { subject: machine.getCurrent()!, verb: t('workflows.events.cameOnline') },
  });
  // Online and offline do not share one glyph.
  const offline = await renderHook(() => useWorkflowEventPresentation({ ...online, key: 'machine-offline', event: 'offline' },
    lifetime.scope));
  expect(offline.getCurrent()?.rowTitle?.verb).toBe(t('workflows.events.wentOffline'));
  expect(offline.getCurrent()?.glyph).not.toBe(hook.getCurrent()?.glyph);
});

it('waits for the Machine display to settle before publishing an event title', async () => {
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const machine = createMachineFixture({ id: 'awaiting-event-name' });
  const event = { key: 'pending-machine-online', kind: 'machine', machineId: machine.id, event: 'online',
    sourceRevision: 1, occurredAt: 300, coverage: 'retained' } as const satisfies WorkflowActivityFact;
  await publishMachineInventoryForTest(lifetime.scope, [{ ...machine, metadata: null, availability: undefined }]);
  const hook = await renderHook(() => useWorkflowEventPresentation(event, lifetime.scope));
  expect(hook.getCurrent()).toBeNull();
  await act(async () => { await publishMachineInventoryForTest(lifetime.scope, [machine]); });
  const name = await renderHook(() => useServerScopedMachineLabel(lifetime.scope.serverId, machine.id));
  expect(hook.getCurrent()?.title).toBe(t('workflows.events.machineOnline', { machine: name.getCurrent()! }));
});

it("names a Session's turn by its Agent and carries the Agent's mark (lab events:A)", async () => {
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const serverId = lifetime.scope.serverId;
  const row = createSessionFixture({ id: 'turn-session', metadata: { ...createSessionFixture().metadata!, flavor: 'claude' } });
  getStorage().setState((state) => ({ sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
    [serverId]: { ...state.sessionListRowsByServerId[serverId], [row.id]: row as unknown as SessionListRenderableSession } } }));
  const turn = { key: 'turn', kind: 'session', sessionId: row.id, event: 'parentTurnStarted', turnId: 'turn-1',
    sourceRevision: 1, occurredAt: 400, coverage: 'live' } as const satisfies WorkflowActivityFact;
  const hook = await renderHook(() => useWorkflowEventPresentation(turn, lifetime.scope));
  expect(hook.getCurrent()).toMatchObject({ agentId: 'claude',
    title: t('workflows.events.agentTurnStarted', { agent: resolveAgentCatalogTitle('claude') }) });
});

it('keeps one checked subject when moving between Session, Machine and Project rows', async () => {
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const { useWorkflowEventMatch } = await import('./WorkflowEventDetail');
  const fact = { key: 'check-subject', kind: 'session', event: 'started', sessionId: 'session-check',
    sourceRevision: 1, occurredAt: 10, coverage: 'live' } as const satisfies WorkflowActivityFact;
  const store = getStorage();
  const session = createSessionFixture({ id: fact.sessionId, serverId: lifetime.scope.serverId, projectKey: 'payments' });
  const row = buildSessionListRenderableFromSession(session, undefined, []);
  if (!row) throw new Error('Expected the scoped Session row');
  store.getState().applyServerScopedSessionListRows(lifetime.scope.serverId, [row], { source: 'rowOnly', mode: 'append' });
  const presentation = { fact, title: 'Session started', subtitle: 'Session name', glyph: 'play', agentId: null,
    rowTitle: null, needsYou: false, open: null, runsStarted: [],
    lines: [{ key: 'session', value: 'Session name', label: 'Session' },
      { key: 'machine', value: 'Machine name', label: 'Machine' }], sessionMachineId: source.machineId } as const;
  const hook = await renderHook(() => useWorkflowEventMatch(presentation, lifetime.scope));
  expect(hook.getCurrent().projectLine).toBeNull();
  await act(async () => {
    store.setState({ profileScope: lifetime.scope });
    store.getState().activateProjectAccountRowsScope(lifetime.scope);
    store.getState().applyProjectAccountRowsForScope(lifetime.scope, {
      scope: lifetime.scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [{ id: 'payments-checkout', machineId: source.machineId, serverId: lifetime.scope.serverId,
        rootPath: '/repo/payments', projectKey: 'payments', label: 'Payments', createdAtMs: 1 }],
      relationships: [], organizations: [], revisionsByPhysicalKey: {},
    });
  });
  expect(hook.getCurrent().projectLine).toBeNull();
  await act(async () => {
    if (!session.metadata) throw new Error('Expected Session metadata');
    const metadata = { ...session.metadata, projectId: 'payments' };
    const attached = buildSessionListRenderableFromSession({ ...session, metadata, metadataVersion: session.metadataVersion + 1 }, undefined, []);
    if (!attached) throw new Error('Expected the attached Session row');
    store.getState().applyServerScopedSessionListRows(lifetime.scope.serverId, [attached], { source: 'rowOnly', mode: 'append' });
  });
  expect(hook.getCurrent().projectLine).toMatchObject({ value: 'Payments' });
  await act(async () => { hook.getCurrent().toggle('session'); });
  expect(hook.getCurrent().match?.subject).toMatchObject({ kind: 'session', sessionId: fact.sessionId });
  await act(async () => { hook.getCurrent().toggle('machine'); });
  expect(hook.getCurrent().match?.subject).toMatchObject({ kind: 'machine', machineId: source.machineId });
  await act(async () => { hook.getCurrent().toggle('project'); });
  expect(hook.getCurrent().match?.subject).toMatchObject({ kind: 'project', projectKey: 'payments' });
  await act(async () => { hook.getCurrent().toggle('project'); });
  expect(hook.getCurrent().match).toBeNull();
});

it('waits for the selected event read despite a connected socket, then distinguishes failure from settled absence', async () => {
  const page = createDeferred<void>();
  let failed = false;
  workflowResponse = async actionId => {
    expect(actionId).toBe('workflow.run.list');
    await page.promise;
    if (failed) throw new Error('fixture activity read unavailable');
    return { ok: true, result: { runs: [], metadataByRunId: {}, projection: 'membership' } };
  };
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const { storage } = await import('@/sync/domains/state/storageStore');
  await act(async () => { storage.getState().setSocketStatus('connected'); });
  const { useWorkflowActivityFeed } = await import('@/sync/domains/workflows/useWorkflowActivityFeed');
  const feed = await renderHook(() => useWorkflowActivityFeed({ lifetime, active: true }));
  expect(feed.getCurrent()).toMatchObject({ status: 'live', retained: null });
  const { WorkflowEventDetailPage } = await import('./WorkflowEventDetail');
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  const { EmptyState } = await import('@/components/ui/empty/EmptyState');
  const screen = await renderScreen(<WorkflowEventDetailPage eventKey="not-yet-read" />);
  try {
    expect(screen.findAllByType(EmptyState).filter(node => node.props.title === t('workflows.events.gone'))).toHaveLength(0);
    expect(screen.findByType(SurfaceStateCard).props.kind).toBe('loading');
    await act(async () => { page.resolve(); });
    await expect.poll(() => feed.getCurrent().retained).not.toBeNull();
    expect(screen.findByType(EmptyState).props.title).toBe(t('workflows.events.gone'));
    failed = true;
    await act(async () => { await feed.getCurrent().retry().catch(() => {}); });
    await expect.poll(() => feed.getCurrent().historyError).not.toBeNull();
    expect(feed.getCurrent().status).toBe('live');
    expect(screen.findAllByType(EmptyState).filter(node => node.props.title === t('workflows.events.gone'))).toHaveLength(0);
    const state = screen.findByType(SurfaceStateCard);
    expect(state.props.kind).toBe('error');
    failed = false;
    await act(async () => { await state.props.action.onPress(); });
    await expect.poll(() => feed.getCurrent().historyError).toBeNull();
    expect(feed.getCurrent().status).toBe('live');
    expect(screen.findByType(EmptyState).props.title).toBe(t('workflows.events.gone'));
  } finally {
    page.resolve();
  }
});
