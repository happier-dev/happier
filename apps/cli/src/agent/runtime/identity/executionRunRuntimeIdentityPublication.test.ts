import { describe, expect, it, vi } from 'vitest';
import { normalizePluginBackendCapabilitiesV1 } from '@happier-dev/protocol';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  createEmptyBackendExecutionSurfaces,
  type EngineAdapterResolution,
} from '@/agent/runtime/registry/engineRegistryTypes';
import {
  buildExecutionRunRuntimeIdentityPublication,
  withExecutionRunRuntimeIdentityPublication,
} from './executionRunRuntimeIdentityPublication';

function createMinimalRuntime(): ExecutionRunHostRuntime {
  let handler: ExecutionRunHostRuntimeMessageHandler | null = null;
  return {
    async readResumeSupport() {
      return false;
    },
    async provisionSession() {
      return { sessionId: 'runtime-session-1' };
    },
    async sendPrompt(_sessionId, prompt) {
      handler?.({ type: 'model-output', fullText: prompt } satisfies AgentMessage);
    },
    async cancel() {},
    subscribeMessages(next) {
      handler = next;
      return () => {
        if (handler === next) {
          handler = null;
        }
      };
    },
    async dispose() {},
  };
}

function createEngineResolution(
  backendCapabilities: EngineAdapterResolution['backend']['capabilities'],
): EngineAdapterResolution {
  return {
    backendId: 'acme.backend',
    agentId: 'acme.provider',
    provenance: 'external',
    runtimeOwner: {
      backendId: 'acme.backend',
      selected: {
        kind: 'plugin_engine',
        ownerId: 'acme.plugin',
        provenance: 'external',
        pluginId: 'acme.plugin',
      },
      candidates: [{
        kind: 'plugin_engine',
        ownerId: 'acme.plugin',
        provenance: 'external',
        pluginId: 'acme.plugin',
      }],
    },
    backend: {
      id: 'acme.backend',
      agentId: 'acme.provider',
      provenance: 'external',
      source: { kind: 'path' },
      definition: {
        kindVersion: 1,
        id: 'acme.backend',
        agentId: 'acme.provider',
      },
      runtimeKind: 'plugin',
      capabilities: backendCapabilities,
    },
    provider: {
      id: 'acme.provider',
      provenance: 'external',
      source: { kind: 'path' },
      definition: {
        kindVersion: 1,
        id: 'acme.provider',
        ownedBackendIds: ['acme.backend'],
      },
    },
    engineAdapter: {
      runtimeCore: {
        createSessionRuntime() {
          throw new Error('unused test runtime');
        },
        createExecutionRunBackend() {
          return createMinimalRuntime();
        },
      },
    },
    executionSurfaces: createEmptyBackendExecutionSurfaces(),
    diagnostics: [],
  };
}

describe('withExecutionRunRuntimeIdentityPublication', () => {
  it('derives top-level execution-run publication from nested backend capabilities', () => {
    const identity = buildExecutionRunRuntimeIdentityPublication(
      createEngineResolution(normalizePluginBackendCapabilitiesV1({
        executionRun: { supported: false },
      })),
    );

    expect(identity.runtimeCapabilities).toMatchObject({
      executionRun: { supported: false },
      backend: {
        executionRun: { supported: false },
        session: {
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
        },
      },
    });
  });

  it('preserves optional ExecutionRunHostRuntime method presence', () => {
    const runtime = withExecutionRunRuntimeIdentityPublication({
      runtime: createMinimalRuntime(),
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: { executionRun: { supported: true } },
        runtimeFacets: null,
      },
    });

    expect(runtime.sendSteerPrompt).toBeUndefined();
    expect(runtime.respondToPermission).toBeUndefined();
    expect(runtime.waitForTurnCompletion).toBeUndefined();
  });

  it('preserves dynamic permission response capability after startup', async () => {
    let started = false;
    const respondToPermission = vi.fn(async () => ({ delivered: true as const }));
    const runtime = withExecutionRunRuntimeIdentityPublication({
      runtime: {
        ...createMinimalRuntime(),
        get permissionCapability() {
          return started ? 'responds' as const : undefined;
        },
        get respondToPermission() {
          return started ? respondToPermission : undefined;
        },
        async provisionSession() {
          started = true;
          return { sessionId: 'runtime-session-1' };
        },
      },
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: { executionRun: { supported: true } },
        runtimeFacets: null,
      },
    });

    expect(runtime.permissionCapability).toBeUndefined();
    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'runtime-session-1' });
    expect(runtime.permissionCapability).toBe('responds');
    expect(runtime.respondToPermission).toBeTypeOf('function');
    await expect(runtime.respondToPermission?.('permission-1', true)).resolves.toEqual({ delivered: true });
    expect(respondToPermission).toHaveBeenCalledWith('permission-1', true);
  });

  it('publishes fallback identity after startup when the backend is silent', async () => {
    const identity = {
      runtimeDescriptor: {
        v: 1,
        agentId: 'acme.provider',
        agent: {
          backendMode: 'native',
        },
      },
      runtimeCapabilities: { executionRun: { supported: true } },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    } as const;
    const runtime = withExecutionRunRuntimeIdentityPublication({
      runtime: createMinimalRuntime(),
      identity,
    });
    const messages: unknown[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await runtime.provisionSession({ initialPrompt: 'boot' });
    unsubscribe();

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'acme.provider',
          agent: {
            backendMode: 'native',
          },
        },
      },
      {
        type: 'event',
        name: 'runtime.capabilities',
        payload: { executionRun: { supported: true } },
      },
      {
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      },
    ]);
  });

  it('does not emit duplicate fallback identity when the backend emits identity first', async () => {
    const identity = {
      runtimeDescriptor: {
        v: 1,
        agentId: 'fallback.provider',
        agent: { backendMode: 'fallback' },
      },
      runtimeCapabilities: { executionRun: { supported: true } },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    } as const;
    const runtime = withExecutionRunRuntimeIdentityPublication({
      runtime: {
        ...createMinimalRuntime(),
        async provisionSession() {
          return { sessionId: 'runtime-session-1' };
        },
        subscribeMessages(handler) {
          handler({
            type: 'event',
            name: 'runtime.descriptor',
            payload: {
              v: 1,
              agentId: 'leaf.provider',
              provider: { backendMode: 'leaf' },
            },
          });
          handler({
            type: 'event',
            name: 'runtime.capabilities',
            payload: { leaf: true },
          });
          handler({
            type: 'event',
            name: 'runtime.facets',
            payload: {
              v: 1,
              transcriptSource: {
                supported: true,
              },
            },
          });
          return () => {};
        },
      },
      identity,
    });
    const messages: unknown[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await runtime.provisionSession({ initialPrompt: 'boot' });
    unsubscribe();

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'leaf.provider',
          agent: { backendMode: 'leaf' },
        },
      },
      {
        type: 'event',
        name: 'runtime.capabilities',
        payload: { leaf: true },
      },
      {
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      },
    ]);
  });

  it('falls back to normalized runtime facets when the backend emits an invalid facets payload first', async () => {
    const identity = {
      runtimeDescriptor: {
        v: 1,
        agentId: 'fallback.provider',
        agent: { backendMode: 'fallback' },
      },
      runtimeCapabilities: { executionRun: { supported: true } },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
          followLeaseSupported: true,
        },
      },
    } as const;
    const runtime = withExecutionRunRuntimeIdentityPublication({
      runtime: {
        ...createMinimalRuntime(),
        async provisionSession() {
          return { sessionId: 'runtime-session-1' };
        },
        subscribeMessages(handler) {
          handler({
            type: 'event',
            name: 'runtime.facets',
            payload: {
              v: 1,
              transcriptSource: {
                supported: false,
              },
            },
          });
          return () => {};
        },
      },
      identity,
    });
    const messages: unknown[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await runtime.provisionSession({ initialPrompt: 'boot' });
    unsubscribe();

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'fallback.provider',
          agent: { backendMode: 'fallback' },
        },
      },
      {
        type: 'event',
        name: 'runtime.capabilities',
        payload: { executionRun: { supported: true } },
      },
      {
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
      },
    ]);
  });
});
