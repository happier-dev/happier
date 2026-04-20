import { describe, expect, it, vi } from 'vitest';

import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import { isRuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { buildClaudeRemoteOutgoingMessageMetaExtras } from '@happier-dev/agents';

import { createClaudeBindings } from './index';

const {
  createClaudeLoopMock,
  requireTerminalRuntimeLaunchMock,
} = vi.hoisted(() => ({
  createClaudeLoopMock: vi.fn(),
  requireTerminalRuntimeLaunchMock: vi.fn(),
}));

const { createClaudeHookServerAdjunctMock } = vi.hoisted(() => ({
  createClaudeHookServerAdjunctMock: vi.fn(async () => ({
    hookSettingsPath: '/tmp/claude-hook-settings.json',
    hookServer: { stop: vi.fn() },
  })),
}));

vi.mock('../runtime/session/runModeLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/session/runModeLoop')>();
  return {
    ...actual,
    runClaudeModeLoop: createClaudeLoopMock,
  };
});

vi.mock('@/agent/terminalRuntime/providers/requireTerminalRuntimeLaunch', () => ({
  requireTerminalRuntimeLaunch: requireTerminalRuntimeLaunchMock,
}));

vi.mock('@/backends/claude/utils/createClaudeHookServerAdjunct', () => ({
  createClaudeHookServerAdjunct: createClaudeHookServerAdjunctMock,
}));

describe('createClaudeBindings', () => {
  it('publishes the Claude message-meta enricher through the explicit runtime binding', () => {
    const runtimeBinding = createClaudeBindings({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: null,
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });

    expect(runtimeBinding).toEqual(expect.objectContaining({
      bindings: expect.any(Object),
      messageMeta: {
        buildOutgoingMessageMetaExtras: buildClaudeRemoteOutgoingMessageMetaExtras,
      },
    }));
  });

  it('constructs a host-owned session lifecycle plan instead of returning a provider-owned leaf', async () => {
    const launch = vi.fn(async () => ({ type: 'exit', code: 0 }));

    const runtimeBinding = createClaudeBindings({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const bindings = 'bindings' in runtimeBinding ? runtimeBinding.bindings : runtimeBinding;

    const plan = await bindings.createSessionRuntime({
      credentials: { token: 't' },
      startedBy: 'terminal',
      startingMode: 'terminal',
    }) as HostSessionRuntimePlan;

    expect(plan).toEqual(expect.objectContaining({
      kind: 'hostSessionRuntimePlan',
      providerId: 'claude',
      opts: expect.objectContaining({
        credentials: { token: 't' },
        startedBy: 'terminal',
        startingMode: 'terminal',
      }),
      config: expect.objectContaining({
        agentMessageType: 'claude',
        initializeSession: {
          startupSideEffectsOrder: 'persist-first',
        },
        lifecycleHooks: expect.objectContaining({
          onSessionInitialized: expect.any(Function),
        }),
        createSessionRuntime: expect.any(Function),
      }),
    }));
    expect(plan.config).not.toHaveProperty('hostBootstrap');
    expect(plan.config).toEqual(expect.objectContaining({
      startupBootstrap: expect.objectContaining({
        create: expect.any(Function),
        shouldCreate: expect.any(Function),
      }),
    }));

    expect(launch).not.toHaveBeenCalled();
  });

  it('materializes claudeRemoteMetaDefaults and accountSettings from accountSettingsContext', async () => {
    const runtimeBinding = createClaudeBindings({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch: vi.fn(async () => ({ type: 'exit', code: 0 })) },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const bindings = 'bindings' in runtimeBinding ? runtimeBinding.bindings : runtimeBinding;

    const settings = { claudeRemoteAgentSdkEnabled: true, claudeRemoteSettingSources: 'project' };
    const providerMessageMetaEnricher = {
      buildOutgoingMessageMetaExtras: vi.fn(() => ({
        claudeRemoteAgentSdkEnabled: 'from-enricher',
        claudeRemoteSettingSources: 'from-enricher',
      })),
    };

    await expect(bindings.createSessionRuntime({
      credentials: { token: 't' },
      startedBy: 'terminal',
      startingMode: 'terminal',
      accountSettingsContext: { settings },
      providerMessageMetaEnricher,
    })).resolves.toEqual(expect.objectContaining({
      kind: 'hostSessionRuntimePlan',
      providerId: 'claude',
      opts: expect.objectContaining({
        accountSettings: settings,
        claudeRemoteMetaDefaults: {
          claudeRemoteAgentSdkEnabled: 'from-enricher',
          claudeRemoteSettingSources: 'from-enricher',
        },
      }),
    }));

    expect(providerMessageMetaEnricher.buildOutgoingMessageMetaExtras).toHaveBeenCalledWith(settings);
  });

  it('uses the Claude native runtime as the shared lower-operation surface', async () => {
    createClaudeHookServerAdjunctMock.mockClear();

    const runtimeBinding = createClaudeBindings({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch: vi.fn(async () => ({ type: 'exit', code: 0 })) },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const bindings = 'bindings' in runtimeBinding ? runtimeBinding.bindings : runtimeBinding;

    const plan = await bindings.createSessionRuntime({
      credentials: { token: 't' },
      startedBy: 'terminal',
      startingMode: 'terminal',
    }) as HostSessionRuntimePlan;

    const createdRuntime = await plan.config.createSessionRuntime?.({
      directory: '/repo',
      metadata: { path: '/repo' } as never,
      machineId: 'machine-1',
      session: {} as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    expect(createdRuntime && typeof createdRuntime === 'object' && 'operations' in createdRuntime && 'nativeRuntime' in createdRuntime).toBe(true);
    if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime) || !('nativeRuntime' in createdRuntime)) {
      throw new Error('Expected Claude plan runtime factory to return operations/nativeRuntime pair');
    }

    expect(createdRuntime.operations).toBe(createdRuntime.nativeRuntime);
    expect(isRuntimeTurnOperations(createdRuntime.operations)).toBe(true);
    expect(createClaudeHookServerAdjunctMock).toHaveBeenCalledTimes(1);
  });

  it('clears the live Claude session ref after runtime reset', async () => {
    const launchLocal = vi.fn(async () => ({ type: 'exit', code: 0 } as const));
    const sessionCleanup = vi.fn();
    const liveSession = {
      sessionId: 'claude-session-1',
      cleanup: sessionCleanup,
      onThinkingChange: vi.fn(),
      setPushSender: vi.fn(),
      client: {
        getMetadataSnapshot: vi.fn(() => null),
      },
      getOrCreatePermissionRpcRouter: vi.fn(() => ({
        registerConsumer: vi.fn(),
      })),
    };
    let resolveLoop!: (code: number) => void;

    requireTerminalRuntimeLaunchMock.mockResolvedValueOnce(launchLocal);
    createClaudeLoopMock.mockImplementationOnce(async (opts: {
      launchLocal: typeof launchLocal;
      onSessionReady?: (session: typeof liveSession) => void;
    }) => {
      opts.onSessionReady?.(liveSession);
      return await new Promise<number>((resolve) => {
        resolveLoop = resolve;
      });
    });

    const runtimeBinding = createClaudeBindings({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch: vi.fn(async () => ({ type: 'exit', code: 0 })) },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const bindings = 'bindings' in runtimeBinding ? runtimeBinding.bindings : runtimeBinding;

    const plan = (await bindings.createSessionRuntime({
      credentials: { token: 't' },
      startedBy: 'terminal',
      startingMode: 'terminal',
    })) as HostSessionRuntimePlan;

    const createdRuntime = await plan.config.createSessionRuntime?.({
      directory: '/repo',
      metadata: { path: '/repo' } as never,
      machineId: 'machine-1',
      session: {
        sendSessionEvent: vi.fn(),
      } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime)) {
      throw new Error('Expected Claude runtime factory to return operations');
    }

    const operations = createdRuntime.operations;
    const startPromise = operations.startOrLoadSession();
    await Promise.resolve();

    expect(operations.readSessionIdentity()).toEqual({ sessionId: 'claude-session-1' });
    expect(sessionCleanup).not.toHaveBeenCalled();

    resolveLoop(0);
    await startPromise;

    await operations.resetOrDisposeRuntime();

    expect(sessionCleanup).toHaveBeenCalledTimes(1);
    expect(operations.readSessionIdentity()).toEqual({ sessionId: null });
  });
});
