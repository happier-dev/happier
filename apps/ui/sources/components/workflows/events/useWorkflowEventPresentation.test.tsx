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
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
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

it("names a Session's turn by its Agent and carries the Agent's mark (lab events:A)", async () => {
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const serverId = lifetime.scope.serverId;
  const row = createSessionFixture({ id: 'turn-session', metadata: { ...createSessionFixture().metadata!, flavor: 'claude' } });
  getStorage().setState((state) => ({ sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
    [serverId]: { ...state.sessionListRowsByServerId[serverId], [row.id]: row as unknown as SessionListRenderableSession } } }));
  const turn = { key: 'turn', kind: 'session', sessionId: row.id, event: 'turn_started', turnId: 'turn-1',
    sourceRevision: 1, occurredAt: 400, coverage: 'live' } as const satisfies WorkflowActivityFact;
  const hook = await renderHook(() => useWorkflowEventPresentation(turn, lifetime.scope));
  expect(hook.getCurrent()).toMatchObject({ agentId: 'claude',
    title: t('workflows.events.agentTurnStarted', { agent: resolveAgentCatalogTitle('claude') }) });
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
