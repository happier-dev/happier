import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { listExecutionRunMarkers, readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { ExecutionRunFollowFrontierResponseSchema, ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { deriveSessionFollowOriginalOccurrenceKeyV1, resolveExecutionRunFollowOccurrenceV1, SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type {
  AgentExecutionRunEvent,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/testkit';
import {
  createNativeAgentExecutionRunContextLeaseFactory,
  createNativeAgentExecutionRunHostRuntime,
} from './nativeAgentExecutionRun';
import { observeWorkflowDetachedExecutionRunInput } from '@/daemon/workflows/stepExecution';
import { createWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';
import { buildRunScopedExecutionPermissionRequestId } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import type { AgentState } from '@/api/types';
import { createActionExecutor, StrictJsonValueSchema, waitForExecutionRunTerminal } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { freezeActionCompletionContractV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { materializeWorkflowAcceptedSnapshotV1, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { createWorkflowCoordinator } from '@/daemon/workflows/coordinator';
import { createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildBackendTargetKeyV2, convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import type { ExecutionRunPermissionRequestStore, ExecutionRunPermissionRequestStoreProvider } from './executionRunPermissionResponseTarget';
import { buildExecutionRunPermissionRequestEnvelope } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { applyMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

const runtimeFactoryMock = vi.hoisted(() => ({
  createExecutionRunBridgeRuntime: vi.fn(),
}));

vi.mock('./createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: runtimeFactoryMock.createExecutionRunBridgeRuntime,
}));

import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';

const TEST_BACKEND_ID = `${'task'}.${'backend'}` as never;
let directory: string;
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

describe('ExecutionRunHostBridge detached task scope', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'happier-detached-scope-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockReset();
  });

  it('admits a detached plan at the profile owner and retains its structured result without Session facts', async () => {
    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => runtime.emitMessage({ type: 'model-output',
        fullText: JSON.stringify({ summary: 'Plan ready', sections: [{ title: 'Steps', items: ['Verify the result'] }] }),
      } as AgentMessage),
      onWaitForTurnCompletion: async () => {},
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockReturnValue(runtime);
    const manager = new ExecutionRunHostBridge({ parentProvider: TEST_BACKEND_ID, cwd: process.cwd(), sendAcp: async () => {} });
    try {
      const started = await manager.start({ sessionId: null, intent: 'plan', modelSelection: null,
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Plan this work',
        permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' });
      await manager.waitForTerminal(started.runId);
      expect(manager.get(started.runId)).toMatchObject({ sessionId: null, intent: 'plan', status: 'succeeded',
        structuredMeta: { kind: 'plan_output.v1', payload: { summary: 'Plan ready' } } });
      expect(await listExecutionRunMarkers()).toEqual(expect.arrayContaining([expect.objectContaining({
        runId: started.runId, happySessionId: null,
      })]));
    } finally { await manager.dispose(); }
  });

  it.each([true, false])('runs an originless Workflow plan through the real Action and profile (detached target wired=%s)', async (detached) => {
    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => runtime.emitMessage({ type: 'model-output',
        fullText: JSON.stringify({ summary: 'External workflow plan', sections: [{ title: 'Steps', items: ['Ship the plan'] }] }),
      } as AgentMessage),
      onWaitForTurnCompletion: async () => {},
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockReturnValue(runtime);
    const manager = new ExecutionRunHostBridge({ parentProvider: TEST_BACKEND_ID, cwd: process.cwd(), sendAcp: async () => {} });
    const workspace = { machineId: 'machine', directory: process.cwd(), checkoutRootPath: process.cwd() };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{
      kind: 'action', id: 'member', actionId: 'subagents.plan.start', input: {
        ...(detached ? { target: { kind: 'literal' as const, value: { kind: 'detached' } } } : {}),
        backendTargetKeys: { kind: 'literal', value: ['agent:happier.agent.codex/codex'] },
        instructions: { kind: 'literal', value: 'Plan this work' },
      },
    }] };
    const spec = getActionSpec('subagents.plan.start');
    const outputSchema = spec.completion?.terminalOutputSchema;
    if (!outputSchema || !spec.completion) throw new Error('Missing plan completion contract');
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition, context: {
      source: { kind: 'catalog', ref: 'plugin:acme.workflows/panel', version: '1.0.0' }, inputs: {}, machineId: workspace.machineId,
      executionTarget: { kind: 'detached_run' }, workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
      authorization: { principal: { kind: 'host' } },
    }, admission: { kind: 'user' }, effects: {
      resolveTargetAvailability: async () => true, // installed-Agent inventory boundary
      readActionContract: async () => ({
        inputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
        outputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(outputSchema, { target: 'draft-7' })),
        completion: freezeActionCompletionContractV1(spec.completion!),
      }),
    } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    // This replaces only the machine transport/native runtime. Action admission,
    // profile capability, completion and Workflow result validation remain real.
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async (sessionId, request) => {
        const parsed = ExecutionRunStartRequestSchema.parse(request);
        return manager.start({ ...parsed, sessionId: sessionId ?? null, modelSelection: null,
          backendTarget: convertBackendTargetRefV2ToV1(readBackendTargetRefV2(parsed.backendTarget)) });
      },
    });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Unexpected Agent leaf'); },
      allocateInvocationRecordId: () => `invocation-${store.list().length}`,
      resolveWorkspace: async () => ({ ok: true, workspace }),
      action: { executor, buildContext: async ({ runId, authorization }) => ({ surface: 'cli',
        authority: 'account_automation', actionCaller: { kind: 'workflowRun', runId, authorization },
        externalActionTarget: { kind: 'machine', machineId: workspace.machineId, project: workspace } }),
        observeRun: async ({ runId }) => {
          await manager.waitForTerminal(runId);
          const run = manager.get(runId);
          if (run?.status !== 'succeeded') throw new Error('Plan did not succeed');
          return { kind: 'completed', result: StrictJsonValueSchema.parse(run.latestToolResult) };
        },
      },
    });
    try {
      const outcome = await coordinator.run({ ...accepted.snapshot, runId: 'external-workflow' });
      if (detached) {
        expect(outcome).toMatchObject({ state: 'succeeded' });
        expect(store.list().find(row => row.blockId === 'member')).toMatchObject({ lifecycle: 'completed',
          result: { perEngineOutcome: [expect.objectContaining({ key: 'agent:happier.agent.codex/codex', outcome: 'completed' })] } });
        const markers = await listExecutionRunMarkers();
        expect(markers).toHaveLength(1);
        expect(markers[0]).toMatchObject({ happySessionId: null });
      } else {
        expect(outcome).toMatchObject({ state: 'outcome_uncertain', reason: 'session_not_selected' });
        expect(await listExecutionRunMarkers()).toEqual([]);
      }
    } finally { await manager.dispose(); }
  });

  it('observes persisted permission attention and its removal at the live run owner without settling terminal waiters', async () => {
    let state: AgentState = {};
    const store = new AgentStateRequestStore({ logPrefix: '[test]', target: {
      scopeId: 'workflow-input', readState: () => state,
      updateState: async (update) => { state = update(state); },
    } });
    let getStore: ExecutionRunPermissionRequestStoreProvider | undefined;
    let occurrence = '';
    let finishTurn: (() => void) | undefined;
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: { getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider; controllerOccurrenceId: string }) => {
      getStore = options.getPermissionRequestStore;
      occurrence = options.controllerOccurrenceId;
      return createTestExecutionRunHostRuntime({ onSendPrompt: async () => {},
        onRespondToPermission: async () => ({ delivered: true }),
        onWaitForTurnCompletion: async () => await new Promise<void>((resolve) => { finishTurn = resolve; }) });
    });
    const manager = new ExecutionRunHostBridge({ parentProvider: TEST_BACKEND_ID, cwd: process.cwd(), sendAcp: async () => {},
      resolveRunReportPolicy: async () => ({ preset: 'important' }) });
    const abort = new AbortController();
    try {
      const started = await manager.start({ sessionId: 'follow-source', intent: 'agent',
        modelSelection: null,
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, permissionMode: 'default',
        instructions: 'Await permission in this exact input', localInputId: 'permission-input',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', getPermissionRequestStore: () => store });
      await vi.waitFor(() => expect(getStore?.()).toBeTruthy());
      const observer = waitForExecutionRunTerminal({ runId: started.runId, timeoutMs: null, condition: 'needs_attention',
        signal: abort.signal, readRun: async ({ runId }) => ({ ok: true as const, data: { run: manager.getPublic(runId) } }),
        waitForTerminal: (id, signal) => manager.waitForTerminal(id, { signal }),
        waitForChange: (id, signal) => manager.waitForRunStateChange(id, signal),
      });
      void observer.catch(() => {});
      let terminalSettled = false;
      const terminal = manager.waitForTerminal(started.runId).then(() => { terminalSettled = true; });
      expect(occurrence).toBeTruthy();
      const responseTarget = buildExecutionRunPermissionRequestEnvelope({ sessionId: 'follow-source', runId: started.runId,
        callId: started.callId, sidechainId: started.sidechainId, backendId: TEST_BACKEND_ID, runtimeKind: 'native_agent_session',
        controllerOccurrenceId: occurrence, providerRequestId: 'permission-native', permissionMode: 'default',
        providerPayload: {}, toolName: 'bash', reason: 'bash' }).responseTarget;
      const requestId = buildRunScopedExecutionPermissionRequestId({ runId: started.runId,
        controllerOccurrenceId: occurrence, providerRequestId: 'permission-native' });
      const nativeChoices = { requirementId: 'native-occurrence', source: 'test-agent', choices: [{ id: 'remember', label: 'Remember',
        decision: 'approved' as const, scope: 'session' as const, response: { approved: true },
        followUp: { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { write: 'allow' } } } },
        { id: 'deny', label: 'Deny', decision: 'denied' as const, scope: 'once' as const, response: { approved: false } }] };
      await getStore?.()?.publishRequestAndWait?.({ requestId, toolName: 'bash', toolInput: {}, createdAt: 1, responseTarget, nativeChoices });
      expect(ExecutionRunGetResponseSchema.parse({ run: manager.getPublic(started.runId) }).run.attention?.requests)
        .toMatchObject([{ requestId, nativeChoices }]);
      await expect(observer).resolves.toMatchObject({ disposition: 'needs_attention', result: { run: {
        attention: { kind: 'permission_required', requestIds: [requestId] },
      } } });
      await vi.waitFor(async () => expect((await readRetainedExecutionRunRecord(started.runId))?.state)
        .toMatchObject({ attention: { kind: 'permission_required', requestIds: [requestId] } }));
      const retained = (await readRetainedExecutionRunRecord(started.runId))!;
      const frontier = ExecutionRunFollowFrontierResponseSchema.parse({ sessionId: 'follow-source', runId: started.runId,
        status: retained.state.status, terminalEventId: null, attention: retained.state.attention });
      const followOccurrence = resolveExecutionRunFollowOccurrenceV1(frontier);
      expect(SessionFollowInputV1Schema.parse({ v: 1, ...followOccurrence, delivery: 'wake' })).toMatchObject({
        original: { source: { kind: 'execution_run', sessionId: 'follow-source', runId: started.runId }, permissionRequests: [{ requestId, createdAt: 1 }] },
        event: { kind: 'needs_you', type: 'approval' },
      });
      expect(terminalSettled).toBe(false);
      const change = manager.waitForRunStateChange(started.runId);
      expect(await getStore?.()?.completeRequest?.({ requestId, status: 'denied', decision: 'denied', extraCompletedFields: {
        nativeChoice: { requirementId: 'native-occurrence', choiceId: 'deny' },
      } })).toBe(true);
      await change;
      expect(manager.getPublic(started.runId)?.attention).toBeUndefined();
      await vi.waitFor(async () => expect((await readRetainedExecutionRunRecord(started.runId))?.state.attention).toBeUndefined());
      expect(resolveExecutionRunFollowOccurrenceV1({ ...frontier, attention: undefined })).toBeNull();
      await getStore?.()?.publishRequestAndWait?.({ requestId, toolName: 'bash', toolInput: {}, createdAt: 2, responseTarget });
      await vi.waitFor(async () => expect((await readRetainedExecutionRunRecord(started.runId))?.state.attention?.requests)
        .toEqual([{ requestId, createdAt: 2 }]));
      const reopened = (await readRetainedExecutionRunRecord(started.runId))!;
      const reopenedOccurrence = resolveExecutionRunFollowOccurrenceV1({ ...frontier, attention: reopened.state.attention })!;
      expect(deriveSessionFollowOriginalOccurrenceKeyV1(reopenedOccurrence.original))
        .not.toBe(deriveSessionFollowOriginalOccurrenceKeyV1(followOccurrence!.original));
      await getStore?.()?.completeRequest?.({ requestId, status: 'denied' });
      await manager.stop(started.runId);
      await terminal;
    } finally { abort.abort(); finishTurn?.(); await manager.dispose(); }
  });

  it('removes one aborted terminal observer without disturbing the run or its sibling observer', async () => {
    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {},
      onWaitForTurnCompletion: async () => {},
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockReturnValue(runtime);
    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: process.cwd(),
      sendAcp: async () => {},
    });

    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });
      const abort = new AbortController();
      const cancelledWait = manager.waitForTerminal(started.runId, { signal: abort.signal });
      const siblingWait = manager.waitForTerminal(started.runId);

      const cancellation = new Error('caller stopped observing');
      abort.abort(cancellation);
      await expect(cancelledWait).rejects.toBe(cancellation);
      expect(manager.get(started.runId)?.status).toBe('running');

      await expect(manager.stop(started.runId)).resolves.toEqual({ ok: true });
      await expect(siblingWait).resolves.toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it('projects the actual retained interaction for a live detached general Agent run', async () => {
    const interaction = {
      kind: 'retained_agent_session.v1' as const,
      capabilities: { open: ['create' as const, 'resume' as const], delivery: ['newTurn' as const], cancel: true },
    };
    const runtime = {
      ...createTestExecutionRunHostRuntime({
        onSendPrompt: async () => {},
        onWaitForTurnCompletion: async () => {},
      }),
      interaction,
    };
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockReturnValue(runtime);
    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: process.cwd(),
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        instructions: 'Keep this runtime retained.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });

      expect(manager.getPublic(started.runId)?.interaction).toEqual(interaction);
    } finally {
      await manager.dispose();
    }
  });

  it('applies a stored detached native choice before its offered catalog Action', async () => {
    let state: AgentState = {};
    const store = new AgentStateRequestStore({ logPrefix: '[test]', target: { scopeId: 'native-follow-up', readState: () => state,
      updateState: async update => { state = update(state); } } });
    let requestId = ''; let finishTurn: (() => void) | undefined;
    const trace: string[] = [];
    const followUp = { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { write: 'allow' } } };
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: { getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
      controllerOccurrenceId: string; runId: string; callId: string; sidechainId: string; backendId: string }) => {
      return createTestExecutionRunHostRuntime({ onSendPrompt: async () => {
        const currentStore = options.getPermissionRequestStore?.();
        if (!currentStore?.publishRequestAndWait) throw new Error('Missing exact Run input store');
        const envelope = buildExecutionRunPermissionRequestEnvelope({ sessionId: null, runId: options.runId, callId: options.callId,
          sidechainId: options.sidechainId, backendId: options.backendId, runtimeKind: 'native_agent_session', controllerOccurrenceId: options.controllerOccurrenceId,
          providerRequestId: 'native-request', permissionMode: 'default', providerPayload: {}, toolName: 'McpTool', reason: 'Write document' });
        requestId = buildRunScopedExecutionPermissionRequestId({ runId: options.runId, controllerOccurrenceId: options.controllerOccurrenceId, providerRequestId: 'native-request' });
        await currentStore.publishRequestAndWait({ requestId, toolName: 'McpTool', toolInput: {}, createdAt: 1, responseTarget: envelope.responseTarget,
          nativeChoices: { requirementId: 'occurrence', source: 'test-agent', choices: [{ id: 'remember', label: 'Remember',
            decision: 'approved', scope: 'session', response: { approved: true }, followUp }] } });
      }, onRespondToPermission: async () => {
        trace.push('native'); return { delivered: true }; },
        onWaitForTurnCompletion: async () => await new Promise<void>(resolve => { finishTurn = resolve; }) });
    });
    const manager = new ExecutionRunHostBridge({ parentProvider: TEST_BACKEND_ID, cwd: process.cwd(), sendAcp: async () => {} });
    try {
      const started = await manager.start({ sessionId: null, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        instructions: 'Wait for native consent', localInputId: 'native-input', permissionMode: 'default',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', getPermissionRequestStore: () => store });
      await vi.waitFor(() => expect(finishTurn).toBeTypeOf('function'));
      let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'docs', name: 'docs', transport: 'stdio',
        stdio: { command: 'docs-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] };
      const executor = createActionExecutor({ isActionApprovalRequired: () => false,
        executionRunCheckProtocolV2: async () => ({ ok: true }), executionRunGet: async (_session, input) => ({ run: manager.getPublic(input.runId) }),
        executionRunPermissionRespond: input => manager.completePermissionRequest(input.runId, input),
        mcpServerAction: createMcpServerActionExecuteV1({ readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
          readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) }),
          mutate: async mutation => { trace.push('save'); catalog = applyMcpServerCatalogMutationV1(catalog, mutation);
            return { status: 'updated', revision: 2, cursor: 2 }; }, machine: async () => { throw new Error('No process'); } }),
      });
      const answered = await executor.execute('execution.run.permission.respond', { runId: started.runId, requestId,
        nativeChoice: { requirementId: 'occurrence', choiceId: 'remember' } }, { surface: 'ui', authority: 'present_user',
        serverId: 'home', runtimeAccountId: 'account', executionRunTargetMachineId: 'machine' });
      expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
      expect(trace).toEqual(['native', 'save']);
      expect(catalog.servers[0]).toMatchObject({ tools: { overrides: { write: 'allow' } } });
    } finally { finishTurn?.(); await manager.dispose(); }
  });

  it('rebinds a reconstructed detached run permission target to the exact active continuation turn', async () => {
    const secondTurnControl: { release: (() => void) | null } = { release: null };
    let completionCount = 0;
    const runtimeOptions: Array<Record<string, unknown>> = [];
    const observedStores: ExecutionRunPermissionRequestStore[] = [];
    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {
        const current = runtimeOptions[0]?.getPermissionRequestStore as ExecutionRunPermissionRequestStoreProvider | undefined;
        const store = current?.();
        if (store) observedStores.push(store);
      },
      onWaitForTurnCompletion: async () => {
        completionCount += 1;
        if (completionCount === 1) return;
        await new Promise<void>((resolve) => { secondTurnControl.release = resolve; });
      },
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: Record<string, unknown>) => {
      runtimeOptions.push(options);
      return runtime;
    });
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    const completeA = vi.fn(async () => true);
    const completeB = vi.fn(async () => true);
    let outstandingB: Record<string, unknown> | null = null;
    const storeA = {
      publishRequest: vi.fn(),
      publishRequestAndWait: vi.fn(async () => undefined),
      registerResponseTargetHandler: vi.fn(() => releaseA),
      readOutstandingRequest: vi.fn(() => null),
      completeRequest: completeA,
    };
    const storeB = {
      publishRequest: vi.fn(),
      publishRequestAndWait: vi.fn(async () => undefined),
      registerResponseTargetHandler: vi.fn(() => releaseB),
      readOutstandingRequest: vi.fn(() => outstandingB),
      completeRequest: completeB,
    };
    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: process.cwd(),
      sendAcp: async () => {},
    });

    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        instructions: 'Invocation A',
        localInputId: 'workflow-input-a',
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
        getPermissionRequestStore: () => storeA as never,
      });
      await vi.waitFor(() => expect(releaseA).toHaveBeenCalledOnce());

      await expect(manager.send(started.runId, {
        message: 'Invocation B',
        localInputId: 'workflow-input-b',
        permissionRequestStore: storeB as never,
      })).resolves.toEqual({ ok: true });
      const internals = manager as unknown as {
        controllers: Map<string, import('@/agent/executionRuns/controllers/types').ExecutionRunController>;
      };
      const controller = internals.controllers.get(started.runId);
      const run = manager.get(started.runId);
      if (!run || controller?.kind !== 'backend' || !controller.currentInputTurn) {
        throw new Error('expected active detached continuation turn');
      }
      const permissionRequestId = buildRunScopedExecutionPermissionRequestId({
        runId: run.runId,
        controllerOccurrenceId: controller.controllerOccurrenceId,
        providerRequestId: 'permission-b',
      });
      outstandingB = {
        requestId: permissionRequestId,
        toolName: 'AskUserQuestion',
        kind: 'user_action',
        toolInput: { questions: [{ question: 'Which branch?', options: [{ label: 'dev' }] }] },
        createdAt: 2,
        turnId: controller.currentInputTurn.turnId,
        responseTarget: {
          kind: 'execution_run_host_bridge',
          sessionId: null,
          runId: run.runId,
          callId: run.callId,
          sidechainId: run.sidechainId,
          backendId: run.backendId,
          runtimeKind: 'native_agent_session',
          providerRequestId: 'permission-b',
          controllerOccurrenceId: controller.controllerOccurrenceId,
        },
      };

      await expect(manager.completePermissionRequest(started.runId, {
        requestId: `${permissionRequestId}-mismatch`,
        approved: true,
      })).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
      expect(completeB).not.toHaveBeenCalled();

      await expect(manager.completePermissionRequest(started.runId, {
        requestId: permissionRequestId,
        answers: { 'Which branch?': ['dev'] },
      })).resolves.toEqual({ ok: true });
      expect(completeA).not.toHaveBeenCalled();
      expect(completeB).toHaveBeenCalledWith({
        requestId: permissionRequestId,
        status: 'approved',
        decision: 'approved',
        answers: { 'Which branch?': ['dev'] },
      });
      expect(observedStores[0]?.readOutstandingRequest?.(permissionRequestId)).toBeNull();
      expect(observedStores[1]?.readOutstandingRequest?.(permissionRequestId)).toEqual(outstandingB);

      const booleanPermissionRequestId = buildRunScopedExecutionPermissionRequestId({
        runId: run.runId,
        controllerOccurrenceId: controller.controllerOccurrenceId,
        providerRequestId: 'permission-b-boolean',
      });
      const structuredQuestionRequest = outstandingB;
      if (!structuredQuestionRequest) throw new Error('expected outstanding structured question');
      outstandingB = {
        ...structuredQuestionRequest,
        requestId: booleanPermissionRequestId,
        toolName: 'Write',
        kind: 'permission',
        toolInput: { path: '/repo/file.txt' },
        responseTarget: {
          ...(structuredQuestionRequest.responseTarget as Record<string, unknown>),
          providerRequestId: 'permission-b-boolean',
        },
      };
      await expect(manager.completePermissionRequest(started.runId, {
        requestId: booleanPermissionRequestId,
        approved: true,
      })).resolves.toEqual({ ok: true });
      expect(completeB).toHaveBeenLastCalledWith({
        requestId: booleanPermissionRequestId,
        status: 'approved',
        decision: 'approved',
      });

      outstandingB = null;
      await expect(manager.completePermissionRequest(started.runId, {
        requestId: 'permission-a-stale',
        approved: true,
      })).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
      expect(completeA).not.toHaveBeenCalled();

      secondTurnControl.release?.();
      await vi.waitFor(() => expect(releaseB).toHaveBeenCalledOnce());
    } finally {
      secondTurnControl.release?.();
      await manager.dispose();
    }
  });

  it('surfaces detached execution-run Workflow persistence capacity failure through the exact Run input', async () => {
    const runtimeListeners = new Set<(event: AgentExecutionRunEvent) => void>();
    const runtimeEvents: AgentExecutionRunEvent[] = [];
    let executionRunContext: AgentExecutionRunRuntimeContextV1 | null = null;
    let sequence = 0;
    const providerExecution = vi.fn();
    const publishRequestAndWait = vi.fn(async () => { throw createWorkflowInteractionCapacityError(); });
    const permissionRequestStore = {
      publishRequest: vi.fn(),
      publishRequestAndWait,
      registerResponseTargetHandler: vi.fn(() => () => undefined),
      readOutstandingRequest: vi.fn(() => null),
      completeRequest: vi.fn(async () => false),
      retireCompletedRequestsForTurn: vi.fn(async () => undefined),
    };
    const executionRunContextV1 = { async open(request: { runId: string }, context: AgentExecutionRunRuntimeContextV1) {
      executionRunContext = context;
      const emit = (event: AgentExecutionRunEvent) => {
        runtimeEvents.push(event);
        for (const listener of runtimeListeners) listener(event);
      };
      const execute = async () => {
        emit({ kind: 'run-start', runId: request.runId, sequence: ++sequence, emittedAtMs: sequence });
        try {
          await context.services.interactions.requestApproval({
            kind: 'approval', title: 'Allow write?',
            subject: { kind: 'tool', name: 'Write', input: { path: '/repo/a.txt' } },
          });
          providerExecution();
        } catch (error) {
          emit({
            kind: 'run-failed', runId: request.runId, sequence: ++sequence, emittedAtMs: sequence,
            diagnostic: {
              code: (error as { code?: string }).code ?? 'generic_failure',
              message: error instanceof Error ? error.message : 'failure',
              severity: 'error',
            },
          });
        }
      };
      void execute();
      return {
        async send(_input) {
          return { status: 'admitted' as const };
        },
        async stop() { return { status: 'requested' as const }; },
        watch(listener) {
          runtimeListeners.add(listener);
          for (const event of runtimeEvents) listener(event);
          return { dispose() { runtimeListeners.delete(listener); } };
        },
        async dispose() {},
      } satisfies AgentExecutionRunRuntime;
    } };
    const agentRuntime: AgentRuntime = {
      sessions: {
        open: vi.fn(),
        executionRunContextV1,
      },
    } as unknown as AgentRuntime;
    const lease = {
      pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'acme.agent/default',
      localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true,
    };
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: Record<string, unknown>) => {
      const createExecutionRunContext = createNativeAgentExecutionRunContextLeaseFactory({
        lease,
        runId: String(options.runId),
        controllerOccurrenceId: String(options.controllerOccurrenceId),
        callId: String(options.callId),
        sidechainId: String(options.sidechainId),
        runtimeRegistry: null,
        directory: String(options.cwd),
        machineId: 'machine-1',
        accountSettings: null,
        permissionMode: String(options.permissionMode),
        start: options.start as never,
        causalPermissionAuthority: options.causalPermissionAuthority as never,
        getPermissionRequestStore: options.getPermissionRequestStore as never,
      });
      return createNativeAgentExecutionRunHostRuntime({
        runtime: agentRuntime,
        executionRunContextV1,
        lease,
        options: options as never,
        supportsResume: false,
        createExecutionRunContext,
        respondToPermissionRequest: createExecutionRunContext.respondToPermissionRequest,
        abortPendingPermissionRequests: createExecutionRunContext.abortPendingPermissionRequests,
      });
    });
    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: '/repo',
      sendAcp: async () => {},
    });

    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        instructions: 'Write the file.',
        localInputId: 'workflow-input-capacity',
        permissionMode: 'default',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
        },
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
        getPermissionRequestStore: () => permissionRequestStore as never,
      });
      await vi.waitFor(() => expect(publishRequestAndWait).toHaveBeenCalledOnce());
      await manager.waitForTerminal(started.runId);

      expect(executionRunContext).toMatchObject({
        scope: { kind: 'execution_run', executionRunId: started.runId },
        executionRun: { id: started.runId },
      });
      expect(executionRunContext).not.toHaveProperty('session');
      expect(publishRequestAndWait).toHaveBeenCalledOnce();
      expect(providerExecution).not.toHaveBeenCalled();
      expect(manager.getPublic(started.runId)).toMatchObject({
        status: 'failed',
        error: { code: 'workflow_interaction_capacity_exceeded' },
      });
      await expect(observeWorkflowDetachedExecutionRunInput({
        runId: started.runId,
        localInputId: 'workflow-input-capacity',
        get: async ({ runId }) => ({ run: manager.getPublic(runId) }),
      })).resolves.toMatchObject({ kind: 'failed', code: 'workflow_interaction_capacity_exceeded', message: expect.any(String) });
    } finally {
      await manager.dispose();
    }
  });

  it('executes a detached structured generic task at the incumbent run and marker owner without Session facts', async () => {
    const sent = vi.fn(async () => {});
    const committed = vi.fn(async () => ({ persisted: true, delivered: false }));
    const publicRuns: unknown[] = [];
    const parentSessionMutation = vi.fn(async () => {});
    const createdRuntimeOptions: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];

    let runtime!: TestExecutionRunHostRuntime;
    runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async (_sessionId, prompt) => {
        prompts.push(prompt);
        runtime.emitMessage({ type: 'model-output', fullText: '{"answer":"detached result"}' } as AgentMessage);
      },
      onWaitForTurnCompletion: async () => {},
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: Record<string, unknown>) => {
      createdRuntimeOptions.push(options);
      return runtime as ExecutionRunHostRuntime;
    });

    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: process.cwd(),
      sendAcp: sent,
      streamedTranscriptSession: {
        enqueueAgentMessageCommitted: committed,
      },
      parentSessionStateTarget: {
        sessionId: 'parent_session_1',
        enqueueRegisteredSessionStateFieldMutation: parentSessionMutation,
      },
      onPublicStateUpdated: (run) => publicRuns.push(run),
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'task',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        instructions: 'Return a bounded result.',
        intentInput: {
          input: { topic: 'execution lifecycle' },
          resultSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      await manager.waitForTerminal(started.runId);

      expect(manager.get(started.runId)).toMatchObject({
        runId: started.runId,
        sessionId: null,
        intent: 'task',
        status: 'succeeded',
        latestToolResult: { answer: 'detached result' },
      });
      expect(prompts).toEqual([
        expect.stringContaining('Task input (strict JSON):\n{"topic":"execution lifecycle"}'),
      ]);
      expect(prompts[0]).toContain('Return only one strict JSON value that satisfies this required result schema:');
      expect(createdRuntimeOptions).toHaveLength(1);
      expect(createdRuntimeOptions[0]).not.toHaveProperty('parentSessionStateTarget');
      expect(createdRuntimeOptions[0]).not.toHaveProperty('happierSessionId');
      expect(sent).not.toHaveBeenCalled();
      expect(committed).not.toHaveBeenCalled();
      expect(parentSessionMutation).not.toHaveBeenCalled();
      expect(publicRuns).toEqual([]);
      expect(await listExecutionRunMarkers()).toEqual(expect.arrayContaining([expect.objectContaining({
        runId: started.runId,
        happySessionId: null,
      })]));
    } finally {
      await manager.dispose();
    }
  });

  it('forwards the daemon-owned Team credential opener into a detached explicit Run without inventing Session scope', async () => {
    const prepareRunTeamCredentialProviderBinding = vi.fn(async () => null);
    const createdRuntimeOptions: Array<Record<string, unknown>> = [];
    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {},
      onWaitForTurnCompletion: async () => {},
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: Record<string, unknown>) => {
      createdRuntimeOptions.push(options);
      return runtime as ExecutionRunHostRuntime;
    });
    const selection = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-detached',
      teamId: 'team-detached',
      expectedResourceRevision: 7,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: TEST_BACKEND_ID }),
      modelId: 'model-detached' as never,
      deliveryMode: 'brokered' as const,
    };
    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: process.cwd(),
      sendAcp: async () => {},
      prepareRunTeamCredentialProviderBinding,
    });

    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        teamCredentialModel: selection,
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      });

      expect(createdRuntimeOptions).toHaveLength(1);
      expect(createdRuntimeOptions[0]).not.toHaveProperty('happierSessionId');
      const prepare = createdRuntimeOptions[0]?.prepareRunTeamCredentialProviderBinding as
        | ((input: Readonly<{ runId: string; agentId: string; selection?: typeof selection }>) => Promise<unknown>)
        | undefined;
      expect(prepare).toBe(prepareRunTeamCredentialProviderBinding);
      await expect(prepare?.({ runId: started.runId, agentId: 'task.backend', selection }))
        .resolves.toBeNull();
      expect(prepareRunTeamCredentialProviderBinding).toHaveBeenCalledWith({
        runId: started.runId,
        agentId: 'task.backend',
        selection,
      });
    } finally {
      await manager.dispose();
    }
  });

  it('forwards the owning Happier Session id to the runtime backend for a Session-scoped run', async () => {
    const sent = vi.fn(async () => {});
    const createdRuntimeOptions: Array<Record<string, unknown>> = [];

    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {},
      onWaitForTurnCompletion: async () => {},
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: Record<string, unknown>) => {
      createdRuntimeOptions.push(options);
      return runtime as ExecutionRunHostRuntime;
    });

    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: process.cwd(),
      sendAcp: sent,
      parentSessionStateTarget: {
        sessionId: 'happier_parent_session_1',
        enqueueRegisteredSessionStateFieldMutation: vi.fn(async () => {}),
      },
      resolveRunReportPolicy: async () => ({ preset: 'important' }),
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: 'happier_parent_session_1',
        intent: 'task',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        modelSelection: null,
        instructions: 'Return a bounded result.',
        intentInput: {
          input: { topic: 'session scope' },
          resultSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      await manager.waitForTerminal(started.runId);

      expect(createdRuntimeOptions).toHaveLength(1);
      expect(createdRuntimeOptions[0]).toHaveProperty('happierSessionId', 'happier_parent_session_1');
      // The owning Happier Session id is the real Session scope, never the run id.
      expect(createdRuntimeOptions[0].happierSessionId).not.toBe(started.runId);
    } finally {
      await manager.dispose();
    }
  });
});
