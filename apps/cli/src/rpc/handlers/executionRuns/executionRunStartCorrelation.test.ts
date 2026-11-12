import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS, RPC_METHODS } from '@happier-dev/protocol/rpc';
import axios from 'axios';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { buildActionExecutorContextForRpc } from '../_actionDispatchAdapter';
import { deriveExecutionRunIdFromActionRequestId } from '@/agent/runtime/bridges/executionRun/startExecutionRun';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { reloadConfiguration } from '@/configuration';
import { createCapabilitiesService } from '@/capabilities/service';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';

const runtimeFactoryMock = vi.hoisted(() => ({
  createExecutionRunBridgeRuntime: vi.fn(),
}));
const markerWriterMock = vi.hoisted(() => ({
  writeExecutionRunMarker: vi.fn<(marker: Readonly<Record<string, unknown>>) => Promise<void>>(
    async () => {},
  ),
}));

vi.mock('@/agent/runtime/bridges/executionRun/createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: runtimeFactoryMock.createExecutionRunBridgeRuntime,
}));

vi.mock('@/daemon/executionRunRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/executionRunRegistry')>()),
  writeExecutionRunMarker: markerWriterMock.writeExecutionRunMarker,
}));

// The Session RPC process reaches daemon admission over HTTP. Keep the request
// owner and response parser real while admitting this fixture's isolated Runs.
vi.mock('@/daemon/controlHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlHttp')>();
  const { EXECUTION_RUN_ADMISSION_PATH } = await import('@/daemon/lifecycle/admissionDrain');
  return {
    ...actual,
    daemonPost: async (...args: Parameters<typeof actual.daemonPost>) => args[0] === EXECUTION_RUN_ADMISSION_PATH
      ? { admitted: true }
      : actual.daemonPost(...args),
  };
});

import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';

import { createExecutionRunRpcActionExecutor } from './dispatchExecutionRunRpcAction';
import {
  registerExecutionRunRpcHandlers,
  type ExecutionRunRpcHandlerContext,
} from './registerExecutionRunRpcHandlers';

const TEST_BACKEND_ID = `${'task'}.${'backend'}` as never;

/**
 * A reused correlation value is the exact predecessor-shaped input this owner
 * must tolerate without acquiring accepted-start correlation semantics.
 */
const REUSED_START_REQUEST_ID = 'reused-start-request-1';

function createDetachedTaskStartInput(params: Readonly<{
  instructions: string;
  startRequestId?: string;
}>): Record<string, unknown> {
  return {
    sessionId: null,
    ...(params.startRequestId ? { startRequestId: params.startRequestId } : {}),
    intent: 'task',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
    instructions: params.instructions,
    intentInput: { input: { topic: 'execution lifecycle' } },
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
  };
}

function createDetachedStartHarness() {
  runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation(() => {
    const runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {
        runtime.emitMessage({ type: 'model-output', fullText: 'bounded result' } as AgentMessage);
      },
      onWaitForTurnCompletion: async () => {},
    });
    return runtime as ExecutionRunHostRuntime;
  });

  const manager = new ExecutionRunHostBridge({
    parentProvider: TEST_BACKEND_ID,
    cwd: process.cwd(),
    sendAcp: async () => {},
    getNowMs: () => 1_700_000_000_000,
  });
  const start = vi.spyOn(manager, 'start');
  const executor = createExecutionRunRpcActionExecutor({
    manager,
    context: { sessionId: null, cwd: process.cwd() },
    policy: resolveExecutionRunPolicy({
      defaults: {
        boundedTimeoutMs: null,
        reviewBoundedTimeoutMs: null,
        maxTurns: null,
      },
    }),
    isExecutionRunsEnabled: () => true,
  });

  return { manager, start, executor };
}

describe('execution.run.start correlation freedom', () => {
  let happyHomeDir: string;
  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-start-correlation-'));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    vi.stubEnv('HAPPIER_EXPERIMENTAL_EXECUTION_RUNS', '1');
    reloadConfiguration();
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockReset();
    markerWriterMock.writeExecutionRunMarker.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    reloadConfiguration();
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it.each([false, true])('keeps admitted Workflow native custody through direct Action transport (miswired=%s)', async miswired => {
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path.includes('/acp/')) return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected HTTP read: ${path}`);
    });
    const { manager, executor: nativeExecutor } = createDetachedStartHarness();
    let releaseTurn!: () => void;
    const turn = new Promise<void>(resolve => { releaseTurn = resolve; });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation(() => createTestExecutionRunHostRuntime({
      onWaitForTurnCompletion: () => turn,
      onCancel: () => releaseTurn(),
      onDispose: () => releaseTurn(),
    }));
    const actionRequestId = 'workflow-input-v2:reclaim-owned-input:execution-run-start';
    const expectedRunId = deriveExecutionRunIdFromActionRequestId(actionRequestId);
    const capabilities = createCapabilitiesService({
      capabilities: [executionRunsCapability],
      checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
      buildContext: async () => { throw new Error('Effectful capability discovery is unavailable'); },
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async (method, input, options) => {
        if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) return capabilities.describe();
        const localActionContext = { ...options?.localActionContext };
        // Removing this actual in-process binding must reproduce the custody
        // split: the native owner must never trust a same-named public field.
        if (miswired) delete localActionContext.actionCaller;
        // This native transport belongs to an already admitted Machine caller.
        // Keep requester attribution distinct from the Workflow custody toggle.
        const context = buildActionExecutorContextForRpc({ localActionContext, serverId: 'home-1',
          machineAdmission: { actorAccountId: 'account-1', custodianAccountId: 'account-1',
            machineId: 'machine-1', installationId: 'installation-1', role: 'manage', encryptionMode: 'plain' },
        });
        const actionId = method === SESSION_RPC_METHODS.EXECUTION_RUN_START ? 'execution.run.start'
          : method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP ? 'execution.run.stop' : 'execution.run.get';
        const result = await nativeExecutor.execute(actionId, input, context);
        return result.ok ? result.result : result;
      } } });
    const executor = createActionExecutor({ ...deps, isActionEnabled: () => true, isActionApprovalRequired: () => false });
    const workflowContext = { surface: 'rpc' as const, authority: 'account_automation' as const,
      actionRequestId, executionRunTargetMachineId: 'machine-1',
      actionCaller: { kind: 'workflowRun' as const, runId: 'workflow-1', authorization: {
        admittedPermissionCeiling: 'read-only' as const, principal: { kind: 'host' as const },
      } },
      callerPermissionMode: 'read-only',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const },
    };
    try {
      const started = await executor.execute('execution.run.start', createDetachedTaskStartInput({ instructions: 'Keep exact input custody.' }), workflowContext);
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
      const actualRunId = manager.listPublic()[0]!.runId;
      expect(actualRunId === expectedRunId).toBe(!miswired);
      expect(manager.get(actualRunId)?.status).toBe('running');
      const reclaimed = await executor.execute('execution.run.get', { sessionId: null, runId: expectedRunId }, workflowContext);
      if (miswired) {
        expect(reclaimed).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        expect(manager.get(actualRunId)).not.toBeNull();
      } else {
        expect(reclaimed, JSON.stringify(reclaimed)).toMatchObject({ ok: true, result: { run: { runId: actualRunId } } });
        await expect(executor.execute('execution.run.start', createDetachedTaskStartInput({ instructions: 'Keep exact input custody.' }), workflowContext))
          .resolves.toMatchObject({ ok: true, result: { runId: actualRunId } });
        expect(manager.listPublic()).toHaveLength(1);
        await expect(executor.execute('execution.run.stop', { sessionId: null, runId: expectedRunId }, workflowContext))
          .resolves.toMatchObject({ ok: true });
        expect(manager.get(actualRunId)?.status).toBe('cancelled');
        expect(manager.listPublic()).toHaveLength(1);
      }
    } finally { releaseTurn(); await manager.dispose(); }
  });

  it('treats raw parent refs as correlation and keeps a human start at depth zero', async () => {
    const { manager, executor } = createDetachedStartHarness();
    try {
      const result = await executor.execute('execution.run.start', {
        ...createDetachedTaskStartInput({ instructions: 'Human-started task.' }),
        parentRunId: 'unknown-parent-run',
        parentCallId: 'unknown-parent-call',
      }, { surface: 'rpc' });
      expect(result).toMatchObject({ ok: true });
      expect(manager.listPublic()).toHaveLength(1);
      const runId = manager.listPublic()[0]!.runId;
      expect(manager.get(runId)?.depth).toBe(0);
    } finally {
      await manager.dispose();
    }
  });

  it.each([
    {
      name: 'materially different requests',
      secondInstructions: 'Second, materially different bounded task.',
    },
    {
      name: 'byte-identical repeated requests',
      secondInstructions: 'First bounded task.',
    },
  ] as const)('creates a distinct run per accepted start for %s that reuse one correlation id', async ({ secondInstructions }) => {
    const { manager, start, executor } = createDetachedStartHarness();

    try {
      const first = await executor.execute('execution.run.start', createDetachedTaskStartInput({
        instructions: 'First bounded task.',
        startRequestId: REUSED_START_REQUEST_ID,
      }), { surface: 'rpc' });
      const second = await executor.execute('execution.run.start', createDetachedTaskStartInput({
        instructions: secondInstructions,
        startRequestId: REUSED_START_REQUEST_ID,
      }), { surface: 'rpc' });

      expect(first).toMatchObject({ ok: true, result: { runId: expect.any(String) } });
      expect(second).toMatchObject({ ok: true, result: { runId: expect.any(String) } });

      const firstRunId = (first as { result: { runId: string } }).result.runId;
      const secondRunId = (second as { result: { runId: string } }).result.runId;
      // A reused correlation id must never resolve a caller onto an earlier run.
      expect(secondRunId).not.toBe(firstRunId);
      expect(manager.get(firstRunId)).not.toBeNull();
      expect(manager.get(secondRunId)).not.toBeNull();

      expect(start).toHaveBeenCalledTimes(2);
      for (const [startParams] of start.mock.calls) {
        // The reused value stays an inert passthrough input: nothing derives a
        // request fingerprint from it, so no second dispatch authority exists.
        expect(startParams).not.toHaveProperty('startRequestFingerprint');
      }
      for (const [marker] of markerWriterMock.writeExecutionRunMarker.mock.calls) {
        // The marker is diagnostic visibility, never a durable start receipt.
        expect(marker).not.toHaveProperty('startRequestId');
        expect(marker).not.toHaveProperty('startRequestFingerprint');
      }
    } finally {
      await manager.dispose();
    }
  });

  it('invokes the incumbent run manager exactly once for an ordinary start', async () => {
    const { manager, start, executor } = createDetachedStartHarness();

    try {
      const started = await executor.execute('execution.run.start', createDetachedTaskStartInput({
        instructions: 'Ordinary bounded task.',
      }), { surface: 'rpc' });

      expect(started).toMatchObject({ ok: true, result: { runId: expect.any(String) } });
      expect(start).toHaveBeenCalledTimes(1);
      expect(runtimeFactoryMock.createExecutionRunBridgeRuntime).toHaveBeenCalledTimes(1);
      expect(manager.listPublic()).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it('carries the runtime owner Account settings snapshot into execution-run runtime creation', async () => {
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation(() => (
      createTestExecutionRunHostRuntime() as ExecutionRunHostRuntime
    ));
    const ownerSnapshot = {
      source: 'cache' as const,
      settings: accountSettingsParse({}),
      settingsVersion: 7,
      loadedAtMs: 10,
      settingsSecretsReadKeys: [],
      scopeKey: 'account:owner',
    };
    const resolveAccountSettingsSnapshot = vi.fn(async () => ownerSnapshot);
    const managers: ExecutionRunHostBridge[] = [];
    const context = {
      sessionId: 'session-owner',
      cwd: process.cwd(),
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
      resolveAccountSettingsSnapshot,
      resolveRunReportPolicy: async () => ({ preset: 'important' }),
      onManagerCreated: (created: ExecutionRunHostBridge) => {
        managers.push(created);
      },
    } satisfies ExecutionRunRpcHandlerContext;

    registerExecutionRunRpcHandlers({ registerHandler: vi.fn() }, context);

    const manager = managers[0];
    if (!manager) {
      throw new Error('execution-run manager was not created');
    }

    try {
      await manager.start({
        sessionId: 'session-owner',
        intent: 'task',
        modelSelection: null,
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        instructions: 'Use the owning Account configuration.',
        intentInput: { input: { topic: 'runtime owner' } },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      const runtimeOptions = runtimeFactoryMock.createExecutionRunBridgeRuntime.mock.calls[0]?.[0] as
        | Readonly<{ resolveAccountSettingsSnapshot?: () => Promise<unknown> }>
        | undefined;
      expect(runtimeOptions?.resolveAccountSettingsSnapshot).toBeTypeOf('function');
      await expect(runtimeOptions!.resolveAccountSettingsSnapshot!()).resolves.toBe(ownerSnapshot);
    } finally {
      await manager.dispose();
    }
  });
});
