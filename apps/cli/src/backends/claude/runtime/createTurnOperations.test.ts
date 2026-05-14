import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { HostSessionTerminalRemoteModeRuntime } from '@/agent/runtime/session/loop/terminalRemoteModeRuntime';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

import { createClaudeRuntimeTurnOperations } from './createTurnOperations';

const mocks = vi.hoisted(() => {
  class TestClaudeSession {
    public readonly accountSettings: unknown;
    public claudeCodeExperimentalAgentTeamsEnabled = false;
    public lastPermissionMode = 'default';
    public lastPermissionModeUpdatedAt = 0;
    public sessionId: string | null = null;
    public onThinkingChange = vi.fn();
    public readonly setPushSender = vi.fn();
    public readonly noteUserAbortRequested = vi.fn();
    public readonly abortCurrentTurn = vi.fn(async () => undefined);
    public readonly cleanup = vi.fn();
    public readonly onModeChange = vi.fn();
    public readonly adoptLastPermissionModeFromMetadata = vi.fn((mode: string, updatedAt: number) => {
      this.lastPermissionMode = mode;
      this.lastPermissionModeUpdatedAt = updatedAt;
      return true;
    });

    constructor(options?: Readonly<{ accountSettings?: unknown }>) {
      this.accountSettings = options?.accountSettings ?? null;
      mocks.createdSessions.push(this);
    }
  }

  const terminalLaunch = vi.fn(async () => ({ type: 'exit', code: 0 } as const));
  return {
    TestClaudeSession,
    terminalLaunch,
    remoteLaunch: vi.fn(async () => 'exit' as const),
    requireTerminalRuntimeLaunch: vi.fn(async () => terminalLaunch),
    cleanupClaudeRuntimeAdjuncts: vi.fn(),
    localPermissionBridgeManager: {
      setSession: vi.fn(),
      setEnabled: vi.fn(() => true),
      activateIfPresent: vi.fn(),
      handlePermissionHook: vi.fn(async () => ({
        continue: true,
        suppressOutput: true,
      })),
      dispose: vi.fn(),
    },
    createdSessions: [] as TestClaudeSession[],
  };
});

vi.mock('@/agent/terminalRuntime/providers/requireTerminalRuntimeLaunch', () => ({
  requireTerminalRuntimeLaunch: mocks.requireTerminalRuntimeLaunch,
}));

vi.mock('./remote/launcher', () => ({
  launchClaudeRemoteSession: mocks.remoteLaunch,
}));

vi.mock('./cleanupRuntimeAdjuncts', () => ({
  cleanupClaudeRuntimeAdjuncts: mocks.cleanupClaudeRuntimeAdjuncts,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    logFilePath: '/tmp/happier-create-turn-operations.log',
  },
}));

vi.mock('./session/ClaudeSession', () => ({
  Session: mocks.TestClaudeSession,
}));

function createSessionClient(): ApiSessionClient {
  return {
    sessionId: 'happy-session-1',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => undefined),
    },
    sendSessionEvent: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => undefined),
    sendClaudeSessionMessage: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => ({ permissionMode: 'plan', permissionModeUpdatedAt: 123 }),
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as ApiSessionClient;
}

function createRuntime(params?: Readonly<{
  startingMode?: 'terminal' | 'remote';
  experimentalAgentTeams?: boolean;
  session?: ApiSessionClient;
  accountSettings?: AccountSettings | null;
  optsAccountSettings?: AccountSettings | null;
}>): RuntimeTurnOperations & HostSessionTerminalRemoteModeRuntime {
  return createClaudeRuntimeTurnOperations({
    opts: {
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      startingMode: params?.startingMode,
      accountSettings: params?.optsAccountSettings,
    },
    directory: '/tmp/project',
    machineId: 'machine-1',
    session: params?.session ?? createSessionClient(),
    mcpServers: {},
    accountSettings: params && Object.prototype.hasOwnProperty.call(params, 'accountSettings')
      ? params.accountSettings
      : null,
    hookSettingsPath: '/tmp/hooks.json',
    hookPluginDir: null,
    hookServer: { stop: vi.fn() },
    currentSessionRef: { current: null },
    initialMode: {
      permissionMode: 'default',
      agentModeId: null,
      model: undefined,
      claudeCodeExperimentalAgentTeamsEnabled: params?.experimentalAgentTeams === true,
    },
    setThinking: vi.fn(),
    getPermissionMode: () => 'default',
    localPermissionBridgeManager: mocks.localPermissionBridgeManager,
    deferredPushSenderRef: { current: null },
  });
}

describe('createClaudeRuntimeTurnOperations', () => {
  beforeEach(() => {
    mocks.createdSessions.length = 0;
    mocks.terminalLaunch.mockClear();
    mocks.remoteLaunch.mockClear();
    mocks.requireTerminalRuntimeLaunch.mockClear();
    mocks.cleanupClaudeRuntimeAdjuncts.mockClear();
    mocks.localPermissionBridgeManager.setSession.mockClear();
    mocks.localPermissionBridgeManager.setEnabled.mockClear();
    mocks.localPermissionBridgeManager.activateIfPresent.mockClear();
    mocks.localPermissionBridgeManager.handlePermissionHook.mockClear();
    mocks.localPermissionBridgeManager.dispose.mockClear();
  });

  it('exposes terminal and remote primitives for the shared lifecycle mode loop', async () => {
    const runtime = createRuntime({
      startingMode: 'remote',
      experimentalAgentTeams: true,
    });

    const modeLoop = runtime.resolveTerminalRemoteSessionModeLoop();
    expect(modeLoop).toEqual(expect.objectContaining({
      startingMode: 'remote',
      remoteExitCode: 0,
    }));

    await modeLoop?.runTerminal({ entry: 'initial' });
    expect(mocks.requireTerminalRuntimeLaunch).toHaveBeenCalledWith('claude');
    expect(mocks.terminalLaunch).toHaveBeenCalledWith({
      session: mocks.createdSessions[0],
      options: { entry: 'initial' },
    });
    expect(mocks.createdSessions[0]?.claudeCodeExperimentalAgentTeamsEnabled).toBe(true);
    expect(mocks.createdSessions[0]?.lastPermissionMode).toBe('plan');
    expect(mocks.localPermissionBridgeManager.setSession).toHaveBeenCalledWith(mocks.createdSessions[0]);

    await modeLoop?.runRemote();
    expect(mocks.remoteLaunch).toHaveBeenCalledWith(mocks.createdSessions[0]);
    expect(mocks.createdSessions).toHaveLength(1);
  });

  it('honors an explicit null MCP account settings snapshot instead of falling back to stale start options', async () => {
    const staleSettings = accountSettingsParse({
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            approvalRequiredSurfaces: ['session_agent'],
          },
        },
      },
    });
    const runtime = createRuntime({
      accountSettings: null,
      optsAccountSettings: staleSettings,
    });

    await runtime.startOrLoadSession();

    expect(mocks.createdSessions[0]?.accountSettings).toBeNull();
  });

  it('exposes a graceful remote handoff handle through the shared terminal mode loop', async () => {
    const session = createSessionClient();
    const invokeLocal = vi.fn(async () => true);
    (session as unknown as { rpcHandlerManager: { invokeLocal: typeof invokeLocal } }).rpcHandlerManager.invokeLocal = invokeLocal;
    const runtime = createRuntime({ session });

    await runtime.startOrLoadSession();
    const modeLoop = runtime.resolveTerminalRemoteSessionModeLoop();

    await expect(
      modeLoop?.requestGracefulRemoteHandoff?.('pending_queue_after_terminal_boundary'),
    ).resolves.toEqual({ ok: true });
    expect(invokeLocal).toHaveBeenCalledWith('switch', {
      to: 'remote',
      reason: 'pending_queue_after_terminal_boundary',
    });
  });

  it('publishes normalized task lifecycle messages to runtime subscribers', async () => {
    const runtime = createRuntime();
    const messages: unknown[] = [];
    runtime.subscribeRuntimeMessages((message) => {
      messages.push(message);
    });

    await runtime.startOrLoadSession();
    const session = mocks.createdSessions[0];
    session?.onThinkingChange(true);
    session?.onThinkingChange(false);

    expect(messages).toEqual([
      expect.objectContaining({ type: 'task_started', id: expect.any(String) }),
      expect.objectContaining({ type: 'thinking', thinking: true }),
      expect.objectContaining({ type: 'task_complete', id: expect.any(String) }),
      expect.objectContaining({ type: 'thinking', thinking: false }),
    ]);
    expect((messages[0] as { id?: unknown }).id).toBe((messages[2] as { id?: unknown }).id);
  });
});
