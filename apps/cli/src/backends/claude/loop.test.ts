import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { loop, type EnhancedMode } from './loop';
import type { Session } from './session';

const mockClaudeLocalLauncher = vi.hoisted(() => vi.fn());
vi.mock('./claudeLocalLauncher', () => ({
  claudeLocalLauncher: mockClaudeLocalLauncher,
}));

const mockClaudeRemoteLauncher = vi.hoisted(() => vi.fn());
vi.mock('./claudeRemoteLauncher', () => ({
  claudeRemoteLauncher: mockClaudeRemoteLauncher,
}));

const mockClaudeUnifiedTerminalLauncher = vi.hoisted(() => vi.fn());
vi.mock('./unifiedTerminal/claudeUnifiedTerminalLauncher', () => ({
  claudeUnifiedTerminalLauncher: mockClaudeUnifiedTerminalLauncher,
}));

const mockResolveCliFeatureDecision = vi.hoisted(() => vi.fn(() => ({ state: 'enabled' })));
vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecision: mockResolveCliFeatureDecision,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    infoFile: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happier-cli-test.log',
  },
}));

type LoopOptions = Parameters<(typeof import('./loop'))['loop']>[0];

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
    waitForPendingEligibilityUpdate: vi.fn(async () => false),
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

async function runLoop(options?: Partial<LoopOptions>): Promise<{ code: number; keepAlive: ReturnType<typeof vi.fn>; capturedSession: Session | null }> {
  const keepAlive = vi.fn();
  const client = createLoopClient({ keepAlive });
  const messageQueue = new MessageQueue2<EnhancedMode>(() => 'mode');
  let capturedSession: Session | null = null;

  const code = await loop({
    path: '/tmp',
    onModeChange: () => {},
    session: client,
    messageQueue,
    hookSettingsPath: '/tmp/hooks.json',
    onSessionReady: (session) => {
      capturedSession = session;
    },
    ...options,
  });

  return { code, keepAlive, capturedSession };
}

describe.sequential('loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCliFeatureDecision.mockReturnValue({ state: 'enabled' });
  });

  it.each([
    ['remote', false],
    ['unified', true],
  ] as const)('awaits Claude readiness reconciliation before the %s launcher', async (_label, unified) => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const client = createLoopClient({ registerSessionRuntimeControls: vi.fn(() => vi.fn()) });
    const messageQueue = new MessageQueue2<EnhancedMode>(() => 'mode');
    const { loop } = await import('./loop');
    if (unified) {
      mockClaudeUnifiedTerminalLauncher.mockResolvedValueOnce({ type: 'exit', code: 0 });
    } else {
      mockClaudeRemoteLauncher.mockResolvedValueOnce('exit');
    }

    const loopResult = loop({
      path: '/tmp',
      startingMode: 'remote',
      claudeUnifiedTerminalEnabled: unified,
      onModeChange: () => {},
      session: client,
      messageQueue,
      hookSettingsPath: '/tmp/hooks.json',
      onSessionReady: async () => await ready,
    });
    await Promise.resolve();
    expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
    expect(mockClaudeUnifiedTerminalLauncher).not.toHaveBeenCalled();

    releaseReady();
    await expect(loopResult).resolves.toBe(0);
    expect(unified ? mockClaudeUnifiedTerminalLauncher : mockClaudeRemoteLauncher).toHaveBeenCalledOnce();
  });

  it('does not fetch transcript permission intent during loop startup seeding', async () => {
    mockClaudeLocalLauncher.mockResolvedValueOnce({ type: 'exit', code: 0 });

    const result = await runLoop();
    try {
      expect(result.code).toBe(0);
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('installs the Claude-owned provider echo classifier on the session client', async () => {
    mockClaudeLocalLauncher.mockResolvedValueOnce({ type: 'exit', code: 0 });
    const setProviderOwnedUserMessageEchoClassifier = vi.fn();

    const result = await runLoop({
      session: createLoopClient({ setProviderOwnedUserMessageEchoClassifier }),
    });
    try {
      expect(result.code).toBe(0);
      expect(setProviderOwnedUserMessageEchoClassifier).toHaveBeenCalledTimes(1);
      const classifier = setProviderOwnedUserMessageEchoClassifier.mock.calls[0]?.[0];
      expect(classifier).toBeTypeOf('function');
      expect(classifier(
        {
          role: 'user',
          content: { type: 'text', text: 'typed directly in Claude' },
          localId: 'claude-jsonl:main:user:u1',
          meta: { source: 'cli' },
        },
        {
          body: {
            t: 'new-message',
            message: { localId: 'claude-jsonl:main:user:u1' },
          },
        },
      )).toBe(true);
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('updates Session.mode so keepAlive reports correct mode', async () => {
    mockClaudeLocalLauncher.mockResolvedValueOnce({ type: 'switch' });
    mockClaudeRemoteLauncher.mockResolvedValueOnce('exit');

    const result = await runLoop();
    try {
      expect(result.code).toBe(0);
      expect(result.keepAlive.mock.calls.some((call) => call[1] === 'remote')).toBe(true);
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('disables legacy local-to-remote switching for unified terminal local launches', async () => {
    mockClaudeUnifiedTerminalLauncher.mockResolvedValueOnce({ type: 'exit', code: 0 });

    const result = await runLoop({ claudeUnifiedTerminalEnabled: true });
    try {
      expect(result.code).toBe(0);
      expect(mockClaudeUnifiedTerminalLauncher).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          initialMode: expect.objectContaining({
            claudeUnifiedTerminalEnabled: true,
            permissionMode: 'default',
          }),
        }),
      );
      expect(mockClaudeLocalLauncher).not.toHaveBeenCalled();
      expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it.each(['disabled', 'unsupported', 'unknown'] as const)(
    'fails clearly without fallback when unified terminal feature policy is %s',
    async (featureState) => {
      mockResolveCliFeatureDecision.mockReturnValue({ state: featureState });
      mockClaudeUnifiedTerminalLauncher.mockResolvedValueOnce({ type: 'exit', code: 0 });

      await expect(runLoop({ claudeUnifiedTerminalEnabled: true })).rejects.toThrow(
        /unified terminal runtime is disabled by feature policy/i,
      );

      expect(mockClaudeUnifiedTerminalLauncher).not.toHaveBeenCalled();
      expect(mockClaudeLocalLauncher).not.toHaveBeenCalled();
      expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
    },
    15_000,
  );

  it('routes daemon remote-started unified sessions through the terminal launcher with startup mode', async () => {
    mockClaudeUnifiedTerminalLauncher.mockResolvedValueOnce({ type: 'exit', code: 0 });

    const result = await runLoop({
      startingMode: 'remote',
      startedBy: 'daemon',
      claudeUnifiedTerminalEnabled: true,
      initialClaudeUnifiedTerminalMode: {
        permissionMode: 'acceptEdits',
        claudeUnifiedTerminalEnabled: true,
      },
    });
    try {
      expect(result.code).toBe(0);
      expect(mockClaudeUnifiedTerminalLauncher).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          initialMode: expect.objectContaining({
            permissionMode: 'acceptEdits',
            claudeUnifiedTerminalEnabled: true,
          }),
        }),
      );
      expect(mockClaudeLocalLauncher).not.toHaveBeenCalled();
      expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('returns the local launcher exit code without entering remote mode', async () => {
    mockClaudeLocalLauncher.mockResolvedValueOnce({ type: 'exit', code: 42 });

    const result = await runLoop();
    try {
      expect(result.code).toBe(42);
      expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
    } finally {
      result.capturedSession?.cleanup();
    }
  }, 15_000);

  it('honors startingMode=remote and can switch back to local', async () => {
    mockClaudeRemoteLauncher.mockResolvedValueOnce('switch');
    mockClaudeLocalLauncher.mockResolvedValueOnce({ type: 'exit', code: 7 });

    const result = await runLoop({ startingMode: 'remote' });
    try {
      expect(result.code).toBe(7);
      expect(mockClaudeRemoteLauncher).toHaveBeenCalledTimes(1);
      expect(mockClaudeLocalLauncher).toHaveBeenCalledTimes(1);
      expect(result.keepAlive.mock.calls.some((call) => call[1] === 'local')).toBe(true);
    } finally {
      result.capturedSession?.cleanup();
    }
  });

  it('passes the session-lifecycle runtime selection to the remote launcher', async () => {
    mockClaudeRemoteLauncher.mockResolvedValueOnce('exit');
    const initialMode: EnhancedMode = {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      claudeUnifiedTerminalEnabled: false,
    };

    const result = await runLoop({
      startingMode: 'remote',
      initialClaudeUnifiedTerminalMode: initialMode,
    });
    try {
      expect(result.code).toBe(0);
      expect(mockClaudeRemoteLauncher).toHaveBeenCalledWith(
        expect.anything(),
        { initialMode },
      );
    } finally {
      result.capturedSession?.cleanup();
    }
  });

  it('activates the current-runtime provider observer before a remote provider can accept input', async () => {
    const order: string[] = [];
    const readySession: { current: Session | null } = { current: null };
    let noteProviderEntered = (): void => {
      throw new Error('provider entry signal was not armed');
    };
    const providerEntered = new Promise<void>((resolve) => {
      noteProviderEntered = resolve;
    });
    const providerTasks = {
      report: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const activateProviderTasks = vi.fn(async () => {
      order.push('observer');
      return { providerTasks, isCurrentRuntime: () => true };
    });
    mockClaudeRemoteLauncher.mockImplementationOnce(async () => {
      order.push('provider');
      noteProviderEntered();
      return await new Promise<never>(() => {});
    });

    void runLoop({
      startingMode: 'remote',
      runtimeActivityContributions: { activateProviderTasks },
      onSessionReady: (session) => {
        readySession.current = session;
        order.push('session');
      },
    });
    await providerEntered;
    try {
      expect(activateProviderTasks).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['observer', 'session', 'provider']);
    } finally {
      readySession.current?.cleanup();
    }
  });
});
