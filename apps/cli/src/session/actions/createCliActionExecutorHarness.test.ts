import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalProfileV1Schema } from '@happier-dev/protocol/actions/approvalProfiles';
import { DeploymentReceiptAcceptedResultV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptResultV1';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { observeManagedChildApprovalExecution } from '@/api/managedChildApproval';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { requesterAccountEncryptionMode } from '@/daemon/sessionEncryption/requesterAccountActionContext';

import type { ActionExecutorDeps, ApprovalRequestV1, ApprovalRequestV2 } from '@happier-dev/protocol';
import * as persistence from '@/persistence';

import { consumeDeferredCliApprovalResult, createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createCliApprovalsArtifactStore } from './approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
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
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
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

it('observes a deferred plugin Action execution after approval without replaying it', async () => {
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
  const origin = { v: 1, authority: 'account_automation', surface: 'agent', serverId: 'home',
    serverIdentityId: 'home', accountId: 'account', machineId: 'machine', actionId: 'action.invoke',
    requestId: 'run/invocation/0', caller: { kind: 'host' } };
  let request = TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
    createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent', summary: 'Send',
    qualifiedActionId: 'example.channel/actions/send', input: {}, secretInputPaths: [],
    sourceCustody: { kind: 'development', registeredRootId: 'root' },
    policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), executionOriginV1: origin });
  let lastReadStatus: string | undefined;
  const harness = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
    mode: 'plain', ctx: null, sessionId: 'origin', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid' }, {
    approvalsGet: async () => { lastReadStatus = request.status; return request; },
  });
  const abort = new AbortController();
  const pending = harness.observeRecordedApprovalExecution({ artifactId: 'plugin-approval', signal: abort.signal,
    expectedOrigin: { actionId: 'action.invoke', requestId: 'run/invocation/0', accountId: 'account',
      serverIdentityId: 'home', machineId: 'machine' } });
  try {
    await vi.waitFor(() => expect(wire.sockets.some(socket => socket.connected)).toBe(true));
    request = TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'approved',
      decision: { kind: 'approve', decidedAtMs: 2 } });
    for (const socket of wire.sockets) socket.update({ t: 'update-artifact', artifactId: 'plugin-approval' });
    await vi.waitFor(() => expect(lastReadStatus).toBe('approved'));
    request = TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'executed', updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: true, effectAttempted: true, result: { delivered: true } } });
    for (const socket of wire.sockets) socket.update({ t: 'update-artifact', artifactId: 'plugin-approval' });
    expect(await pending).toEqual({ ok: true, result: { delivered: true } });
  } finally { abort.abort(); await pending; wire.sockets.length = 0; }
});

it.each(['live', 'recorded', 'rejected', 'native'] as const)('finishes an approval-gated Workflow Action without Resume (%s)', async mode => {
  const actionId = mode === 'native' ? 'review.walkthrough' : 'machines.list';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
  let request: ApprovalRequestV2 | undefined;
  let lastReadStatus: string | undefined;
  let effects = 0;
  const harness = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
    mode: 'plain', ctx: null, sessionId: 'origin', serverId: 'home', serverIdentityId: 'home',
    serverHttpBaseUrl: 'https://home.invalid',
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } }),
      getAccountSettings: () => accountSettingsParse({}) } }, {
    approvalsCreate: async ({ request: value }) => {
      request = ApprovalRequestV2Schema.parse(value);
      if (mode === 'recorded') request = ApprovalRequestV2Schema.parse({ ...request, status: 'executed',
        decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true, result: { items: [] } } });
      return { artifactId: 'workflow-approval' };
    },
    approvalsGet: async () => { lastReadStatus = request?.status; return request ?? null; },
    machinesList: async () => { effects++; return { items: [] }; },
  });
  const store = createInMemoryWorkflowCoordinatorStore();
  const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
  const abort = new AbortController();
  const coordinator = createTestWorkflowCoordinator({ store,
    executeStep: async () => { throw new Error('Unexpected Agent step'); },
    resolveWorkspace: async () => ({ ok: true, workspace }),
    action: { executor: harness.executor,
      buildContext: async input => ({ ...buildWorkflowActionContext(input), serverId: 'home', serverIdentityId: 'home',
        runtimeAccountId: 'account', defaultSessionId: 'origin', defaultSessionMachineId: workspace.machineId,
        approvalProfileId: 'builtin:read-propose' }),
      observeApproval: async ({ artifactId, actionRequestId, actionId, signal }) => harness.observeRecordedApprovalExecution({
        artifactId, signal, expectedOrigin: { actionId: actionId ?? 'discussion.invite', requestId: actionRequestId,
          accountId: 'account', serverIdentityId: 'home', machineId: 'machine' } }),
      // Native execution observation is a transport boundary. F18 must retain
      // the approved launch and consume its terminal evidence, not the receipt.
      observeRun: async run => {
        expect(run.runId).toBe('narrator');
        expect(store.list().find(row => row.blockId === 'list')).toMatchObject({ lifecycle: 'running',
          execution: { awaitedRuns: [{ runId: 'narrator' }] } });
        return { kind: 'completed', result: { value: 'terminal' } };
      } },
  });
  const pending = coordinator.run({ runId: 'approval-push-run',
    definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'list', actionId, input: mode === 'native' ? {
      sessionId: { kind: 'literal', value: 'origin' }, runId: { kind: 'literal', value: 'review' },
      comparisonId: { kind: 'literal', value: 'comparison' },
    } : {} }] },
    inputs: {}, executionTarget: { kind: 'session' }, originSessionId: 'origin', signal: abort.signal,
    origin: { kind: 'direct', originSessionId: 'origin', authenticatedStarterV1: {
      requestRef: 'start-request', requester: { serverId: 'home', accountId: 'account' } } },
    authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
  try {
    if (mode !== 'recorded') {
      await vi.waitFor(() => {
        const row = store.list().find(row => row.blockId === 'list');
        expect(row?.lifecycle, row?.reason).toBe('waiting_for_approval');
      });
      if (!request) throw new Error('Missing approval');
      await vi.waitFor(() => expect(wire.sockets.some(socket => socket.connected)).toBe(true));
      // The separate approval executor has delivered its effect. Approval alone
      // remains nonterminal; the Artifact push publishes the execution afterwards.
      request = ApprovalRequestV2Schema.parse({ ...request, status: 'approved',
        decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 } });
      for (const socket of wire.sockets) socket.update({ t: 'update-artifact', artifactId: 'workflow-approval' });
      await vi.waitFor(() => expect(lastReadStatus).toBe('approved'));
      expect(store.list().find(row => row.blockId === 'list')?.lifecycle).toBe('waiting_for_approval');
      const output = mode === 'native' ? { runId: 'narrator', comparisonId: 'comparison' } : { items: [] };
      request = ApprovalRequestV2Schema.parse(mode === 'rejected' ? { ...request, status: 'rejected',
        decision: { kind: 'reject', authority: 'present_user', decidedAtMs: 3 } }
        : { ...request, status: 'executed', execution: { executedAtMs: 3, ok: true, result: output } });
      for (const socket of wire.sockets) socket.update({ t: 'update-artifact', artifactId: 'workflow-approval' });
    }
    expect(await pending).toMatchObject(mode === 'rejected' ? { state: 'interrupted', reason: 'approval_rejected' } : { state: 'succeeded' });
    expect(store.list().find(row => row.blockId === 'list')).toMatchObject(mode === 'rejected'
      ? { lifecycle: 'failed', reason: 'approval_rejected' }
      : { lifecycle: 'completed', result: mode === 'native'
        ? { narration: { runId: 'narrator', outcome: 'completed', result: { value: 'terminal' } } } : { items: [] } });
    expect(effects).toBe(0); // Observing approval never dispatches the effect again.
  } finally { abort.abort(); await pending; wire.sockets.length = 0; }
});

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
  it('projects accepted context only from the exact bound Session without guessing a Project', async () => {
    let projectReads = 0;
    let projectKey: string | null = 'accepted-project';
    const { deps } = createCliActionExecutorHarness({ token: 'fixture-token', sessionId: 'bound-session',
      mode: 'plain', ctx: null, serverId: 'home', serverIdentityId: 'home',
      getCurrentSessionMetadata: () => ({ machineId: 'bound-machine', path: '/work', id: 'incidental-project' }),
      getCurrentSessionProjectKey: () => { projectReads++; return projectKey; },
    });
    expect(projectReads).toBe(0);
    expect(await deps.prepareApprovalExecutionOriginContext?.({ targetSessionId: 'bound-session' }))
      .toMatchObject({ automationSubjects: [{ role: 'context', subject: {
        kind: 'machine', serverId: 'home', machineId: 'bound-machine',
      } }, { role: 'context', subject: { kind: 'project', serverId: 'home', projectKey: 'accepted-project' } }] });
    expect(await deps.prepareApprovalExecutionOriginContext?.({ targetSessionId: 'other-session' }))
      .not.toHaveProperty('automationSubjects');
    expect(await deps.prepareApprovalExecutionOriginContext?.({ targetSessionId: null }))
      .not.toHaveProperty('automationSubjects');
    expect(projectReads).toBe(1);
    const admitted = await deps.prepareApprovalExecutionOriginContext?.({ targetSessionId: 'bound-session' });
    projectKey = null;
    expect((await deps.prepareApprovalExecutionOriginContext?.({ targetSessionId: 'bound-session' }))?.automationSubjects)
      .toEqual([{ role: 'context', subject: { kind: 'machine', serverId: 'home', machineId: 'bound-machine' } }]);
    expect(admitted?.automationSubjects).toContainEqual({ role: 'context',
      subject: { kind: 'project', serverId: 'home', projectKey: 'accepted-project' } });
  });

  it.each(['authenticated', 'public'] as const)('records only an authenticated Home learned after Session harness creation (%s)', async provenance => {
    const serverId = 'stack_agent-qa-prs-issues__id_default';
    const serverIdentityId = 'srv_approval-home';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
      'session.list': { approvalRequiredSurfaces: ['agent'] },
    } });
    const retained: ApprovalRequestV2[] = [];
    let snapshot: import('@/features/serverFeaturesClient').CliServerFeaturesSnapshot | undefined;
    let observations = 0;
    const { executor } = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
      sessionId: 'source', mode: 'plain', ctx: null, serverId, serverHttpBaseUrl: 'https://approval-home.test',
      getCurrentSessionMetadata: () => ({ machineId: 'machine', path: '/work' }),
      actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse({}) },
      resolveServerFeaturesSnapshot: async () => { observations++; return snapshot; },
    }, {
      // Artifact persistence is the boundary; origin construction and policy stay real.
      approvalsCreate: async ({ request }) => {
        retained.push(ApprovalRequestV2Schema.parse(request));
        return { artifactId: `review-${retained.length}` };
      },
    });
    snapshot = { status: 'ready', provenance, features: FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId } },
    }) };
    for (let index = 0; index < 20; index++) {
      const result = await executor.execute('session.list', { limit: 10 }, {
        surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        defaultSessionId: 'source', defaultSessionMachineId: 'machine', actionRequestId: `request-${index}`,
        sessionListAccess: 'current_session',
      });
      expect(result, result.ok ? 'ok' : result.errorCode).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    }
    expect(retained).toHaveLength(20);
    expect(retained.map(request => request.executionOriginV1.serverId)).toEqual(Array(20).fill(serverId));
    expect(retained.map(request => request.executionOriginV1.serverIdentityId))
      .toEqual(Array(20).fill(provenance === 'authenticated' ? serverIdentityId : undefined));
    expect(retained.map(request => buildApprovalRequestArtifactHeaderV1(request).serverIdentityId))
      .toEqual(Array(20).fill(provenance === 'authenticated' ? serverIdentityId : undefined));
    expect(observations).toBe(20);
  });

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

  it.each(['live', 'recorded', 'late-recorded', 'notification', 'refused', 'rejected'] as const)(
    'consumes one forwarded approval without resubmitting its Action (%s)', async delivery => {
      const pending = { kind: 'approval_request_created', artifactId: 'forwarded-approval', actionId: 'browser.diagnostics.snapshot' };
      const receipt = { v: 1, machineId: 'machine', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] };
      const failure = { ok: false as const, errorCode: 'approval_rejected', error: 'approval_rejected' };
      let releaseRead!: () => void;
      const initialRead = new Promise<void>(resolve => { releaseRead = resolve; });
      let completed = delivery !== 'late-recorded';
      const notification = vi.fn(async (_id: string, signal: AbortSignal) => {
        if (delivery === 'late-recorded') {
          await initialRead;
          await new Promise<void>(resolve => setImmediate(resolve));
          completed = true; // The deciding host persisted completion; its push is lost.
        }
        return delivery === 'notification' ? await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }) : delivery === 'refused' ? failure
          : { ok: true as const, result: { ok: true, status: delivery === 'rejected' ? 'rejected' : 'executed',
            ...(delivery === 'live' ? { liveExecution: { ok: true, result: receipt } } : {}) } };
      });
      // The installed browser adapter is an OS/daemon transport boundary.
      const native = vi.fn(async () => pending);
      const read = vi.fn(async () => {
        const terminal = completed;
        releaseRead();
        return ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: pending.actionId,
        actionArgs: { browserSessionId: 'session', viewId: 'view' }, summary: 'Browser diagnostics',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
          serverId: 'home', actionId: pending.actionId, requestId: 'browser-request' },
        status: !terminal ? 'open' : delivery === 'rejected' ? 'rejected' : 'executed',
        ...(terminal ? { decision: { kind: delivery === 'rejected' ? 'reject' : 'approve', decidedAtMs: 2 } } : {}),
        ...(!terminal || delivery === 'rejected' ? {} : { execution: { ok: true, effectAttempted: true, executedAtMs: 2, result: receipt } }) });
      });
      const { executor } = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
        onApprovalRequested: notification }, { ...createUnavailableActionTransportDeps(),
        runtimeActionExecute: native, approvalsGet: read });
      expect(await executor.execute('browser.diagnostics.snapshot', { browserSessionId: 'session', viewId: 'view' },
        { surface: 'cli' })).toEqual(delivery === 'refused' || delivery === 'rejected' ? failure : { ok: true, result: receipt });
      expect(notification).toHaveBeenCalledOnce();
      expect(native).toHaveBeenCalledOnce();
      expect(wire.sockets.every(socket => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    });

  it.each([200, 503])('waits for forwarded approval execution after an approved-only decision (initial Artifact HTTP %s)', async initialStatus => {
    const actionId = 'browser.diagnostics.snapshot';
    const artifactId = 'forwarded-held-execution';
    const receipt = { v: 1, machineId: 'machine', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] };
    let request = ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId,
      actionArgs: { browserSessionId: 'session', viewId: 'view' }, summary: 'Browser diagnostics',
      approval: { flow: 'blocking', result: 'required' }, status: 'approved',
      decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', actionId, requestId: 'browser-request' } });
    let notified = false;
    let read = false;
    let settled = false;
    const lifetime = new AbortController();
    const app = fastify();
    let status = initialStatus;
    let artifactReads = 0;
    app.get('/v1/artifacts/:id', async (_request, reply) => {
      read = true;
      artifactReads++;
      if (status !== 200) return reply.code(status).send({ error: 'temporarily_unavailable' });
      return ArtifactHttpReadV1Schema.parse({ id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'https://approval-home.example.test' });
    const store = createCliApprovalsArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    // Only HTTP, daemon transport and terminal presentation are replaced.
    // The Action executor, Artifact decoder and deferred waiter remain real.
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://approval-home.example.test',
      onApprovalRequested: async () => {
        notified = true;
        return { ok: true, result: { ok: true, artifactId, status: 'approved' } };
      } }, { ...createUnavailableActionTransportDeps(),
      approvalsGet: store.approvalsGet, runtimeActionExecute: async () => ({ kind: 'approval_request_created', artifactId, actionId }) });
    const pending = harness.executor.execute(actionId, { browserSessionId: 'session', viewId: 'view' },
      { surface: 'cli', signal: lifetime.signal });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(read || settled).toBe(true));
      if (!read) expect(await pending).toEqual({ ok: true, result: receipt });
      expect(notified).toBe(true);
      expect(settled ? await pending : null).toBeNull();
      expect(artifactReads).toBe(2);
      status = 200;
      request = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 3,
        execution: { ok: true, effectAttempted: true, executedAtMs: 3, result: receipt } });
      for (const socket of wire.sockets) socket.update({ t: 'account-change' });
      await expect(pending).resolves.toEqual({ ok: true, result: receipt });
      expect(artifactReads).toBe(3);
    } finally { lifetime.abort(); await pending.catch(() => undefined); restoreHttp(); await app.close(); }
  });

  it('returns the durable receipt and closes observation when the one-shot caller leaves approval to the app', async () => {
    const receipt = { kind: 'approval_request_created', artifactId: 'unattended-approval', actionId: 'browser.diagnostics.snapshot' };
    const request = ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: receipt.actionId,
      actionArgs: { browserSessionId: 'session', viewId: 'view' }, summary: 'Browser diagnostics',
      approval: { flow: 'deferred', result: 'required' }, status: 'open',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', actionId: receipt.actionId, requestId: 'browser-request' } });
    const lifetime = new AbortController();
    // The daemon returns a durable receipt and sends no subsequent event. The
    // terminal presenter prints it and returns without making an inline decision.
    const presentApproval = vi.fn<(artifactId: string) => void>();
    const { executor } = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://approval-home.example.test', onApprovalRequested: presentApproval,
    }, { ...createUnavailableActionTransportDeps(), runtimeActionExecute: async () => receipt, approvalsGet: async () => request });
    const pending = executor.execute(receipt.actionId, request.actionArgs, { surface: 'cli', signal: lifetime.signal });
    try {
      const settled = await Promise.race([pending, new Promise<void>(resolve => setImmediate(resolve))]);
      expect(presentApproval.mock.calls.map(call => call[0])).toEqual([receipt.artifactId]);
      expect(settled).toEqual({ ok: true, result: receipt });
      expect(wire.sockets.filter(socket => socket.connected || socket.listenerCount() > 0)).toEqual([]);
    } finally {
      lifetime.abort();
      await pending.catch(() => undefined);
    }
  });

  it.each(['rejected', 'executed'] as const)('waits after notification when the caller still wants a remote %s result', async status => {
    const artifactId = 'notification-only-deferred-approval';
    const receipt = { v: 1, machineId: 'machine', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] };
    let request = ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'browser.diagnostics.snapshot',
      actionArgs: { browserSessionId: 'session', viewId: 'view' }, summary: 'Browser diagnostics',
      approval: { flow: 'deferred', result: 'required' }, status: 'open',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', actionId: 'browser.diagnostics.snapshot', requestId: 'browser-request' } });
    const lifetime = new AbortController();
    let notify!: () => void;
    const notified = new Promise<void>(resolve => { notify = resolve; });
    const app = fastify();
    app.get('/v1/artifacts/:id', async () => ArtifactHttpReadV1Schema.parse({
      id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }));
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'https://approval-home.example.test' });
    const store = createCliApprovalsArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    // HTTP and daemon RPC are boundaries; the Artifact store and waiter remain real.
    const native = vi.fn(async () => ({ kind: 'approval_request_created', artifactId, actionId: request.actionId }));
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://approval-home.example.test', onApprovalRequested: (_id, signal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        notify();
      }) },
    { ...createUnavailableActionTransportDeps(), runtimeActionExecute: native, approvalsGet: store.approvalsGet });
    const pending = harness.executor.execute('browser.diagnostics.snapshot', { browserSessionId: 'session', viewId: 'view' },
      { surface: 'cli', signal: lifetime.signal });
    let settled = false;
    let settledResult: unknown;
    void pending.then(result => { settled = true; settledResult = result; }, error => { settled = true; settledResult = error; });
    try {
      await Promise.race([notified, pending.then(result => {
        throw new Error(`Action completed before approval notification: ${JSON.stringify(result)}`);
      })]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled, JSON.stringify(settledResult)).toBe(false);
      request = ApprovalRequestV2Schema.parse({ ...request, status, updatedAtMs: 2,
        decision: { kind: status === 'rejected' ? 'reject' : 'approve', decidedAtMs: 2 },
        ...(status === 'executed' ? { execution: { ok: true, effectAttempted: true, executedAtMs: 2, result: receipt } } : {}) });
      for (const socket of wire.sockets) socket.update({ t: 'account-change' });
      await expect(pending).resolves.toEqual(status === 'rejected'
        ? { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' }
        : { ok: true, result: receipt });
      expect(native).toHaveBeenCalledOnce();
    } finally { lifetime.abort(); await pending.catch(() => undefined); restoreHttp(); await app.close(); }
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

  it.each(['disabled', 'ask'] as const)('retains the host teardown restriction before controller dispatch (%s)', async restriction => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const settings = normalizeActionsSettingsV1({ v: 1, actions: { 'deployments.teardown': restriction === 'disabled'
      ? { enabled: false } : { approvalRequiredSurfaces: ['cli'] } } });
    const account = accountSettingsParse({ actionsSettingsV1: { v: 1,
      approvalWaivedSurfaces: { 'deployments.teardown': ['cli'] } } });
    // HTTP is the boundary. Host policy must settle before reading the
    // Environment or requesting a root under the weaker Account policy.
    const requests = vi.spyOn(axios, 'request').mockRejectedValue(new Error('Unexpected controller dispatch'));
    const posts = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected controller dispatch'));
    const { executor } = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
      mode: 'plain', ctx: null, sessionId: 'host', serverId: 'home', serverHttpBaseUrl: 'https://host-policy.test',
      actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => account } });
    expect(await executor.execute('deployments.teardown', { serverId: 'home', environmentId: 'environment',
      expectedRevision: 1, targetLinkId: 'target', expectedTargetLinkRevision: 1, requestKey: 'teardown', reason: 'manual' },
    { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'host-teardown' }))
      .toMatchObject({ ok: false, errorCode: restriction === 'disabled' ? 'action_disabled' : 'approval_context_unavailable' });
    expect(requests).not.toHaveBeenCalled();
    expect(posts).not.toHaveBeenCalled();
  });
  it.each([
    { profileEnabled: false, accountEnabled: true },
    { profileEnabled: true, accountEnabled: false },
  ])('uses bound profile availability in the CLI host (profile=$profileEnabled, Account=$accountEnabled)', async ({ profileEnabled, accountEnabled }) => {
    let effects = 0;
    const policy = normalizeActionsSettingsV1({ v: 1, actions: { 'deployments.deploy': { enabled: accountEnabled } },
      approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] } });
    const profile = ApprovalProfileV1Schema.parse({ id: 'picked', name: 'Picked',
      actions: { 'deployments.deploy': { enabled: profileEnabled } }, approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] } });
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
      targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const { executor } = createCliActionExecutorHarness({ token: 'token', sessionId: 'origin', mode: 'plain', ctx: null,
      serverId: 'home', actionsSettingsProvider: { getActionsSettings: () => policy, getApprovalProfiles: () => [{
        id: profile.id, profile, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 } }] },
    }, {
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' } }),
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      deploymentAction: async () => { effects++; return DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true,
        environmentId: 'environment', revision: 4, kind: 'pending', actionOperationId: 'operation' }); },
    });
    const result = await executor.execute('deployments.deploy', input, { surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'owner', approvalProfileId: 'picked', interactivePresentation: 'unavailable' });
    expect(result).toMatchObject(profileEnabled ? { ok: true } : { ok: false, errorCode: 'action_disabled' });
    expect(effects).toBe(profileEnabled ? 1 : 0);
  });

  it.each([
    { mode: 'allow', retainedOff: false, retainedRequire: false, currentRequire: false, retainedNull: false, held: false },
    { mode: 'require', retainedOff: false, retainedRequire: false, currentRequire: false, retainedNull: false, held: true },
    { mode: 'allow', retainedOff: false, retainedRequire: true, currentRequire: false, retainedNull: false, held: true },
    // A later Account Require still applies over the invitation's retained waiver.
    { mode: 'allow', retainedOff: false, retainedRequire: false, currentRequire: true, retainedNull: false, held: true },
    { mode: 'allow', retainedOff: false, retainedRequire: false, currentRequire: false, retainedNull: true, held: false },
    { mode: 'allow', retainedOff: false, retainedRequire: false, currentRequire: true, retainedNull: true, held: true },
    { mode: 'full_allow', retainedOff: true, retainedRequire: false, currentRequire: false, retainedNull: false, held: true },
    { mode: 'full_allow', retainedOff: false, retainedRequire: true, currentRequire: false, retainedNull: false, held: true },
  ] as const)('uses current approval profiles while retaining Workflow invitation restrictions ($mode, $retainedRequire, $currentRequire, null=$retainedNull)', async ({ mode, retainedOff, retainedRequire, currentRequire, retainedNull, held }) => {
    let effects = 0;
    let approval: ReturnType<typeof ApprovalRequestV2Schema.parse> | undefined;
    const waived = { 'discussion.invite': ['agent'] };
    const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: currentRequire ? {} : waived,
      ...(currentRequire ? { actions: { 'discussion.invite': { approvalRequiredSurfaces: ['agent'] } } } : {}) });
    const profileCatalog = [{ id: 'profile:current', profile: ApprovalProfileV1Schema.parse({ id: 'profile:current', name: 'Current',
      ...(mode === 'require' ? { actions: { 'discussion.invite': { approvalRequiredSurfaces: ['agent'] } } }
        : mode === 'full_allow' ? { actions: { 'discussion.invite': { enabled: true } }, approvalWaivedSurfaces: waived } : {}) }),
      access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } }];
    const { executor } = createCliActionExecutorHarness({ token: 'token', mode: 'plain', ctx: null,
      sessionId: 'origin', serverId: 'home', serverHttpBaseUrl: 'https://workflow-home.example.invalid',
      actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => null,
        getApprovalProfiles: () => profileCatalog },
    }, { ...createUnavailableActionTransportDeps(),
      // Discussion HTTP and approval Artifact persistence are external boundaries.
      discussionAction: async () => { effects++; return { discussionId: 'discussion', ownerAccountId: 'owner',
        access: 'owner', grants: [], changed: true }; },
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'review' }; },
    });
    const result = await executor.execute('discussion.invite', { discussionId: 'discussion', participant: { kind: 'model', participantSlotId: 'slot',
      launch: { executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } } }, {
      surface: 'agent', authority: 'account_automation', runtimeAccountId: 'owner', serverId: 'home',
      actionRequestId: 'invitation', defaultSessionId: 'origin', approvalProfileId: 'profile:current',
      actionsSettings: retainedNull ? null : normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: waived,
        actions: retainedOff ? { 'discussion.invite': { enabled: false } }
          : retainedRequire ? { 'discussion.invite': { approvalRequiredSurfaces: ['agent'] } } : {} }),
      actionCaller: { kind: 'workflowRun', runId: 'run', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        authenticatedStarterV1: { requestRef: 'start', requester: { serverId: 'home', accountId: 'owner' } },
        discussionModelReservation: { discussionId: 'discussion', participantSlotId: 'slot' } },
    });
    expect(result, JSON.stringify(result)).toMatchObject(retainedOff ? { ok: false, errorCode: 'action_disabled' }
      : { ok: true, result: held ? { kind: 'approval_request_created' } : { changed: true } });
    expect(effects).toBe(held ? 0 : 1);
    expect(approval?.actionId).toBe(held && !retainedOff ? 'discussion.invite' : undefined);
  });
  beforeEach(() => { wire.sockets.length = 0; wire.io.mockClear(); });
  afterEach(() => vi.restoreAllMocks());
  it.each(['update', 'reconnect'] as const)('delivers an independently persisted PDF rejection to the Agent MCP caller on %s', async wake => {
    let request: ReturnType<typeof ApprovalRequestV2Schema.parse> | null = null;
    const lifetime = new AbortController();
    const accountToken = `header.${Buffer.from(JSON.stringify({ sub: 'pdf-account', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    // Only Artifact persistence and Socket.IO are substituted. The native Action,
    // approval waiter, Account invalidation, tool bridge and MCP codec stay real.
    const harness = createCliActionExecutorHarness({ token: 'session-token', credentials: { token: accountToken, encryption: null }, sessionId: 'pdf-agent',
      serverId: 'pdf-home', serverHttpBaseUrl: 'https://pdf-home.test', mode: 'plain', ctx: null,
      getCurrentSessionMetadata: () => ({ machineId: 'pdf-machine' }),
    }, {
      hostActionApprovalLifetime: { actionId: 'artifact.publish_from_file', surface: 'agent', signal: lifetime.signal },
      approvalsCreate: async args => { request = ApprovalRequestV2Schema.parse(args.request); return { artifactId: 'pdf-approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async args => { request = ApprovalRequestV2Schema.parse(args.request); return { ok: true }; },
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor: {
      // This host retains the private file invocation for its containing operation.
      execute: (actionId, input, context) => harness.executor.execute(actionId, input, { ...context, signal: lifetime.signal }),
    },
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
        auth: expect.objectContaining({ clientType: 'user-scoped', token: accountToken }),
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
    const requiresApproval = (actionInput: unknown = input) => {
      const decision = resolveActionApprovalRouting({ actionId,
      spec: getActionSpec(actionId), context, input: actionInput,
      settings: harness.deps.readActionsSettings!(context), defaultUiConfirmation: true,
      });
      return decision.required || decision.uiConfirmationRequired === true;
    };
    expect(requiresApproval()).toBe(true);
    expect(requiresApproval({ ...input,
      to: { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'another-audience' } }, index: 0 },
    })).toBe(true);
    settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    expect(requiresApproval()).toBe(false);
    settings = normalizeActionsSettingsV1({ ...settings, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(requiresApproval()).toBe(true);
  });

  it.each([{ explicitTarget: true, mode: 'plain' }, { explicitTarget: false, mode: 'plain' },
    { explicitTarget: true, mode: 'e2ee' }] as const)('observes requester-private recorded approval execution without treating approval alone as guest completion ($mode, explicit target: $explicitTarget)', async ({ explicitTarget, mode }) => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
      : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    let storedMode: 'plain' | 'e2ee' = mode;
    let unreadableBody = false;
    const expectedOrigin = { actionId: 'session.spawn_new' as const, requestId: 'acquire-request', accountId: 'requester',
      serverIdentityId: 'srv_home', machineId: 'guest' };
    let request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'guest-home-profile', ...expectedOrigin, ...(explicitTarget ? { target: { kind: 'machine', machineId: 'guest' } } : {}) },
      approval: { flow: 'deferred', result: 'none' }, actionId: 'session.spawn_new', actionArgs: {}, summary: 'Start guest Agent',
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
    });
    const result = { type: 'success', sessionId: 'real-child', disposition: 'created',
      executionTarget: { serverId: 'srv_home', machineId: 'guest' } };
    const writes = vi.spyOn(axios, 'post').mockRejectedValue(new Error('observation_must_not_execute'));
    // Only the durable Artifact HTTP and Socket.IO transports are substituted;
    // Account mode/content parsing, subject matching and coordinator stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200,
        data: AccountEncryptionModeResponseSchema.parse({ mode, updatedAt: 1 }) };
      expect(url).toBe('https://requester-home.example/v1/artifacts/child-approval');
      return { status: 200, data: { id: 'child-approval', ownerAccountId: 'requester', access: 'owner', encryptionMode: storedMode, publicAudience: 'none',
        header: encode(buildApprovalRequestArtifactHeaderV1(request)),
        body: unreadableBody ? 'unreadable-body' : encode({ body: JSON.stringify(request) }),
        dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: request.updatedAtMs } };
    });
    const harness = createCliActionExecutorHarness({ token, credentials, sessionId: 'source',
      serverId: 'requester-home', serverHttpBaseUrl: 'https://requester-home.example', ...(mode === 'plain'
        ? { mode: 'plain', ctx: null }
        : { mode: 'e2ee', ctx: { encryptionKey: new Uint8Array(32).fill(17), encryptionVariant: 'legacy' } }) });
    await expect(runWithServerHttpBaseUrl('https://requester-home.example', () => harness.deps.approvalsGet!({ artifactId: 'child-approval', serverId: null })))
      .resolves.toMatchObject({ v: 2, status: 'approved', executionOriginV1: expectedOrigin });
    const abort = new AbortController();
    const pending = harness.observeRecordedApprovalExecution({ artifactId: 'child-approval', expectedOrigin,
      signal: abort.signal });
    try {
      const first = await Promise.race([pending.then(result => ({ settled: true, result })),
        new Promise<{ settled: false }>(resolve => setTimeout(() => resolve({ settled: false }), 20))]);
      expect(first, JSON.stringify(first)).toEqual({ settled: false });
      // A receipt observer must leave the daemon's authenticated decision free
      // to perform durable replay of the exact approved Action.
      expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount('child-approval')).toBe(0);
      expect(wire.sockets.some(socket => socket.connected)).toBe(true);
      request = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 3,
        execution: { executedAtMs: 3, ok: true, result } });
      for (const socket of wire.sockets) socket.wake();
      await expect(pending).resolves.toEqual({ ok: true, result });
      expect(writes).not.toHaveBeenCalled();
      expect(wire.sockets.every(socket => !socket.connected && socket.listenerCount() === 0)).toBe(true);
      for (const changed of [{ actionId: 'machines.setup.apply' }, { requestId: 'another-request' },
        { serverIdentityId: 'another-home' }, { machineId: 'another-guest' }]) {
        await expect(harness.observeRecordedApprovalExecution({ artifactId: 'child-approval',
          expectedOrigin: { ...expectedOrigin, ...changed }, signal: abort.signal }))
          .resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
      }
      const readsBeforeWrongAccount = vi.mocked(axios.get).mock.calls.length;
      await expect(harness.observeRecordedApprovalExecution({ artifactId: 'child-approval',
        expectedOrigin: { ...expectedOrigin, accountId: 'another-account' }, signal: abort.signal }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      expect(vi.mocked(axios.get).mock.calls).toHaveLength(readsBeforeWrongAccount);
      storedMode = mode === 'plain' ? 'e2ee' : 'plain';
      await expect(harness.observeRecordedApprovalExecution({ artifactId: 'child-approval', expectedOrigin, signal: abort.signal }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      storedMode = mode;
      unreadableBody = true;
      await expect(harness.observeRecordedApprovalExecution({ artifactId: 'child-approval', expectedOrigin, signal: abort.signal }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      unreadableBody = false;
      request = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: {
        ...request.executionOriginV1, sessionId: 'another-session', target: { kind: 'session', sessionId: 'another-session' },
      } });
      await expect(harness.observeRecordedApprovalExecution({ artifactId: 'child-approval', expectedOrigin, signal: abort.signal }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });
      abort.abort();
      await expect(harness.observeRecordedApprovalExecution({ artifactId: 'child-approval', expectedOrigin, signal: abort.signal }))
        .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });

      // Home admits the borrowed requester once. Reading its already recorded
      // approval result does not re-authorize the finite managed operation.
      // Only Home's HTTP boundary is substituted; requester custody stays real.
      let homeCustody = true;
      const verifyUrl = 'https://requester-home.example/v1/actions/session.spawn_new/execution-authorization/verify';
      writes.mockImplementation(async url => {
        expect(url).toBe(verifyUrl);
        return { status: 200, data: { ok: homeCustody } };
      });
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
      const target = { kind: 'machine' as const, machineId: expectedOrigin.machineId };
      const projection = await projectExternalActionRequesterHttpAuthorization({
        authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'borrowed-requester-proof', binding: {
          accountId: expectedOrigin.accountId, custodianAccountId: 'guest-custodian',
          authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: expectedOrigin.serverIdentityId,
          machineId: expectedOrigin.machineId, installationId: 'guest-installation', actionId: expectedOrigin.actionId,
          requestId: expectedOrigin.requestId, requestEnvelopeDigest: 'd'.repeat(43), target, accountEncryptionMode: mode,
        } }),
        serverId: 'requester-home', serverIdentityId: expectedOrigin.serverIdentityId,
        serverHttpBaseUrl: 'https://requester-home.example', target,
        installationId: 'guest-installation', privateKey: keys.secretKey,
      });
      const custody = projection?.requesterHttpProjection;
      if (!custody) throw new Error('Expected real requester HTTP custody');
      request = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: {
        ...request.executionOriginV1, target,
      } });
      const managedAbort = new AbortController();
      const managedRequest = { execution: { ok: true as const, result: {
        kind: 'approval_request_created', artifactId: 'child-approval', actionId: expectedOrigin.actionId,
      } }, expectedOrigin, signal: managedAbort.signal, isCurrent: custody.isCurrent,
        observeRecordedApprovalExecution: harness.observeRecordedApprovalExecution };
      await expect(observeManagedChildApprovalExecution({ ...managedRequest, signal: undefined }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      await expect(observeManagedChildApprovalExecution({ ...managedRequest, observeRecordedApprovalExecution: undefined }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      await expect(observeManagedChildApprovalExecution(managedRequest)).resolves.toEqual({ ok: true, result });
      homeCustody = false;
      const writesBeforeReceiptRead = writes.mock.calls.length;
      await expect(observeManagedChildApprovalExecution(managedRequest)).resolves.toEqual({ ok: true, result });
      expect(writes).toHaveBeenCalledTimes(writesBeforeReceiptRead);
      expect(writes.mock.calls.every(([url]) => url === verifyUrl)).toBe(true);
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
    }
  });
  it('observes a requester-owned PAT approval through signed Artifact receipts without claiming its decision', async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
    const artifactId = 'pat-setup-approval';
    const expectedOrigin = { actionId: 'machines.setup.apply', requestId: 'setup-request',
      accountId: 'requester', serverIdentityId: 'home', machineId: 'machine' };
    let request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: expectedOrigin.actionId,
      actionArgs: {}, summary: 'Apply Machine setup', approval: { flow: 'deferred', result: 'required' },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId: 'home', ...expectedOrigin, target: { kind: 'machine', machineId: 'machine' } } });
    const receipt = { operationId: 'setup-operation' };
    const read = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(url).toBe(`https://home.example/v1/artifacts/${artifactId}`);
      expect(config?.headers?.Authorization).toBeUndefined();
      expect(config?.headers?.['x-happier-action-execution-authorization']).toBe('signed-pat-root');
      return { status: 200, data: { id: artifactId, ownerAccountId: 'requester', access: 'owner',
        encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: request.updatedAtMs } };
    });
    const harness = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
      sessionId: 'source', serverId: 'home', serverHttpBaseUrl: 'https://home.example', mode: 'plain', ctx: null });
    const abort = new AbortController();
    const pending = harness.observeRecordedApprovalExecution({ artifactId, expectedOrigin, signal: abort.signal,
      accountEncryptionMode: 'plain', authorizationHeaders: async () => ({
        'x-happier-action-execution-authorization': 'signed-pat-root',
        [requesterAccountEncryptionMode]: 'plain',
      }) });
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(0);
      expect(wire.sockets.some(socket => socket.connected)).toBe(false);
      request = ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
      getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({ artifactId, request });
      const afterApproval = await Promise.race([pending.then(result => ({ settled: true, result })),
        new Promise<{ settled: false }>(resolve => setTimeout(() => resolve({ settled: false }), 20))]);
      expect(afterApproval).toEqual({ settled: false });
      request = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 3,
        execution: { ok: true, executedAtMs: 3, result: receipt } });
      getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({ artifactId, request });
      await expect(pending).resolves.toEqual({ ok: true, result: receipt });
      expect(read.mock.calls.length).toBeGreaterThan(1);
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
    // Daemon discovery is the filesystem boundary; HTTP uses the real bundled dispatcher.
    const daemon = fastify();
    daemon.post('/browser/runtime-actions/execute', async request => {
      expect(request.headers['x-happier-daemon-token']).toBe('browser-control-token');
      expect(request.body).toMatchObject({ actionId: 'browser.diagnostics.snapshot', sessionId: 'session_browser' });
      return { result: { v: 1, machineId: 'machine_browser', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] } };
    });
    const address = await daemon.listen({ host: '127.0.0.1', port: 0 });
    const state = vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({
      pid: 123, httpPort: Number(new URL(address).port), controlToken: 'browser-control-token',
      startedAt: 1, startedWithCliVersion: '0.3.0',
    });
    const harness = createCliActionExecutorHarness({
      token: 'token', sessionId: 'session_browser', mode: 'plain', ctx: null,
      getCurrentSessionMetadata: () => ({ machineId: 'machine_browser' }),
    });
    try {
      const result = await harness.executor.execute('browser.diagnostics.snapshot', {
        browserSessionId: 'session_browser', viewId: 'view_browser',
      }, { surface, defaultSessionId: 'session_browser' });
      expect(result).toEqual({ ok: true, result: {
        v: 1, machineId: 'machine_browser', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [],
      } });
    } finally {
      state.mockRestore();
      await daemon.close();
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
        getCurrentSessionMetadata: () => ({ machineId: 'machine-1' }),
        mode: 'e2ee',
        actionsSettingsProvider: {
          getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['session.title.set']: { approvalRequiredSurfaces: ['agent'] } } }),
        },
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsCreate,
        sessionStateFieldSet,
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
    // Simulator Actions reach their Machine through Machine transport; with no
    // addressed or Session Machine the bridge fails closed before any transport.
    await expect(harness.deps.runtimeActionExecute?.({
      actionId: 'devices.simulator.list',
      input: { type: 'simulator.devices.list' },
      context: {},
    })).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:devices.simulator:simulator_machine_unavailable',
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
