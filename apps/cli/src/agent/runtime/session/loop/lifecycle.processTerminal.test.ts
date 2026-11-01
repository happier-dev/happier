import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { registerRunnerTerminationHandlers, type RunnerTerminationHandlerRegistration } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import type { RunnerTerminationEvent } from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import type { Metadata } from '@/api/types';

import { runSessionLoopLifecycle } from './lifecycle';
import { createLifecycleParams, createMetadata } from './lifecycle.testkit';

afterEach(() => vi.restoreAllMocks());

describe('host process-terminal metadata publication', () => {
  it.each<{ event: RunnerTerminationEvent; stopped: boolean; runtimeEndCause?: 'providerEnded' | 'connectionLost'; terminalExitCode?: number }>([
    { event: { kind: 'killSession' }, stopped: true },
    { event: { kind: 'exit', code: 0 }, stopped: true },
    { event: { kind: 'signal', signal: 'SIGTERM' }, stopped: true },
    { event: { kind: 'uncaughtException', error: new Error('native crash') }, stopped: false },
    { event: { kind: 'exit', code: 1 }, stopped: false },
    // Codex's unexpected native exit currently arrives as providerEnded too.
    { event: { kind: 'exit', code: 0 }, stopped: false, runtimeEndCause: 'providerEnded' },
    { event: { kind: 'exit', code: 0 }, stopped: false, runtimeEndCause: 'connectionLost' },
    { event: { kind: 'exit', code: 0 }, stopped: true, terminalExitCode: 0 },
    { event: { kind: 'exit', code: 1 }, stopped: false, terminalExitCode: 1 },
  ])(
    'publishes stopped=$stopped for $event.kind/$runtimeEndCause/$terminalExitCode only after native disposal', async ({ event, stopped, runtimeEndCause, terminalExitCode }) => {
      const restoreHttp = installEmptyProjectAccountRowsHttpBoundary();
      const base = createLifecycleParams();
      const fixture = createMutableApiSessionClientFixture<Metadata>({ sessionId: 'session-1',
        metadata: { ...createMetadata(), lifecycleState: 'running', lifecycleStateSince: 1 } });
      let disposed = false;
      const ended: { metadata: Metadata | null } = { metadata: null };
      let runtimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      // The Session fixture replaces Home transport/persistence. Native runtime,
      // prompt loop, termination handler and resource disposal remain real.
      const session = Object.assign(fixture, {
        hasOwnerMetadataAuthority: () => true,
        updateMetadataAsCurrentPublisher: async (update: Parameters<typeof fixture.updateMetadataAsCurrentPublisher>[0]) => {
          expect(disposed).toBe(true);
          fixture.updateMetadata(current => {
            const next = update(current!);
            const projected = createSessionOwnerMetadataV1({ metadata: next });
            expect(projected.ok).toBe(true);
            if (projected.ok) expect(SessionOwnerMetadataV1Schema.parse(projected.ownerMetadata).runtime?.lifecycleState).toBe('stopped');
            return next;
          });
        },
        enqueueSessionEventCommitted: base.session.enqueueSessionEventCommitted,
        enqueueSessionTurnMutation: base.session.enqueueSessionTurnMutation,
        endSessionAndClose: async () => { ended.metadata = fixture.getMetadataSnapshot(); await fixture.close(); },
      });
      const provider: AgentSessionRuntime = {
        async send() { throw new Error('No input is queued'); },
        watch(listener) { runtimeEvent = listener; return { dispose() {} }; },
        dispose() { disposed = true; },
      };
      const runtime = createNativeAgentSessionOperations(provider, 'session-1', undefined, undefined, undefined, undefined, undefined, {
        context: {} as AgentSessionRuntimeContext, cwd: '/tmp/project', connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
      });
      const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
        mode => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
      let termination: RunnerTerminationHandlerRegistration | undefined;
      const startedAt = Date.now();
      const run = runSessionLoopLifecycle({ ...base, session, runtime, hookRuntime: runtime,
        ...(terminalExitCode !== undefined ? { terminalRemoteModeLoop: {
          startingMode: 'terminal' as const, remoteExitCode: 0, topology: 'shared' as const, remoteWritable: true,
          runTerminal: async () => ({ type: 'exit' as const, code: terminalExitCode }),
          runRemote: async () => 'exit' as const, onModeChange() {},
        } } : {}),
        permissionModeState: { ...base.permissionModeState, messageQueue: queue },
        config: { ...base.config, lifecycleHooks: { createCheckpointLifecycle: () => ({}) } },
        deps: {
          runPermissionModePromptLoopFn: runPermissionModePromptLoop,
          cleanupBackendRunResourcesFn: cleanupBackendRunResources,
          registerRunnerTerminationHandlersFn: params => {
            termination = registerRunnerTerminationHandlers({ ...params, process: new EventEmitter(), exit() {} });
            return termination;
          },
        },
      });
      let runSettled = false;
      try {
        await vi.waitFor(() => expect(termination).toBeDefined());
        if (terminalExitCode === undefined) {
          if (runtimeEndCause) {
            runtimeEvent!(AgentSessionRuntimeEventV1Schema.parse({ kind: 'runtime-ended', cause: runtimeEndCause,
              retryable: false, sessionId: 'session-1', sequence: 1, emittedAtMs: Date.now() }));
          } else termination!.requestTermination(event);
          await termination!.whenTerminated;
        }
        await run;
        runSettled = true;
        expect(disposed).toBe(true);
        expect(ended.metadata?.lifecycleState).toBe(stopped ? 'stopped' : 'running');
        if (stopped) expect(ended.metadata?.lifecycleStateSince).toBeGreaterThanOrEqual(startedAt);
        else expect(ended.metadata?.lifecycleStateSince).toBe(1);
      } finally {
        if (!runSettled) termination?.requestTermination({ kind: 'killSession' });
        await run;
        restoreHttp();
      }
    });
});
