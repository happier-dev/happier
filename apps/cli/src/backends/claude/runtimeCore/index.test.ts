import { describe, expect, it, vi } from 'vitest';

import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { isRuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { buildClaudeRemoteOutgoingMessageMetaExtras } from '@happier-dev/agents';

import { createClaudeRuntimeCore } from './index';

const {
  requireTerminalRuntimeLaunchMock,
  createdClaudeSessions,
  MockClaudeSession,
} = vi.hoisted(() => ({
  requireTerminalRuntimeLaunchMock: vi.fn(),
  createdClaudeSessions: [] as Array<{
    sessionId: string | null;
    cleanup: ReturnType<typeof vi.fn>;
  }>,
  MockClaudeSession: class MockClaudeSession {
    sessionId: string | null = 'claude-session-1';
    client: { getMetadataSnapshot?: () => unknown } = {};
    onThinkingChange = vi.fn();
    setPushSender = vi.fn();
    cleanup = vi.fn();
    noteUserAbortRequested = vi.fn();
    abortCurrentTurn = vi.fn(async () => undefined);
    onModeChange = vi.fn();
    getOrCreatePermissionRpcRouter = vi.fn(() => ({ registerConsumer: vi.fn() }));
    lastPermissionMode = 'default';
    lastPermissionModeUpdatedAt = 0;
    claudeCodeExperimentalAgentTeamsEnabled = false;

    constructor(opts?: { client?: { getMetadataSnapshot?: () => unknown } }) {
      this.client = opts?.client ?? {};
      createdClaudeSessions.push(this);
    }

    adoptLastPermissionModeFromMetadata(mode: string, updatedAt: number) {
      this.lastPermissionMode = mode;
      this.lastPermissionModeUpdatedAt = updatedAt;
      return true;
    }
  },
}));

const { createClaudeHookServerAdjunctMock } = vi.hoisted(() => ({
  createClaudeHookServerAdjunctMock: vi.fn(async () => ({
    hookSettingsPath: '/tmp/claude-hook-settings.json',
    hookServer: { stop: vi.fn() },
  })),
}));

vi.mock('@/agent/terminalRuntime/providers/requireTerminalRuntimeLaunch', () => ({
  requireTerminalRuntimeLaunch: requireTerminalRuntimeLaunchMock,
}));

vi.mock('../runtime/session/ClaudeSession', () => ({
  Session: MockClaudeSession,
}));

vi.mock('@/backends/claude/utils/createClaudeHookServerAdjunct', () => ({
  createClaudeHookServerAdjunct: createClaudeHookServerAdjunctMock,
}));

describe('createClaudeRuntimeCore', () => {
  it('publishes the Claude message-meta enricher through the explicit runtime runtimeCore', () => {
    const runtimeCoreEnvelope = createClaudeRuntimeCore({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: null,
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });

    expect(runtimeCoreEnvelope).toEqual(expect.objectContaining({
      runtimeCore: expect.any(Object),
      messageMeta: {
        buildOutgoingMessageMetaExtras: buildClaudeRemoteOutgoingMessageMetaExtras,
      },
    }));
  });

  it('constructs a host-owned session lifecycle plan instead of returning a provider-owned leaf', async () => {
    const launch = vi.fn(async () => ({ type: 'exit', code: 0 }));

    const runtimeCoreEnvelope = createClaudeRuntimeCore({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const runtimeCore = 'runtimeCore' in runtimeCoreEnvelope ? runtimeCoreEnvelope.runtimeCore : runtimeCoreEnvelope;

    const plan = await runtimeCore.createSessionRuntime({
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
    const runtimeCoreEnvelope = createClaudeRuntimeCore({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch: vi.fn(async () => ({ type: 'exit', code: 0 })) },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const runtimeCore = 'runtimeCore' in runtimeCoreEnvelope ? runtimeCoreEnvelope.runtimeCore : runtimeCoreEnvelope;

    const settings = { claudeRemoteAgentSdkEnabled: true, claudeRemoteSettingSources: 'project' };
    const providerMessageMetaEnricher = {
      buildOutgoingMessageMetaExtras: vi.fn(() => ({
        claudeRemoteAgentSdkEnabled: 'from-enricher',
        claudeRemoteSettingSources: 'from-enricher',
      })),
    };

    await expect(runtimeCore.createSessionRuntime({
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

    const runtimeCoreEnvelope = createClaudeRuntimeCore({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch: vi.fn(async () => ({ type: 'exit', code: 0 })) },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const runtimeCore = 'runtimeCore' in runtimeCoreEnvelope ? runtimeCoreEnvelope.runtimeCore : runtimeCoreEnvelope;

    const plan = await runtimeCore.createSessionRuntime({
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
    createdClaudeSessions.length = 0;

    const runtimeCoreEnvelope = createClaudeRuntimeCore({
      backend: { id: 'claude' } as never,
      provider: { id: 'claude' } as never,
      executionSurfaces: {
        terminalRuntime: { launch: vi.fn(async () => ({ type: 'exit', code: 0 })) },
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    });
    const runtimeCore = 'runtimeCore' in runtimeCoreEnvelope ? runtimeCoreEnvelope.runtimeCore : runtimeCoreEnvelope;

    const plan = (await runtimeCore.createSessionRuntime({
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
    await operations.startOrLoadSession();

    expect(operations.readSessionIdentity()).toEqual({ sessionId: 'claude-session-1' });
    expect(createdClaudeSessions[0]?.cleanup).not.toHaveBeenCalled();

    await operations.resetOrDisposeRuntime();

    expect(createdClaudeSessions[0]?.cleanup).toHaveBeenCalledTimes(1);
    expect(operations.readSessionIdentity()).toEqual({ sessionId: null });
  });
});
