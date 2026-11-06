import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { observeManagedChildApprovalExecution } from '@/api/managedChildApproval';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';

import type { ActionExecutorDeps, ApprovalRequestV1 } from '@happier-dev/protocol';
import * as persistence from '@/persistence';

import { consumeDeferredCliApprovalResult, createCliActionExecutorHarness } from './createCliActionExecutorHarness';
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
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from './widgetApproval.testkit';

// Socket.IO is the external transport boundary. The socket factory, managed
// supervisor, Account observer and approval coordinator all remain real.
const wire = vi.hoisted(() => {
  const sockets: Array<{ connected: boolean; listenerCount: () => number; wake: () => void; update: (body: unknown) => void }> = [];
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
      update: (body: unknown) => emit('update', { id: 'approval-change', seq: 1, createdAt: 2, body }),
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
  it('returns the same-host live result when its recorded receipt arrives before the decision callback', async () => {
    const home = 'https://approval-home.example.test';
    const app = fastify();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: home });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const features = registerAccountHomeHttp(app, { accountId: 'owner', serverId: 'srv_home' });
    const featureHttp = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(features));
    const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
      machineId: 'machine', serverId: 'home', serverApiUrl: home,
      // This is the OS/installation identity boundary; currentness logic stays real.
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'srv_home' }) });
    const actionId = 'connectedServices.authentication.beginConnect';
    const input = { service: { pluginId: 'example.accounts', localId: 'service' }, modeId: 'oauth' };
    const live = { status: 'awaitingOAuth', attemptId: 'attempt', callbackUrl: 'https://callback.example.test/',
      authorizationUrl: 'https://authorize.example.test/' };
    let request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs: input, summary: 'Connect',
      approval: { flow: 'deferred', result: 'required' },
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'srv_home', accountId: 'owner', machineId: 'machine', actionId, requestId: 'connect-request' } });
    let releaseDecision!: () => void;
    const heldDecision = new Promise<void>(resolve => { releaseDecision = resolve; });
    let receiptRead = false;
    let effects = 0;
    let reportDecision!: (result: import('@happier-dev/protocol').ActionExecuteResult) => void;
    const decided = new Promise<import('@happier-dev/protocol').ActionExecuteResult>(resolve => { reportDecision = resolve; });
    const context = { surface: 'cli' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'owner' };
    const harness = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: 'srv_home', serverHttpBaseUrl: home }, { ...createUnavailableActionTransportDeps(),
      isApprovalExecutionOriginCurrent: currentness,
      // Artifact persistence and the native authentication transport are boundaries.
      approvalsGet: async () => { if (request.status === 'executed') receiptRead = true; return request; },
      approvalsUpdate: async args => {
        request = ApprovalRequestV2Schema.parse(args.request);
        for (const socket of wire.sockets) socket.update({ t: 'account-change' });
        return { ok: true };
      },
      connectedServiceAction: async () => { effects++; return live; },
    });
    const result = consumeDeferredCliApprovalResult({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'connect', actionId,
    } }, { onApprovalRequested: async (_id, _signal, decide) => {
      const decision = await decide('approve');
      reportDecision(decision);
      await heldDecision;
      return decision;
    }, execute: harness.executor.execute, token: credentials.token, serverHttpBaseUrl: home, context });
    void result.catch(() => undefined);
    try {
      const decision = await decided;
      expect(decision.ok ? 'ok' : decision.errorCode).toBe('ok');
      expect(decision).toMatchObject({ ok: true, result: { liveExecution: { ok: true, result: live } } });
      await vi.waitFor(() => expect(receiptRead).toBe(true));
      releaseDecision();
      expect(await result).toEqual({ ok: true, result: live });
      const collected = await consumeDeferredCliApprovalResult({ ok: true, result: {
        kind: 'approval_request_created', artifactId: 'connect', actionId,
      } }, { onApprovalRequested: (_id, signal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }), execute: harness.executor.execute, token: credentials.token, serverHttpBaseUrl: home, context });
      expect(collected).toMatchObject({ ok: false, errorCode: 'approval_result_held' });
      expect(effects).toBe(1);
      expect(JSON.stringify(request)).not.toContain(live.authorizationUrl);
    } finally { releaseDecision(); await result.catch(() => undefined); restoreHttp(); featureHttp.mockRestore(); await app.close(); }
  });

  it.each(['live', 'recorded', 'notification', 'refused', 'rejected'] as const)(
    'consumes one forwarded approval without resubmitting its Action (%s)', async delivery => {
      const pending = { kind: 'approval_request_created', artifactId: 'forwarded-approval', actionId: 'browser.diagnostics.snapshot' };
      const receipt = { v: 1, machineId: 'machine', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] };
      const failure = { ok: false as const, errorCode: 'approval_rejected', error: 'approval_rejected' };
      const notification = vi.fn(async () => delivery === 'notification' ? undefined
        : delivery === 'refused' ? failure
          : { ok: true as const, result: { ok: true, status: delivery === 'rejected' ? 'rejected' : 'executed',
            ...(delivery === 'live' ? { liveExecution: { ok: true, result: receipt } } : {}) } });
      // The installed browser adapter is an OS/daemon transport boundary.
      const native = vi.fn(async () => pending);
      const read = vi.fn(async () => ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: pending.actionId,
        actionArgs: { browserSessionId: 'session', viewId: 'view' }, summary: 'Browser diagnostics',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
          serverId: 'home', actionId: pending.actionId, requestId: 'browser-request' },
        status: delivery === 'rejected' ? 'rejected' : 'executed',
        decision: { kind: delivery === 'rejected' ? 'reject' : 'approve', decidedAtMs: 2 },
        ...(delivery === 'rejected' ? {} : { execution: { ok: true, effectAttempted: true, executedAtMs: 2, result: receipt } }) }));
      const { executor } = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
        onApprovalRequested: notification }, { ...createUnavailableActionTransportDeps(),
        runtimeActionExecute: native, approvalsGet: read });
      expect(await executor.execute('browser.diagnostics.snapshot', { browserSessionId: 'session', viewId: 'view' },
        { surface: 'cli' })).toEqual(delivery === 'notification' ? { ok: true, result: pending }
          : delivery === 'refused' || delivery === 'rejected' ? failure : { ok: true, result: receipt });
      expect(notification).toHaveBeenCalledOnce();
      expect(native).toHaveBeenCalledOnce();
      expect(wire.sockets.every(socket => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    });

  it.each(['rejected', 'executed'] as const)('closes an open deferred approval prompt after a remote %s decision', async status => {
    const artifactId = 'remote-deferred-approval';
    const receipt = { v: 1, machineId: 'machine', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] };
    let request = ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'browser.diagnostics.snapshot',
      actionArgs: { browserSessionId: 'session', viewId: 'view' }, summary: 'Browser diagnostics',
      approval: { flow: 'deferred', result: 'required' }, status: 'open',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', actionId: 'browser.diagnostics.snapshot', requestId: 'browser-request' } });
    const lifetime = new AbortController();
    let promptSignal: AbortSignal | undefined;
    // Artifact persistence and Socket.IO are boundaries; the waiting coordinator
    // and receipt projection stay real while the terminal prompt remains open.
    const native = vi.fn(async () => ({ kind: 'approval_request_created', artifactId, actionId: request.actionId }));
    const read = vi.fn(async () => request);
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://approval-home.example.test',
      onApprovalRequested: (_id, signal) => new Promise<never>((_resolve, reject) => {
        promptSignal = signal;
        signal.addEventListener('abort', () => reject(new Error('prompt closed')), { once: true });
      }) }, { ...createUnavailableActionTransportDeps(), runtimeActionExecute: native, approvalsGet: read });
    const pending = harness.executor.execute('browser.diagnostics.snapshot', { browserSessionId: 'session', viewId: 'view' },
      { surface: 'cli', signal: lifetime.signal });
    try {
      await vi.waitFor(() => expect(promptSignal).toBeDefined());
      await vi.waitFor(() => expect(wire.sockets.length).toBeGreaterThan(0));
      // A generic Artifact write is history, not authenticated consent or an
      // execution receipt. It cannot close the prompt or execute the Action.
      request = ApprovalRequestV2Schema.parse({ ...request, status: 'approved',
        decision: { kind: 'approve', decidedAtMs: 2 } });
      const readsBeforeApproval = read.mock.calls.length;
      for (const socket of wire.sockets) socket.update({ t: 'account-change' });
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(readsBeforeApproval));
      expect(promptSignal?.aborted).toBe(false);
      expect(native).toHaveBeenCalledOnce();
      request = ApprovalRequestV2Schema.parse({ ...request, status, updatedAtMs: 2,
        decision: { kind: status === 'rejected' ? 'reject' : 'approve', decidedAtMs: 2 },
        ...(status === 'executed' ? { execution: { ok: true, effectAttempted: true, executedAtMs: 2, result: receipt } } : {}) });
      for (const socket of wire.sockets) socket.update({ t: 'account-change' });
      await vi.waitFor(() => expect(promptSignal?.aborted).toBe(true));
      await expect(pending).resolves.toEqual(status === 'rejected'
        ? { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' }
        : { ok: true, result: receipt });
      expect(native).toHaveBeenCalledOnce();
      expect(wire.sockets.every(socket => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    } finally {
      lifetime.abort();
      await pending.catch(() => undefined);
    }
  });
  beforeEach(() => { wire.sockets.length = 0; wire.io.mockClear(); });
  afterEach(() => vi.restoreAllMocks());
  it.each(['update', 'reconnect'] as const)('delivers an independently persisted PDF rejection to the Agent MCP caller on %s', async wake => {
    let request: ReturnType<typeof ApprovalRequestV2Schema.parse> | null = null;
    const lifetime = new AbortController();
    // Only Artifact persistence and Socket.IO are substituted. The native Action,
    // approval waiter, Account invalidation, tool bridge and MCP codec stay real.
    const harness = createCliActionExecutorHarness({ token: 'session-token', credentials: { token: 'account-token', encryption: null }, sessionId: 'pdf-agent',
      serverId: 'pdf-home', serverHttpBaseUrl: 'https://pdf-home.test', mode: 'plain', ctx: null,
    }, {
      approvalsCreate: async args => { request = ApprovalRequestV2Schema.parse(args.request); return { artifactId: 'pdf-approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async args => { request = ApprovalRequestV2Schema.parse(args.request); return { ok: true }; },
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor: harness.executor,
      defaultSessionMachineId: 'pdf-machine' });
    const server = new McpServer({ name: 'pdf-approval', version: '1' });
    const client = new Client({ name: 'agent', version: '1' });
    registerHappierMcpBuiltInTools(server, { sessionId: 'pdf-agent', surface: 'agent', deps: {
      ...bridge, changeTitle: async () => { throw new Error('Unexpected title change'); },
      resolveActionOptions: args => bridge.resolveActionOptions(args, 'pdf-agent'),
    } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let pending: ReturnType<typeof client.callTool> | undefined;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      pending = client.callTool({ name: 'action_execute', arguments: {
        actionId: 'artifact.publish_from_file', input: { path: 'QA84.pdf', mime: 'application/pdf' },
      } }, undefined, { signal: lifetime.signal });
      await vi.waitFor(() => expect(request).toMatchObject({ status: 'open', createdBy: { surface: 'agent', sessionId: 'pdf-agent' } }));
      await vi.waitFor(() => expect(wire.sockets.some(socket => socket.connected)).toBe(true));
      expect(wire.io).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        auth: expect.objectContaining({ clientType: 'user-scoped', token: 'account-token' }),
      }));
      // A different process writes the durable decision: do not use the local
      // harness update wrapper, which would hide a broken Account wake binding.
      request = ApprovalRequestV2Schema.parse({ ...ApprovalRequestV2Schema.parse(request), status: 'rejected', updatedAtMs: 2,
        decision: { kind: 'reject', decidedAtMs: 2 } });
      for (const socket of wire.sockets) {
        if (wake === 'update') socket.update({ t: 'account-change' });
        else socket.wake();
      }
      const result = await pending;
      expect(result.isError).toBe(true);
      const content = result.content;
      if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected typed MCP text');
      expect(JSON.parse(content[0].text)).toMatchObject({ errorCode: 'approval_rejected' });
      expect(wire.sockets.every(socket => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    } finally {
      lifetime.abort();
      await pending?.catch(() => undefined);
      await client.close();
      await server.close();
    }
  });
  it('resolves admitted UI audience confirmation against live harness policy', () => {
    const actionId = 'widgets.item.move';
    let settings = normalizeActionsSettingsV1({ v: 1 });
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'source', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => settings } });
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const input = { ref: { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } }, instanceId: 'movable' },
      to: { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'corePage', pageId: 'usage', area: 'main' } }, index: 0 } };
    const requiresApproval = () => harness.deps.isActionApprovalRequired!(actionId, context, input, true);
    expect(requiresApproval()).toBe(true);
    expect(harness.deps.isActionApprovalRequired!(actionId, context, { ...input,
      to: { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'another-audience' } }, index: 0 },
    })).toBe(true);
    settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    expect(requiresApproval()).toBe(false);
    settings = normalizeActionsSettingsV1({ ...settings, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(requiresApproval()).toBe(true);
  });

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
  it.each([{ mode: 'plain', winner: null }, { mode: 'e2ee', winner: null },
    { mode: 'e2ee', winner: 'approved' }, { mode: 'e2ee', winner: 'executing' }] as const)(
    'withdraws an open guest approval when its containing operation is cancelled, preserving a claimed decision ($mode, $winner)', async ({ mode, winner }) => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
      : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    const expectedOrigin = { actionId: 'machines.agentIsolation.set', requestId: 'child-request', accountId: 'requester',
      serverIdentityId: 'srv_home', machineId: 'guest' };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, requestedSurface: 'ui',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
        serverId: 'guest-home-profile', ...expectedOrigin, target: { kind: 'machine', machineId: 'guest' } },
      approval: { flow: 'deferred', result: 'required' }, actionId: expectedOrigin.actionId,
      actionArgs: { serverId: 'srv_home', machineId: 'guest', enabled: true }, summary: 'Change Agent isolation' });
    let record = { id: 'cancel-child-approval', ownerAccountId: 'requester', access: 'owner', encryptionMode: mode,
      publicAudience: 'none', header: encode(buildApprovalRequestArtifactHeaderV1(request)),
      body: encode({ body: JSON.stringify(request) }),
      dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    let held!: () => void;
    const waiting = new Promise<void>(resolve => { held = resolve; });
    // Home HTTP and Socket.IO are the only substituted boundaries. The operation
    // runner, observer, coordinator, encryption and approval transition stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200,
        data: AccountEncryptionModeResponseSchema.parse({ mode, updatedAt: 1 }) };
      if (wire.sockets.some(socket => socket.connected)) held();
      return { status: 200, data: record };
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (_url, raw) => {
      const mutation = ArtifactJsonUpdateHttpInputV1Schema.parse(raw);
      expect(mutation.expectedHeaderVersion).toBe(record.headerVersion);
      expect(mutation.expectedBodyVersion).toBe(record.bodyVersion);
      record = { ...record, header: mutation.header ?? record.header, body: mutation.body ?? record.body,
        headerVersion: record.headerVersion + 1, bodyVersion: record.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: record.headerVersion, bodyVersion: record.bodyVersion } };
    });
    const harness = createCliActionExecutorHarness({ token, credentials, sessionId: 'source',
      serverId: 'requester-home', serverHttpBaseUrl: 'https://requester-home.example',
      ...(mode === 'plain' ? { mode: 'plain', ctx: null }
        : { mode: 'e2ee', ctx: { encryptionKey: new Uint8Array(32).fill(17), encryptionVariant: 'legacy' } }) });
    const operations = createHostActionOperationRuntime({ serverId: 'requester-home', machineId: 'controller',
      resolveAccountId: async () => 'requester', generateOperationId: () => 'cancel-bootstrap' });
    const scope = { accountId: 'requester', machineId: 'controller' };
    const pending = operations.runActionOperation({ actionId: 'machines.managed.bootstrap.retry', input: { managedId: 'guest' }, context: {},
      execute: context => observeManagedChildApprovalExecution({ context, signal: context.signal, expectedOrigin,
        isCurrent: async () => true, observeRecordedApprovalExecution: harness.observeRecordedApprovalExecution,
        execution: { ok: true, result: { kind: 'approval_request_created', artifactId: record.id, actionId: expectedOrigin.actionId } } }) });
    await Promise.race([waiting, pending.then(result => { throw new Error(`Operation settled before approval wait: ${JSON.stringify(result)}`); })]);
    if (winner) {
      const claimed = ApprovalRequestV2Schema.parse({ ...request, status: winner, updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
      record = { ...record, header: encode(buildApprovalRequestArtifactHeaderV1(claimed)),
        body: encode({ body: JSON.stringify(claimed) }), headerVersion: 2, bodyVersion: 2 };
    }
    expect(await operations.handlers.cancel({ operationId: 'cancel-bootstrap' })).toEqual({ kind: 'requested' });
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(operations.store.get(scope, 'cancel-bootstrap')?.state).toBe('cancelled');
    const observed = await runWithServerHttpBaseUrl('https://requester-home.example', () =>
      harness.deps.approvalsGet!({ artifactId: record.id, serverId: null }));
    expect(observed).toMatchObject({ status: winner ?? 'canceled' });
    expect(writes).toHaveBeenCalledTimes(winner ? 0 : 1);
    expect(wire.sockets.every(socket => !socket.connected && socket.listenerCount() === 0)).toBe(true);
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
      resolveLauncherActionExecutor: ({ ingress }) => createActionExecutor({ ...createUnavailableActionTransportDeps(),
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
  it.each(['agent', 'cli'] as const)('places default browser diagnostics on the authenticated daemon through %s and consumes its result', async (surface) => {
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
      }, { surface, defaultSessionId: 'session_browser' });
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
