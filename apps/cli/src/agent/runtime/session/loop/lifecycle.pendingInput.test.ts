import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol';

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

describe('native turn completion and Pending delivery', () => {
  it.each(['during native turn', 'after native completion'] as const)(
    'drains a multiline Pending input arriving %s', async timing => {
    const restoreHttp = installEmptyProjectAccountRowsHttpBoundary();
    const registry = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(), pluginIds: [],
      }),
    });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    let pending = timing === 'during native turn';
    let materializations = 0;
    const prompt = 'Queued multiline input\nSECOND-LINE';
    const session = createMutableApiSessionClientFixture({
      sessionId: 'session-1', metadata: createMetadata(),
      overrides: {
        getPendingQueueState: () => ({ known: true, pendingCount: pending ? 1 : 0, pendingBlockedCount: 0, pendingVersion: 1 }),
        shouldAttemptPendingMaterialization: () => pending,
        materializeNextPendingMessageSafely: async () => {
          if (!pending) return { type: 'no_pending' as const };
          materializations += 1;
          pending = false;
          queue.push({ text: prompt, localId: 'pending-multiline' }, { permissionMode: 'default' });
          return { type: 'materialized' as const, localId: 'pending-multiline', seq: 1, content: null };
        },
        enqueueSessionTurnMutation: async () => undefined,
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
    // Only the external Agent and server transport are fixtures. Host admission,
    // lifecycle, pending materialization and the prompt loop are production code.
    const provider: AgentSessionRuntime = {
      async send(request) {
        emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        emit({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
        emit({ kind: 'turn-complete', turnId: request.delivery.turnId });
        return { status: 'admitted' };
      },
      watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
      dispose() {},
    };
    const runtime = createNativeAgentSessionOperations(provider, session.sessionId,
      undefined, undefined, undefined, undefined, undefined, {
        // No optional host service is used by this external Agent fixture.
        context: {} as AgentSessionRuntimeContext, cwd: '/tmp/project', connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
      });
    let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
    let nativeStarted = false;
    const running = runSessionLoopLifecycle({ ...base, session, runtime, hookRuntime: runtime,
      config: { ...base.config, startRuntimeBeforeFirstPrompt: true,
        onAfterStart: () => {
          nativeStarted = true;
          emit({ kind: 'turn-start', turnId: 'terminal-origin-turn', startedBy: 'provider' });
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
      await vi.waitFor(() => expect(nativeStarted).toBe(true));
      await setImmediate();
      expect(base.messageBuffer.getMessages().filter(message => message.type === 'user')).toEqual([]);
      expect(materializations).toBe(0);
      emit({ kind: 'turn-complete', turnId: 'terminal-origin-turn' });
      if (timing === 'after native completion') {
        await setImmediate();
        pending = true;
        // Simulate the server's Pending-arrival wake after the native turn is
        // already idle; no second completion event is available for this input.
        session.updateMetadata(() => ({ ...createMetadata() }));
      }
      await vi.waitFor(() => expect({ materializations, pending,
        userEcho: base.messageBuffer.getMessages().filter(message => message.type === 'user').map(message => message.content),
      }).toEqual({ materializations: 1, pending: false,
        userEcho: [prompt] }));
    } finally {
      termination?.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
      await running.catch(() => undefined);
      await registry.release();
      restoreHttp();
    }
  });
});
