import { describe, expect, it, vi } from 'vitest';

import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { CliRuntimeCore } from '../engineRegistryTypes';
import { bindPluginContextToRuntimeCore } from './runtimeCoreBinding';
import type {
  BoundContextScope,
  HostSessionContextScope,
  PluginContextV1Binder,
} from './pluginContext/binder';

function createRuntimeOperations(sendTurnPrompt: RuntimeTurnOperations['sendTurnPrompt']): RuntimeTurnOperations {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => undefined),
    sendTurnPrompt,
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: null })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
}

function createHostScope(runtimeParams: HostSessionRuntimeFactoryParams): HostSessionContextScope {
  return Object.freeze({
    kind: 'hostSession' as const,
    serverId: 'srv_test',
    machineId: runtimeParams.machineId,
    rootPath: runtimeParams.directory,
    getSession: () => runtimeParams.session,
    getTranscriptSession: () => runtimeParams.transcriptSession,
    messageQueue: runtimeParams.messageQueue,
    getPermissionHandler: () => runtimeParams.permissionHandler,
    getPermissionMode: () => runtimeParams.getPermissionMode(),
  });
}

describe('bindPluginContextToRuntimeCore', () => {
  it('runs deferred host-session runtime operations under the materialized session scope', async () => {
    let activeScope: BoundContextScope | null = null;
    const enqueueRegisteredSessionStateFieldMutation = vi.fn(async () => undefined);
    const session = {
      sessionId: 'session-1',
      enqueueRegisteredSessionStateFieldMutation,
    };
    const binder: PluginContextV1Binder = {
      bindHostSessionRuntime: vi.fn((runtimeParams) => {
        const scope = createHostScope(runtimeParams);
        activeScope = scope;
        return scope;
      }),
      resolveTerminalRuntimeHostOrchestration: vi.fn(() => null),
      bindExecutionRun: vi.fn(() => {
        throw new Error('execution-run scope should not be used by this test');
      }),
      grantExternalSessionTranscriptPath: vi.fn(async () => undefined),
      revokeTranscriptFileFollowScope: vi.fn(async () => undefined),
      runWithTranscriptFileFollowSession: vi.fn(async (_sessionId, fn) => await fn()),
      runWithScope: vi.fn((scope, fn) => {
        const previousScope = activeScope;
        activeScope = scope;
        try {
          return fn();
        } finally {
          activeScope = previousScope;
        }
      }),
    };
    const operations = createRuntimeOperations(async () => {
      if (activeScope?.kind !== 'hostSession') {
        throw new Error('host session scope unavailable');
      }
      const scopedSession = activeScope.getSession();
      await scopedSession.enqueueRegisteredSessionStateFieldMutation?.({
        v: 1,
        sessionId: scopedSession.sessionId,
        mutationId: 'mutation-1',
        fieldId: 'identity.providerSessionId',
        deliveryClass: 'durable_best_effort',
        op: {
          kind: 'set',
          value: {
            metadataKey: 'opencodeSessionId',
            value: 'oc-session-1',
          },
        },
        source: 'runtime',
        observedAt: 1,
      });
    });
    const rawRuntimeCore: CliRuntimeCore = {
      createSessionRuntime: vi.fn(async (): Promise<HostSessionRuntimePlan> => ({
        kind: 'hostSessionRuntimePlan',
        agentId: 'acme.backend',
        opts: {} as never,
        config: {
          createSessionRuntime: vi.fn(async () => ({
            operations,
            nativeRuntime: operations,
          })),
        } as never,
      })),
      createExecutionRunBackend: vi.fn(() => {
        throw new Error('execution-run runtime should not be used by this test');
      }) as never,
    };

    const wrappedRuntimeCore = bindPluginContextToRuntimeCore(rawRuntimeCore, binder);
    const plan = await wrappedRuntimeCore.createSessionRuntime({ cwd: '/repo' });
    const createdRuntime = await plan.config.createSessionRuntime?.({
      directory: '/repo',
      metadata: {} as never,
      machineId: 'machine-1',
      session: session as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });
    if (!createdRuntime) throw new Error('expected created runtime');

    activeScope = null;
    await expect(createdRuntime.operations.sendTurnPrompt('hello')).resolves.toBeUndefined();

    expect(binder.runWithScope).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hostSession',
      rootPath: '/repo',
    }), expect.any(Function));
    expect(enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      fieldId: 'identity.providerSessionId',
      deliveryClass: 'durable_best_effort',
    }));
  });
});
