import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';

import type { ActionExecutorDeps, ApprovalRequestV1 } from '@happier-dev/protocol';
import * as persistence from '@/persistence';

import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { createLocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';

// Socket.IO is the external transport boundary. The socket factory, managed
// supervisor, Account observer and approval coordinator all remain real.
const wire = vi.hoisted(() => {
  const sockets: Array<{ connected: boolean; listenerCount: () => number; wake: () => void }> = [];
  return { sockets, io: vi.fn(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    };
    const socket = {
      connected: false,
      io: { timeout() {}, on() {}, off() {} },
      on(event: string, listener: (...args: unknown[]) => void) {
        const group = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
        group.add(listener); listeners.set(event, group);
      },
      off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); },
      connect() { socket.connected = true; emit('connect'); },
      disconnect() { socket.connected = false; emit('disconnect', 'client disconnect'); },
      removeAllListeners() { listeners.clear(); },
      offAny() {},
      listenerCount: () => [...listeners.values()].reduce((total, group) => total + group.size, 0),
      wake: () => emit('connect'),
    };
    sockets.push(socket);
    return socket;
  }) };
});
vi.mock('socket.io-client', () => ({ io: wire.io }));

function createApprovalRequest(overrides: Partial<ApprovalRequestV1> = {}): ApprovalRequestV1 {
  return {
    v: 1,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'sess_1' },
    requestedSurface: 'agent',
    actionId: 'session.list',
    actionArgs: { limit: 10 },
    summary: 'Approve listing sessions',
    preview: { actionId: 'session.list', actionArgs: { limit: 10 } },
    ...overrides,
  } as ApprovalRequestV1;
}

async function expectPromiseStillPending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  expect(settled).toBe(false);
}

describe('createCliActionExecutorHarness', () => {
  beforeEach(() => { wire.sockets.length = 0; wire.io.mockClear(); });
  afterEach(() => vi.restoreAllMocks());
  it('observes requester-private recorded approval execution without treating approval alone as guest completion', async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
    const expectedOrigin = { actionId: 'session.spawn_new' as const, requestId: 'acquire-request', accountId: 'requester',
      serverIdentityId: 'srv_home', machineId: 'guest' };
    let request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'guest-home-profile', ...expectedOrigin, target: { kind: 'machine', machineId: 'guest' } },
      approval: { flow: 'deferred', result: 'none' }, actionId: 'session.spawn_new', actionArgs: {}, summary: 'Start guest Agent',
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
    });
    const result = { type: 'success', sessionId: 'real-child', disposition: 'created',
      executionTarget: { serverId: 'srv_home', machineId: 'guest' } };
    // Only the durable Artifact HTTP and Socket.IO transports are substituted;
    // Account mode/content parsing, subject matching and coordinator stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200,
        data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
      expect(url).toBe('https://requester-home.example/v1/artifacts/child-approval');
      return { status: 200, data: { id: 'child-approval', ownerAccountId: 'requester', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: request.updatedAtMs } };
    });
    const harness = createCliActionExecutorHarness({ token, credentials: { token, encryption: null }, sessionId: 'source',
      serverId: 'requester-home', serverHttpBaseUrl: 'https://requester-home.example', mode: 'plain', ctx: null });
    await expect(runWithServerHttpBaseUrl('https://requester-home.example', () => harness.deps.approvalsGet!({ artifactId: 'child-approval', serverId: null })))
      .resolves.toMatchObject({ v: 2, status: 'approved', executionOriginV1: expectedOrigin });
    const abort = new AbortController();
    const pending = harness.observeRecordedApprovalExecution({ artifactId: 'child-approval', expectedOrigin,
      signal: abort.signal, isCurrent: async () => true });
    try {
      const first = await Promise.race([pending.then(result => ({ settled: true, result })),
        new Promise<{ settled: false }>(resolve => setTimeout(() => resolve({ settled: false }), 20))]);
      expect(first, JSON.stringify(first)).toEqual({ settled: false });
      expect(wire.sockets.some(socket => socket.connected)).toBe(true);
      request = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 3,
        execution: { executedAtMs: 3, ok: true, result } });
      for (const socket of wire.sockets) socket.wake();
      await expect(pending).resolves.toEqual({ ok: true, result });
      expect(wire.sockets.every(socket => !socket.connected && socket.listenerCount() === 0)).toBe(true);
      await expect(harness.observeRecordedApprovalExecution({ artifactId: 'child-approval',
        expectedOrigin: { ...expectedOrigin, machineId: 'another-guest' }, signal: abort.signal, isCurrent: async () => true }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
    }
  });
  it('routes admitted CLI service Stop through the exact receiving Machine Action and consumes its native refusal', async () => {
    const machineId = 'exact-service-worker';
    const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
      status: 'ready', features: FeaturesResponseSchema.parse({ features: { localServices: {
        enabled: true, inventory: { enabled: true }, actions: { enabled: true }, managed: { enabled: true },
      } }, capabilities: {} }),
    }) });
    await gate.refresh();
    expect(gate.isEnabled('localServices.actions')).toBe(true);
    const routes = createLocalServiceActionRoutes({ machineId, inventoryRegistry: createLocalServiceInventoryRegistry() });
    const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger() {} });
    registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId, localServicesActions: routes,
      resolveLauncherActionExecutor: ({ ingress }) => createActionExecutor({
        runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate, ingress,
          routes: { actionRoutes: routes } }),
      }),
    });
    const received: Array<Readonly<{ method: string; request: unknown }>> = [];
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'service-home', serverHttpBaseUrl: 'https://service-home.invalid',
      machineActionDirectTargetTransport: { machineId,
        // A distinct receiving Machine is the transport boundary; its Action policy,
        // schemas, control routing and native-binding refusal all remain real.
        invoke: async (method, request, options) => {
          received.push({ method, request });
          return await rpc.invokeLocal(method, request, options);
        },
      },
    });
    const request = { requestId: 'cli-exact-service-stop', action: 'stop_managed' as const, force: false,
      target: { kind: 'managed_service' as const, machineId, managedServiceId: 'unavailable-native-instance' } };
    const confirmed = { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) };
    const result = await harness.deps.runtimeActionExecute!({ actionId: 'localServices.actions.stopManaged', input: confirmed,
      context: { serverId: 'service-home', authority: 'account_automation' } });
    expect(result).toMatchObject({ status: 'denied', reasonCode: 'unknown_managed_service' });
    await expect(harness.deps.runtimeActionExecute!({ actionId: 'localServices.actions.stopManaged', input: confirmed,
      context: { serverId: 'other-home', authority: 'account_automation' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    await expect(harness.deps.runtimeActionExecute!({ actionId: 'localServices.actions.stopManaged',
      input: { ...confirmed, action: 'restart_managed' },
      context: { serverId: 'service-home', authority: 'account_automation' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(received).toEqual([{ method: RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_STOP_MANAGED,
      request: { v: 1, kind: 'targeted_action_rpc', input: confirmed, target: { kind: 'machine', machineId } } }]);
  });
  it('places default browser actions on the authenticated daemon and consumes its result', async () => {
    // Daemon discovery reads the filesystem, and fetch crosses the local HTTP boundary.
    const state = vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({
      pid: 123, httpPort: 12345, controlToken: 'browser-control-token',
      startedAt: 1, startedWithCliVersion: '0.3.0',
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      result: { v: 1, machineId: 'machine_browser', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] },
    }), { status: 200 }));
    const harness = createCliActionExecutorHarness({
      token: 'token', sessionId: 'session_browser', mode: 'plain', ctx: null,
    });
    try {
      const result = await harness.executor.execute('browser.diagnostics.snapshot', {
        browserSessionId: 'session_browser', viewId: 'view_browser',
      }, { surface: 'agent', defaultSessionId: 'session_browser' });
      expect(result).toEqual({ ok: true, result: {
        v: 1, machineId: 'machine_browser', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [],
      } });
    } finally {
      fetch.mockRestore();
      state.mockRestore();
    }
  });

  it('lets callers override action approval policy for a specific runtime surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_1' }));
    const sessionStateFieldSet = vi.fn(async () => ({ ok: true, sessionId: 'sess_1', title: 'Updated' }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        serverId: 'server-1',
        serverHttpBaseUrl: 'https://server-1.example.test',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsCreate,
        sessionStateFieldSet,
        isActionApprovalRequired: (id, ctx) => id === 'session.title.set' && ctx.surface === 'agent',
      },
    );

    const result = await harness.executor.execute(
      'session.title.set',
      { sessionId: 'sess_1', title: 'Updated' },
      { surface: 'agent', defaultSessionId: 'sess_1', actionRequestId: 'request-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval_1',
        actionId: 'session.title.set',
      },
    });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
  });

  it('installs a fail-closed runtime action executor bridge', async () => {
    const harness = createCliActionExecutorHarness({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'e2ee',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
    });

    expect(harness.deps.runtimeActionExecute).toBeDefined();
    await expect(harness.deps.runtimeActionExecute?.({
      actionId: 'devices.simulator.input.tap',
      input: {},
      context: {},
    })).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:devices.simulator:runtime_family_unimplemented',
    });
  });

  it('wires blocking approval waiters to rejection artifact updates', async () => {
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        serverHttpBaseUrl: 'https://approval-home.example.test',
        serverId: 'approval-home',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsUpdate,
      },
    );

    const waitForDecision = harness.deps.approvalsWaitForDecision;
    expect(waitForDecision).toBeDefined();
    if (!waitForDecision) throw new Error('expected approvalsWaitForDecision');

    const abort = new AbortController();
    const pending = waitForDecision({
      artifactId: 'approval_1',
      request: createApprovalRequest(),
      signal: abort.signal,
    });
    try {
      await harness.deps.approvalsUpdate?.({
        artifactId: 'approval_1',
        request: createApprovalRequest({
          status: 'rejected',
          decision: { kind: 'reject', decidedAtMs: 2 },
        }),
        serverId: null,
      });
      await expect(pending).resolves.toMatchObject({ decision: 'reject' });
      expect(approvalsUpdate).toHaveBeenCalledTimes(1);
      expect(wire.sockets.every((socket) => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
    }
  });

  it('keeps approved blocking waiters claimed by the explicit approval decision seam', async () => {
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        serverHttpBaseUrl: 'https://approval-home.example.test',
        serverId: 'approval-home',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsUpdate,
      },
    );

    const waitForDecision = harness.deps.approvalsWaitForDecision;
    const resolveBlockingDecision: ActionExecutorDeps['approvalsResolveBlockingDecision'] =
      harness.deps.approvalsResolveBlockingDecision;
    expect(waitForDecision).toBeDefined();
    expect(resolveBlockingDecision).toBeDefined();
    if (!waitForDecision || !resolveBlockingDecision) {
      throw new Error('expected blocking approval hooks');
    }

    const abort = new AbortController();
    const pending = waitForDecision({
      artifactId: 'approval_approved_1',
      request: createApprovalRequest(),
      signal: abort.signal,
    });
    try {
      const approvedRequest = createApprovalRequest({
        status: 'approved',
        decision: { kind: 'approve', decidedAtMs: 2 },
      });
      await harness.deps.approvalsUpdate?.({
        artifactId: 'approval_approved_1',
        request: approvedRequest,
        serverId: null,
      });
      await expectPromiseStillPending(pending);
      await expect(resolveBlockingDecision({
        artifactId: 'approval_approved_1',
        decision: 'approve',
        decisionAuthority: 'present_user',
        request: approvedRequest,
        serverId: null,
      })).resolves.toEqual({ resolved: true });
      await expect(pending).resolves.toMatchObject({ decision: 'approve' });
      expect(wire.sockets.every((socket) => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
    }
  });
});
