import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema, type SessionTurnMutationV1 } from '@happier-dev/protocol';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createLifecycleParams, createMetadata } from './lifecycle.testkit';
import { runSessionLoopLifecycle } from './lifecycle';

it('persists native rollback eligibility after the completed turn enters durable custody', async () => {
  const restoreHttp = installEmptyProjectAccountRowsHttpBoundary();
  const registry = await pluginReloadController.acquireRuntimeRegistry({
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
      contributes: getResolvedContributionRegistry(), pluginIds: [],
    }),
  });
  const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
  const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
  const persisted: SessionTurnMutationV1[] = [];
  let completeEntered = false;
  let releaseComplete!: () => void;
  const completeHeld = new Promise<void>(resolve => { releaseComplete = resolve; });
  const session = createMutableApiSessionClientFixture({
    sessionId: 'session-1', metadata: createMetadata(),
    overrides: {
      // Durable mutation transport and the vendor runtime are system boundaries.
      enqueueSessionTurnMutation: async mutation => {
        if (mutation.action === 'complete') {
          completeEntered = true;
          await completeHeld;
        }
        persisted.push(mutation);
      },
      enqueueSessionEventCommitted: async () => ({ persisted: true as const, delivered: false as const }),
    },
  });
  let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
  let sequence = 0;
  const emit = (event: Readonly<Record<string, unknown>>) => {
    if (!listener) throw new Error('Native runtime subscription missing');
    listener(AgentSessionRuntimeEventV1Schema.parse({ sessionId: session.sessionId, sequence: ++sequence,
      emittedAtMs: sequence, ...event }));
  };
  const provider: AgentSessionRuntime = {
    async send(request) {
      const turnId = request.delivery.turnId;
      emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      emit({ kind: 'turn-start', turnId, agentTurnId: 'vendor-turn-1', startedBy: 'host' });
      emit({ kind: 'turn-complete', turnId, agentTurnId: 'vendor-turn-1' });
      emit({ kind: 'turn-rollback-boundary', turnId, agentTurnId: 'vendor-turn-1', providerCheckpoint: 'vendor-turn-1' });
      return { status: 'admitted' };
    },
    watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
    dispose() {},
  };
  const runtime = createNativeAgentSessionOperations(provider, session.sessionId,
    undefined, undefined, undefined, undefined, undefined, {
      context: {} as AgentSessionRuntimeContext, cwd: '/tmp/project', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
  let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
  const running = runSessionLoopLifecycle({ ...base, session, runtime, hookRuntime: runtime,
    config: { ...base.config, startRuntimeBeforeFirstPrompt: true,
      onAfterStart: async () => {
        await runtime.sendTurnPrompt('Complete a native turn', {
          turnId: 'host-turn-1', localId: 'rollback-input', userMessageSeq: 7,
        });
      },
      lifecycleHooks: { createCheckpointLifecycle: () => ({}) },
    },
    permissionModeState: { ...base.permissionModeState, messageQueue: queue },
    deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
      registerRunnerTerminationHandlersFn: options => {
        termination = registerRunnerTerminationHandlers({ ...options, processLifecycleOwnership: 'caller',
          sessionExitReport: null, exit: () => undefined });
        return termination;
      },
    },
  });
  try {
    await vi.waitFor(() => expect(completeEntered).toBe(true));
    expect(persisted.some(mutation => mutation.action === 'mark_rollback_eligible')).toBe(false);
    releaseComplete();
    await vi.waitFor(() => expect(persisted).toContainEqual(expect.objectContaining({
      action: 'mark_rollback_eligible', agentTurnId: 'vendor-turn-1',
      transcriptAnchors: { startUserMessageSeq: 7, providerCheckpoint: 'vendor-turn-1' },
    })));
    expect(persisted.findIndex(mutation => mutation.action === 'complete')).toBeLessThan(
      persisted.findIndex(mutation => mutation.action === 'mark_rollback_eligible'));
  } finally {
    releaseComplete();
    termination?.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
    await running.catch(() => undefined);
    await registry.release();
    restoreHttp();
  }
});
