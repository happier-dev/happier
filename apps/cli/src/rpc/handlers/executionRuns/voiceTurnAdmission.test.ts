import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';

import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { createDaemonApprovalExecutionOriginCurrentness } from '@/daemon/externalActions/daemonExternalActionTargetResolver';

import { createExecutionRunRpcActionDeps } from './dispatchExecutionRunRpcAction';
import { registerExecutionRunRpcHandlers } from './registerExecutionRunRpcHandlers';

describe('Voice run caller-turn admission', () => {
  let directory: string;
  const managers: ExecutionRunHostBridge[] = [];
  const scope = 'voice-session';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-voice-turn-admission-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });

  async function retainRun(intent: ExecutionRunState['intent'] = 'voice_agent', sessionId: string | null = scope) {
    const run: ExecutionRunState = {
      runId: 'voice-run', callId: 'voice-call', sidechainId: 'voice-sidechain',
      sessionId, depth: 0, intent,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
      instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming', status: 'cancelled',
      startedAtMs: 1, finishedAtMs: 2,
    };
    await retainExecutionRunState(run);
    return run;
  }

  function createManager() {
    const manager = new ExecutionRunHostBridge({ parentProvider: 'claude', cwd: directory, sendAcp: async () => {} });
    managers.push(manager);
    return manager;
  }

  function createDeps(manager: ExecutionRunHostBridge, sessionId: string | null = scope) {
    return createExecutionRunRpcActionDeps({
      manager, context: { sessionId, cwd: directory },
      policy: resolveExecutionRunPolicy({ defaults: {
        maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null,
      } }), isExecutionRunsEnabled: () => true,
    });
  }

  // These are call-through observations of the real manager. The retained-run
  // fixture exercises refusal before a recoverable run can receive caller input;
  // provider delivery is a separate composed live check.
  it.each([
    { kind: 'stream', sessionId: scope },
    { kind: 'send', sessionId: null },
    { kind: 'welcome', sessionId: scope },
  ] satisfies Array<
    | { kind: 'stream'; sessionId: Parameters<NonNullable<ActionExecutorDeps['executionRunStreamStart']>>[0] }
    | { kind: 'send'; sessionId: Parameters<NonNullable<ActionExecutorDeps['detachedExecutionRunSend']>>[0] }
    | { kind: 'welcome'; sessionId: Parameters<ActionExecutorDeps['executionRunAction']>[0] }
  >)('refuses automation $kind input before the real manager receives it', async (input) => {
    const { sessionId } = input;
    await retainRun('voice_agent', sessionId);
    const manager = createManager();
    await manager.recoverRetainedRuns();
    const before = structuredClone(manager.get('voice-run'));
    const stream = vi.spyOn(manager, 'startTurnStream');
    const send = vi.spyOn(manager, 'send');
    const action = vi.spyOn(manager, 'applyAction');
    const deps = createDeps(manager, sessionId);
    const opts = { authority: 'account_automation' as const };
    const result = input.kind === 'stream'
      ? await deps.executionRunStreamStart!(input.sessionId, { runId: 'voice-run', message: 'Agent input' }, opts)
      : input.kind === 'send'
        ? await deps.detachedExecutionRunSend!(input.sessionId, { runId: 'voice-run', message: 'Agent input' }, opts)
        : await deps.executionRunAction(input.sessionId, { runId: 'voice-run', actionId: 'voice_agent.welcome', input: { welcomeText: 'Agent input' } }, opts);
    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(manager.get('voice-run')).toEqual(before);
    expect(stream).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('fails absent authority closed for a local caller', async () => {
    await retainRun();
    const manager = createManager();
    const stream = vi.spyOn(manager, 'startTurnStream');
    const result = await createDeps(manager).executionRunStreamStart!(scope, { runId: 'voice-run', message: 'Unstamped input' });
    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(['ui.voice_global.start', 'ui.voice_global.recover'] as const)('approval for Agent %s does not grant control of the resulting Voice run', async (actionId) => {
    const manager = createManager();
    let approval: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    let clientOpened = false;
    const coordinator = createBlockingApprovalCoordinator();
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { notifyWaiting = resolve; });
    const approvalsWaitForDecision: NonNullable<ActionExecutorDeps['approvalsWaitForDecision']> = async (args) => {
      const pendingDecision = coordinator.waitForDecision(args);
      notifyWaiting();
      const decision = await pendingDecision;
      // This Action fixture accepts Action approval requests, not the other
      // request families supported by the shared blocking coordinator.
      return { ...decision, request: ApprovalRequestSchema.parse(decision.request) };
    };
    const executor = createActionExecutor({
      ...createDeps(manager),
      // Artifact persistence and client placement are external boundaries. All
      // approval decisions, replay authority and run ingress remain real.
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'voice-open-approval' }; },
      approvalsGet: async () => approval,
      approvalsWaitForDecision,
      approvalsResolveBlockingDecision: async (args) => {
        return await coordinator.resolveBlockingDecision({ ...args, request: ApprovalRequestSchema.parse(args.request) });
      },
      approvalsUpdate: async ({ request }) => {
        if (!approval) throw new Error('Approval was not persisted');
        const transition = decideApprovalRequestTransition(approval, request);
        if (!transition.ok) return transition;
        approval = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
        accountId: 'account', machineId: 'voice-machine', serverId: 'home',
        // The Home descriptor/Machine observation is the network boundary.
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home-identity', machineId: 'voice-machine' }),
        resolveTarget: async () => { throw new Error('Global Voice must not resolve a Session replay target'); },
        listAccountApiTokens: async () => ({ tokens: [] }),
        resolveCurrentSessionAgentSpawnPolicyV1: async () => DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      }),
      clientActionExecute: async () => {
        await retainRun();
        clientOpened = true;
        return { ok: true, result: { status: 'completed', voice: {
          attemptId: 'voice-attempt', adapterId: 'local', sessionId: scope, status: 'connected', mode: 'listening',
          target: { kind: 'global' }, conversationSessionAddress: { serverId: 'home', sessionId: scope },
          targetSessionAddress: null, canStart: false, canStop: true, canMute: true, canCommitInput: true,
          canHoldToTalk: true, muted: false, canDismissFailedAttempt: false, canDismissEnded: false,
          recoveryAction: null, availability: 'ready',
        } } };
      },
    });
    const agent = {
      surface: 'agent', authority: 'account_automation', serverId: 'home', actionCaller: { kind: 'host' },
      actionRequestId: 'voice-open-request', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
    } satisfies ActionExecutorContext;
    const input = actionId === 'ui.voice_global.start'
      ? { target: { kind: 'global' }, expectedAttempt: null }
      : { expectedAttempt: 'voice-attempt' };
    const opening = executor.execute(actionId, input, agent);
    await waiting;
    expect(approval).toMatchObject({ status: 'open', actionId, approval: { flow: 'blocking' } });
    expect(clientOpened).toBe(false);
    expect(await executor.execute('approval.request.decide', { artifactId: 'voice-open-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { status: 'approved' } });
    const opened = await opening;
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, result: { status: 'completed' } });
    expect(clientOpened).toBe(true);
    await manager.recoverRetainedRuns();
    const before = structuredClone(manager.get('voice-run'));
    const stream = vi.spyOn(manager, 'startTurnStream');
    const action = vi.spyOn(manager, 'applyAction');
    const turnCaller = { ...agent, defaultSessionId: scope, callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    } satisfies ActionExecutorContext;
    expect(await executor.execute('execution.run.stream.start', { sessionId: scope, runId: 'voice-run', message: 'Agent turn' }, turnCaller))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(await executor.execute('execution.run.action', {
      sessionId: scope, runId: 'voice-run', actionId: 'voice_agent.welcome', input: { welcomeText: 'Agent welcome' },
    }, turnCaller)).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(manager.get('voice-run')).toEqual(before);
    expect(stream).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    { intent: 'voice_agent', authority: 'present_user' },
    { intent: 'delegate', authority: 'account_automation' },
  ] as const)('preserves existing admission for $authority into $intent', async ({ intent, authority }) => {
    await retainRun(intent);
    const manager = createManager();
    const stream = vi.spyOn(manager, 'startTurnStream');
    const result = await createDeps(manager).executionRunStreamStart!(scope, { runId: 'voice-run', message: 'Allowed input' }, { authority });
    // A retained stopped run has no live provider. This asserts unchanged ingress,
    // not successful turn delivery.
    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(stream).toHaveBeenCalledWith('voice-run', expect.objectContaining({ message: 'Allowed input' }));
  });

  it('applies the same admission to transcript-aware RPC streams', async () => {
    await retainRun();
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    let manager: ExecutionRunHostBridge | undefined;
    registerExecutionRunRpcHandlers({ registerHandler(method, handler) {
      handlers.set(method, handler as RpcHandler<unknown, unknown>);
    } }, {
      sessionId: scope, cwd: directory, parentProvider: 'claude', sendAcp: async () => {},
      executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
      getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } } }) }),
      onManagerCreated(created) { manager = created; managers.push(created); },
    });
    if (!manager) throw new Error('Voice RPC manager was not created');
    const stream = vi.spyOn(manager, 'startTurnStream');
    const handler = handlers.get(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2);
    if (!handler) throw new Error('Voice transcript stream handler was not registered');
    const context = { signal: new AbortController().signal, callerAuthority: 'account_automation' } satisfies RpcHandlerContext;
    await expect(handler({ runId: 'voice-run', message: 'Agent input', userTranscript: { mode: 'suppress' } }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(stream).not.toHaveBeenCalled();
    await handler({ runId: 'voice-run', message: 'Human input', userTranscript: { mode: 'suppress' } }, { ...context, callerAuthority: 'present_user' });
    expect(stream).toHaveBeenCalledWith('voice-run', expect.objectContaining({ message: 'Human input', userTranscript: { mode: 'suppress' } }));
  });
});
