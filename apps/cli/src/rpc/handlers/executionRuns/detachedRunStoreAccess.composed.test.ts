import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunRequestBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import { registerExecutionRunRpcHandlers } from './registerExecutionRunRpcHandlers';
import { ensureExecutionRun } from '@/agent/runtime/bridges/executionRun/ensureExecutionRun';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

let manager: ExecutionRunHostBridge | undefined;
let directory: string | undefined;
let registration: ReturnType<typeof registerExecutionRunRpcHandlers> | undefined;
afterEach(async () => {
  registration?.dispose();
  registration = undefined;
  await manager?.dispose();
  vi.unstubAllEnvs();
  reloadConfiguration();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('a newly registered detached Run reader inherits store isolation without an ingress predicate', async () => {
  directory = await mkdtemp(join(tmpdir(), 'happier-run-store-access-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
  const run: ExecutionRunState = {
    runId: 'owned-run', callId: 'call', sidechainId: 'sidechain', sessionId: null,
    depth: 0, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
    instructions: 'Private owner content', permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass: 'bounded', ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, finishedAtMs: 2,
    requesterWorkAttributionV1: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' },
  };
  await retainExecutionRunState(run);
  await retainExecutionRunState({ ...run, runId: 'foreign-run', startedAtMs: 3,
    requesterWorkAttributionV1: { ...run.requesterWorkAttributionV1!, accountId: 'foreign' } });
  await retainExecutionRunState({ ...run, runId: 'legacy-run', requesterWorkAttributionV1: undefined });
  await retainExecutionRunState({ ...run, runId: 'attached-run', sessionId: 'attached-session' });
  const store = manager = new ExecutionRunHostBridge({ parentProvider: 'daemon.executionRuns', cwd: directory,
    runtimeAccountId: 'different-installed-owner', sendAcp: async () => {} });
  const recovery = vi.spyOn(store, 'recoverRetainedRuns');
  const requestStore: ExecutionRunRequestBridgeContract = store;
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
  // A future handler adds no ownership comparison: its only read is the store accessor.
  rpc.registerHandler('new-detached-run-reader', async (input: { runId: string }, context) =>
    requestStore.getForRequest(input.runId, null, projectRpcRequesterWorkAttribution(context, 'home')));
  const read = (input: { runId: string }, rpcContext?: RpcHandlerContext) =>
    rpc.invokeLocal('new-detached-run-reader', input, { rpcContext });
  const requester = (accountId: string): RpcHandlerContext => ({ signal: new AbortController().signal,
    machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage', encryptionMode: 'plain' } });
  expect(await read({ runId: run.runId }, requester('owner'))).toMatchObject({ instructions: run.instructions });
  expect(await read({ runId: run.runId }, requester('foreign'))).toBeNull();
  expect(await read({ runId: 'legacy-run' }, requester('owner'))).toBeNull();
  expect(await read({ runId: 'legacy-run' }, requester('different-installed-owner'))).toMatchObject({ runId: 'legacy-run' });
  expect(await read({ runId: run.runId }, undefined)).toBeNull();
  expect(await store.getForRequest(run.runId, 'other-session', run.requesterWorkAttributionV1)).toBeNull();
  expect(await store.getForRequest('attached-run', 'attached-session', undefined)).toMatchObject({ runId: 'attached-run' });
  expect(await store.getForRequest('attached-run', null, run.requesterWorkAttributionV1)).toBeNull();
  expect(requestStore.hasAttachedRun(run.runId)).toBe(false);
  expect(requestStore.hasAttachedRun('legacy-run')).toBe(false);
  expect(store.listPublicForRequest({ limit: 1 }, null, run.requesterWorkAttributionV1))
    .toMatchObject([{ runId: run.runId }]);
  expect(store.listPublicForRequest({}, null, undefined)).toBeNull();
  // One cold lookup recovers; warm owner/foreign/ownerless reads do no more storage work.
  expect(recovery).toHaveBeenCalledOnce();
});

it('Run ingress modules cannot read the unscoped store or choose their own list predicate', async () => {
  const paths = ['dispatchExecutionRunRpcAction.ts', 'registerExecutionRunRpcHandlers.ts', '../../../api/machine/rpcHandlers.ts'];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    // Host lifecycle APIs remain available inside the runtime; public ingress uses request reads.
    expect(source.match(/\b(?:manager|detachedExecutionRunManager)\.(?:get|getPublic|listPublic|getStructuredMeta|getLatestToolResult|getDepthByRunId|getDepthByCallId)\s*\(/g), path).toBeNull();
    expect(source.includes('checkDetachedExecutionRunAccount'), path).toBe(false);
  }
});

it('keeps an unattributed 0.2-shaped retained Run readable, resumable and stoppable by the installed Account', async () => {
  directory = await mkdtemp(join(tmpdir(), 'happier-predecessor-run-owner-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
  // 0.2 startExecutionRun.ts:224-260 captures launch and resume state without
  // requester attribution. Persist those fields through the current storage owner.
  const run: ExecutionRunState = {
    runId: 'predecessor-run', callId: 'predecessor-call', sidechainId: 'predecessor-side', sessionId: null,
    depth: 0, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'test.agent' }, backendId: 'test.agent',
    instructions: 'Continue the original task', permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass: 'long_lived', ioMode: 'streaming', status: 'cancelled', startedAtMs: 1, finishedAtMs: 2,
    launch: { modelId: 'original-model' },
    resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'test.agent' }),
      providerSessionId: 'original-thread' },
  };
  await retainExecutionRunState(run);
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
  registration = registerExecutionRunRpcHandlers(rpc, {
    sessionId: null, serverId: 'home', parentProvider: 'daemon.executionRuns', cwd: directory,
    runtimeAccountId: 'installed-owner', sendAcp: async () => {}, onManagerCreated: created => { manager = created; },
  });
  if (!manager) throw new Error('Missing registered Run store');
  const store = manager;
  const context = (accountId: string): RpcHandlerContext => ({ signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: accountId, custodianAccountId: 'installed-owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const } });
  const owner = context('installed-owner');
  const foreign = context('foreign');
  const invoke = (method: string, input: object, rpcContext: RpcHandlerContext) => rpc.invokeLocal(method, input, { rpcContext });
  for (const actionId of ['execution.run.get', 'execution.run.stop', 'execution.run.ensure'] as const) {
    expect(await invoke(actionId, { runId: run.runId, ...(actionId.endsWith('ensure') ? { resume: true } : {}) }, foreign))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
  }
  expect(await invoke('execution.run.get', { runId: run.runId }, owner))
    .toMatchObject({ run: { runId: run.runId } });
  const admitted = await store.getForRequest(run.runId, null, projectRpcRequesterWorkAttribution(owner, 'home'));
  if (!admitted) throw new Error('Installed owner lost its predecessor Run');
  expect(store.listPublicForRequest({}, null, projectRpcRequesterWorkAttribution(owner, 'home')))
    .toMatchObject([{ runId: run.runId }]);
  expect(store.listPublicForRequest({}, null, projectRpcRequesterWorkAttribution(foreign, 'home'))).toEqual([]);
  expect(admitted.requesterWorkAttributionV1).toBeUndefined();
  // External Agent runtime is the system boundary. Resume selection and
  // lifecycle run through the same real owner helper used by the bridge.
  let resumedThread: string | undefined;
  let cancelled = false;
  const runtime = createTestExecutionRunHostRuntime({ resumeSupported: true, replayResumeSupported: true,
    onProvisionRuntime: input => { resumedThread = input?.resumeRuntimeId; }, onCancel: () => { cancelled = true; } });
  // Inspect the bridge-owned fixture state to inject only the external Agent
  // runtime into its real resume helper, without replacing any admission logic.
  const { runs, controllers } = store as unknown as {
    runs: Map<string, ExecutionRunState>; controllers: Map<string, ExecutionRunController>;
  };
  const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime,
    resolvePromptPreparation: async () => ({ systemAppendBlocks: [], memoryRecallGuidanceEnabled: false, disabledActionIds: [] }),
    responseTimeoutMs: 1_000 });
  try {
    expect(await ensureExecutionRun({ runId: run.runId, params: { resume: true }, runs, controllers,
      budgetRegistry: null, createRuntime: () => runtime, sendAcp: async () => {}, parentProvider: 'test.agent',
      streamedTranscriptSession: null, getNowMs: () => 3, writeActivityMarker: async () => {}, voiceAgentManager }))
      .toEqual({ ok: true });
    expect(resumedThread).toBe('original-thread');
    expect(store.get(run.runId)).toMatchObject({ status: 'running', launch: run.launch, resumeHandle: run.resumeHandle });
    expect(await invoke('execution.run.stop', { runId: run.runId }, foreign))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    expect(store.get(run.runId)?.status).toBe('running');
    expect(cancelled).toBe(false);
    expect(await invoke('execution.run.stop', { runId: run.runId }, owner))
      .toMatchObject({ ok: true });
    expect(store.get(run.runId)?.status).toBe('cancelled');
    expect(cancelled).toBe(true);
  } finally {
    await runtime.dispose();
  }
});
