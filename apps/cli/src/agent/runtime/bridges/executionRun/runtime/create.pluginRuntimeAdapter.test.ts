import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentBackend';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

const getExecutionRunBackendDescriptorMock = vi.fn();
const resolveBackendEngineAdapterResolutionMock = vi.fn();

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: (...args: unknown[]) => getExecutionRunBackendDescriptorMock(...args),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

function createStubRuntimeCoreBackend(opts?: Readonly<{
  runtimeDescriptor?: unknown;
  runtimeCapabilities?: unknown;
  runtimeFacets?: unknown;
}>): ExecutionRunHostRuntime & {
  readonly calls: Readonly<{
    provisionSession: ReturnType<typeof vi.fn>;
    sendPrompt: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    subscribeMessages: ReturnType<typeof vi.fn>;
    respondToPermission: ReturnType<typeof vi.fn>;
    waitForTurnCompletion: ReturnType<typeof vi.fn>;
    readResumeSupport: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>;
} {
  let messageHandler: ExecutionRunHostRuntimeMessageHandler | null = null;
  let emittedRuntimeEvents = false;
  const calls = {
    readResumeSupport: vi.fn(async () => false),
    provisionSession: vi.fn(async () => {
      if (!emittedRuntimeEvents) {
        if (opts?.runtimeDescriptor !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.descriptor', payload: opts.runtimeDescriptor });
        }
        if (opts?.runtimeCapabilities !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.capabilities', payload: opts.runtimeCapabilities });
        }
        if (opts?.runtimeFacets !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.facets', payload: opts.runtimeFacets });
        }
        emittedRuntimeEvents = true;
      }
      return { sessionId: 'plugin-session-1' };
    }),
    sendPrompt: vi.fn(async (_sessionId: string, prompt: string) => {
      messageHandler?.({ type: 'model-output', fullText: `plugin:${prompt}` });
    }),
    cancel: vi.fn(async () => undefined),
    subscribeMessages: vi.fn((handler: ExecutionRunHostRuntimeMessageHandler) => {
      messageHandler = handler;
      return () => {
        if (messageHandler === handler) {
          messageHandler = null;
        }
      };
    }),
    respondToPermission: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };

  return {
    ...calls,
    calls,
  };
}

function expectGenericPluginRuntimeDescriptor() {
  return expect.objectContaining({
    v: 1,
    providerId: 'acme.sample.provider',
    provider: expect.objectContaining({
      backendMode: 'native',
      providerExtra: expect.objectContaining({
        owner: 'happier',
        schemaId: 'happier.pluginRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle: expect.objectContaining({
          backendId: 'acme.sample.backend',
          providerId: 'acme.sample.provider',
          provenance: 'external',
          source: { kind: 'path' },
        }),
      }),
    }),
  });
}

function expectExecutionRunFallbackRuntimeDescriptor() {
  return expect.objectContaining({
    v: 1,
    providerId: 'acme.sample.provider',
    provider: expect.objectContaining({
      backendMode: 'native',
      providerExtra: expect.objectContaining({
        owner: 'happier',
        schemaId: 'happier.executionRunRuntimeIdentity',
        v: 1,
        runtimeHandle: expect.objectContaining({
          backendId: 'acme.sample.backend',
          providerId: 'acme.sample.provider',
          provenance: 'external',
        }),
      }),
    }),
  });
}

describe('createExecutionRunBackend (plugin runtimeCore adapter)', () => {
  beforeEach(() => {
    vi.resetModules();
    getExecutionRunBackendDescriptorMock.mockReset();
    resolveBackendEngineAdapterResolutionMock.mockReset();
  });

  it('exposes a host-owned execution-run runtime surface for runtimeCore-backed backends', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      runtimeDescriptor: {
        backendId: 'acme.sample.backend',
        runtimeKind: 'native',
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }) as Readonly<{
      provisionSession: (opts?: { initialPrompt?: string; resumeSessionId?: string; captureReplay?: boolean }) => Promise<{ sessionId: string }>;
      sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
      cancel: (sessionId: string) => Promise<void>;
      subscribeMessages: (handler: (message: AgentMessage) => void) => () => void;
      respondToPermission: (requestId: string, approved: boolean) => Promise<void>;
      waitForTurnCompletion: (timeoutMs?: number | null) => Promise<void>;
      dispose: () => Promise<void>;
    }>;

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(runtime.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();
    await expect(runtime.cancel('plugin-session-1')).resolves.toBeUndefined();
    await expect(runtime.respondToPermission('perm-1', true)).resolves.toBeUndefined();
    await expect(runtime.waitForTurnCompletion(500)).resolves.toBeUndefined();
    unsubscribe();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', expect.any(Object));
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.sample.backend',
        sourceKind: 'built_in',
      },
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
      }),
      expect.objectContaining({
        type: 'model-output',
        fullText: 'plugin:hello',
      }),
    ]));
  });

  it('creates an execution-run backend from plugin terminal-runtime launch when no built-in descriptor exists', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      runtimeDescriptor: {
        backendId: 'acme.sample.backend',
        runtimeKind: 'native',
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const { createExecutionRunBackend } = await import('../testkit');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((message) => {
      messages.push(message);
    });

    await expect(backend.startSession('boot')).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(backend.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();
    await expect(backend.cancel('plugin-session-1')).resolves.toBeUndefined();
    await expect(backend.respondToPermission?.('perm-1', true)).resolves.toBeUndefined();
    await expect(backend.waitForResponseComplete?.(500)).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', expect.any(Object));
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.sample.backend',
        sourceKind: 'built_in',
      },
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    expect(runtimeCoreBackend.calls.provisionSession).toHaveBeenCalledWith({ initialPrompt: 'boot' });
    expect(runtimeCoreBackend.calls.sendPrompt).toHaveBeenCalledWith('plugin-session-1', 'hello');
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
        },
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
      expect.objectContaining({
        type: 'model-output',
        fullText: 'plugin:hello',
      }),
    ]));
  });

  it('passes generic isolation env to plugin runtimeCore-backed execution runs', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      runtimeOwner: {
        backendId: 'acme.sample.backend',
        selected: {
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        }],
      },
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const { createExecutionRunBackend } = await import('../testkit');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      runId: 'run_isolated',
    });

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      isolation: {
        env: expect.objectContaining({
          XDG_STATE_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/state'),
          XDG_CACHE_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/cache'),
          XDG_DATA_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/data'),
        }),
      },
    }));
  });

  it('preserves emitted runtime descriptors and fills missing runtime capabilities centrally', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
	      runtimeDescriptor: {
	        v: 1,
	        providerId: 'acme.sample.provider',
	        provider: {
	          backendMode: 'native',
	          providerExtra: {
	            owner: 'happier',
	            schemaId: 'happier.pluginRuntimeDescriptorExtra',
	            v: 1,
	            runtimeHandle: {
	              backendId: 'acme.sample.backend',
	              providerId: 'acme.sample.provider',
	              provenance: 'external',
	              source: { kind: 'path' },
	            },
	          },
	        },
	      },
	    });
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunBackend } = await import('../testkit');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((message) => {
      messages.push(message);
    });

    await expect(backend.startSession('boot')).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(backend.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectGenericPluginRuntimeDescriptor(),
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
          backend: { executionRun: true },
        },
      }),
    ]));
  });

  it('fails closed to the generic plugin descriptor when plugin execution-run runtimeDescriptor is malformed', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const runtimeCoreBackend = createStubRuntimeCoreBackend({
	      runtimeDescriptor: {
	        backendId: 'acme.sample.backend',
	        runtimeKind: 'native',
	      },
	    });
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunBackend } = await import('../testkit');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((message) => {
      messages.push(message);
    });

    await expect(backend.startSession('boot')).resolves.toEqual({ sessionId: 'plugin-session-1' });

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
  });

  it('publishes runtime identity centrally when a runtimeCore-backed backend is silent', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const runtimeCoreBackend = createStubRuntimeCoreBackend();
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
        facets: {
          transcriptSource: {
            supported: true,
          },
        },
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunBackend } = await import('../testkit');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((message) => {
      messages.push(message);
    });

    await expect(backend.startSession('boot')).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(backend.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
          backend: { executionRun: true },
        },
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
    ]));
  });

  it('fails closed when plugin execution surfaces do not provide terminal-runtime launch', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const createExecutionRunBackendMock = vi.fn(() => {
	      throw new Error("Execution-run backend 'acme.sample.backend' is missing terminal runtime launch support");
	    });
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunBackend } = await import('../testkit');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    });

    await expect(backend.startSession()).rejects.toThrow(/terminal runtime launch/i);
  });

  it('fails with unsupported backend when descriptor fallback resolves a non-plugin engine source', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue(null);

    const { createExecutionRunBackend } = await import('../testkit');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/non-plugin-backend',
      backendId: 'acme.sample.backend',
      permissionMode: 'read_only',
    });

    await expect(backend.startSession()).rejects.toThrow('Unsupported execution-run backend: acme.sample.backend');
  });

  it('does not subscribe late when the caller unsubscribes before runtimeCore resolution finishes', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);

    let resolveEngineResolution!: (value: unknown) => void;
    const engineResolutionPromise = new Promise((resolve: (value: unknown) => void) => {
      resolveEngineResolution = resolve;
    });
    resolveBackendEngineAdapterResolutionMock.mockReturnValue(engineResolutionPromise);

    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionSession: () => Promise<{ sessionId: string }>;
      subscribeMessages: (handler: (message: AgentMessage) => void) => () => void;
    }>;

    const unsubscribe = runtime.subscribeMessages(() => {});
    unsubscribe();

	    resolveEngineResolution({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'plugin-session-1' });

    expect(createExecutionRunBackendMock).toHaveBeenCalled();
    expect(runtimeCoreBackend.calls.subscribeMessages).toHaveBeenCalledTimes(1);
  });

  it('fails execution-run startup when plugin trust approval is still required', async () => {
	    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
      diagnostics: [{
        code: 'engine_plugin_daemon_module_load_failed',
        detailCode: 'plugin_trust_approval_required',
	        message: 'Plugin trust approval is required before this backend can run.',
	      }],
	    });

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionSession: () => Promise<{ sessionId: string }>;
    }>;

    await expect(runtime.provisionSession()).rejects.toThrow(
      'Plugin trust approval is required before this backend can run.',
    );
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });

  it('fails execution-run startup when the plugin runtime source is untrusted', async () => {
	    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
      },
      diagnostics: [{
        code: 'engine_plugin_daemon_module_load_failed',
        detailCode: 'plugin_untrusted',
        message: 'Refusing to load executable plugin daemon entry from an untrusted source.',
      }],
    });

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionSession: () => Promise<{ sessionId: string }>;
    }>;

    await expect(runtime.provisionSession()).rejects.toThrow(
      'Refusing to load executable plugin daemon entry from an untrusted source.',
    );
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });
});
