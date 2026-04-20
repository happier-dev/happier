import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { EnhancedMode, PermissionMode } from '../claudeEnhancedMode';
import type { Session } from './ClaudeSession';

const mockClaudeRemoteLauncher = vi.fn();
vi.mock('../remote/launcher', () => ({
  launchClaudeRemoteSession: mockClaudeRemoteLauncher,
}));

vi.mock('./ClaudeSession', () => {
  class Session {
    path: string;
    logPath: string;
    client: SessionClientPort;
    pushSender: null;
    accountSettings: null;
    accountSettingsSecretsReadKeys: readonly Uint8Array[];
    queue: MessageQueue2<EnhancedMode>;
    claudeArgs?: string[];
    _onModeChange: (mode: 'local' | 'remote') => void;
    hookSettingsPath: string;
    jsRuntime: 'node' | 'bun';
    startedBy: 'daemon' | 'terminal';
    defaultSystemPromptText: string | undefined;
    sessionId: string | null;
    transcriptPath: string | null = null;
    mode: 'local' | 'remote' = 'local';
    thinking = false;
    lastPermissionMode: PermissionMode = 'default';
    lastPermissionModeUpdatedAt = 0;
    claudeCodeExperimentalAgentTeamsEnabled = false;

    constructor(opts: {
      client: SessionClientPort;
      pushSender?: null;
      accountSettings?: null;
      accountSettingsSecretsReadKeys?: readonly Uint8Array[];
      path: string;
      logPath: string;
      sessionId: string | null;
      claudeArgs?: string[];
      messageQueue: MessageQueue2<EnhancedMode>;
      onModeChange: (mode: 'local' | 'remote') => void;
      hookSettingsPath: string;
      jsRuntime?: 'node' | 'bun';
      startedBy?: 'daemon' | 'terminal';
      defaultSystemPromptText?: string;
      precomputedMcpBridge?: { mcpServers: Record<string, unknown>; stop: () => void } | null;
    }) {
      this.client = opts.client;
      this.pushSender = opts.pushSender ?? null;
      this.accountSettings = opts.accountSettings ?? null;
      this.accountSettingsSecretsReadKeys = opts.accountSettingsSecretsReadKeys ?? [];
      this.path = opts.path;
      this.logPath = opts.logPath;
      this.sessionId = opts.sessionId;
      this.claudeArgs = opts.claudeArgs;
      this.queue = opts.messageQueue;
      this._onModeChange = opts.onModeChange;
      this.hookSettingsPath = opts.hookSettingsPath;
      this.jsRuntime = opts.jsRuntime ?? 'node';
      this.startedBy = opts.startedBy ?? 'terminal';
      this.defaultSystemPromptText = opts.defaultSystemPromptText;
      void opts.precomputedMcpBridge;
      this.client.keepAlive(this.thinking, this.mode);
    }

    adoptLastPermissionModeFromMetadata(mode: PermissionMode, updatedAt: number): boolean {
      if (!(typeof updatedAt === 'number' && Number.isFinite(updatedAt))) {
        return false;
      }
      if (updatedAt <= this.lastPermissionModeUpdatedAt) {
        return false;
      }
      this.lastPermissionMode = mode;
      this.lastPermissionModeUpdatedAt = updatedAt;
      return true;
    }

    onModeChange(mode: 'local' | 'remote'): void {
      this.mode = mode;
      this._onModeChange(mode);
      this.client.keepAlive(this.thinking, this.mode);
    }

    cleanup(): void {}
  }

  return { Session };
});

const runModeLoopModulePromise = import('./runModeLoop');

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happier-cli-test.log',
  },
}));

type LoopOptions = Parameters<(typeof import('./runModeLoop'))['runClaudeModeLoop']>[0];

function createLoopClient(overrides?: Partial<SessionClientPort>): SessionClientPort {
  return {
    sessionId: 'session-test',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendSessionEvent: vi.fn(),
    sendClaudeSessionMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

async function runLoop(
  options?: Partial<LoopOptions>,
): Promise<{
  code: number;
  keepAlive: ReturnType<typeof vi.fn>;
  capturedSession: Session | null;
  launchTerminal: LoopOptions['launchTerminal'];
  modeChanges: Array<'terminal' | 'remote'>;
}> {
  const keepAlive = vi.fn();
  const client = createLoopClient({ keepAlive });
  const messageQueue = new MessageQueue2<EnhancedMode>(() => 'mode');
  const { runClaudeModeLoop: loop } = await runModeLoopModulePromise;
  const launchTerminal = options?.launchTerminal ?? vi.fn(async (_params: { session: Session; options?: { entry?: 'initial' | 'switch' } }) => ({ type: 'exit', code: 0 } as const));
  const modeChanges: Array<'terminal' | 'remote'> = [];

  let capturedSession: Session | null = null;

  const code = await loop({
    path: '/tmp',
    onModeChange: (mode) => {
      modeChanges.push(mode);
    },
    session: client,
    messageQueue,
    hookSettingsPath: '/tmp/hooks.json',
    launchTerminal,
    onSessionReady: (session) => {
      capturedSession = session;
    },
    ...options,
  });

  return { code, keepAlive, capturedSession, launchTerminal, modeChanges };
}

describe.sequential('loop', () => {
  beforeEach(() => {
    mockClaudeRemoteLauncher.mockReset();
    mockClaudeRemoteLauncher.mockResolvedValue('exit');
    vi.clearAllMocks();
  });

  it('does not fetch transcript permission intent during loop startup seeding', async () => {
    const result = await runLoop();
    try {
      expect(result.code).toBe(0);
      expect(result.launchTerminal).toHaveBeenCalledTimes(1);
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('updates Session.mode so keepAlive reports correct mode', async () => {
    mockClaudeRemoteLauncher.mockResolvedValueOnce('exit');
    const launchTerminal = vi.fn(async () => ({ type: 'switch' } as const));

    const result = await runLoop({ launchTerminal });
    try {
      expect(result.code).toBe(0);
      expect(result.modeChanges).toContain('remote');
      expect(result.keepAlive.mock.calls.some((call) => call[1] === 'remote')).toBe(true);
      expect(result.launchTerminal).toHaveBeenCalledTimes(1);
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('returns the local launcher exit code without entering remote mode', async () => {
    const result = await runLoop({
      launchTerminal: vi.fn(async () => ({ type: 'exit', code: 23 } as const)),
    });
    try {
      expect(result.code).toBe(23);
      expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
      expect(result.launchTerminal).toHaveBeenCalledTimes(1);
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('honors startingMode=remote and can switch back to terminal', async () => {
    mockClaudeRemoteLauncher.mockImplementationOnce(async () => 'switch' as const);
    const launchTerminal = vi.fn(async () => ({ type: 'exit', code: 0 } as const));

    const result = await runLoop({ startingMode: 'remote', launchTerminal });
    try {
      expect(result.code).toBe(0);
      expect(mockClaudeRemoteLauncher).toHaveBeenCalledTimes(1);
      expect(result.launchTerminal).toHaveBeenCalledTimes(1);
      expect(result.modeChanges).toContain('terminal');
      expect(result.keepAlive.mock.calls.some((call) => call[1] === 'local')).toBe(true);
    } finally {
      result.capturedSession?.cleanup();
    }
  });
});
