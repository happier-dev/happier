import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

const mockClaudeLocalLauncher = vi.fn();
vi.mock('./claudeLocalLauncher', () => ({
  claudeLocalLauncher: mockClaudeLocalLauncher,
}));

const mockClaudeRemoteLauncher = vi.fn();
vi.mock('./claudeRemoteLauncher', () => ({
  claudeRemoteLauncher: mockClaudeRemoteLauncher,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happier-cli-test.log',
  },
}));

type LoopOptions = Parameters<(typeof import('./loop'))['loop']>[0];

type LoopClientStub = Pick<
  ApiSessionClient,
  'keepAlive' | 'getMetadataSnapshot' | 'fetchLatestUserPermissionIntentFromTranscript' | 'updateMetadata'
>;

function createLoopClient(overrides?: Partial<LoopClientStub>): LoopClientStub {
  return {
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    fetchLatestUserPermissionIntentFromTranscript: async () => null,
    updateMetadata: vi.fn(),
    ...overrides,
  };
}

async function runLoop(options?: Partial<LoopOptions>): Promise<{ code: number; keepAlive: ReturnType<typeof vi.fn>; capturedSession: Session | null }> {
  const keepAlive = vi.fn();
  const client = createLoopClient({ keepAlive });
  const messageQueue = new MessageQueue2<EnhancedMode>(() => 'mode');
  const { loop } = await import('./loop');

  let capturedSession: Session | null = null;

  const code = await loop({
    path: '/tmp',
    onModeChange: () => {},
    mcpServers: {},
    session: client as unknown as ApiSessionClient,
    api: {} as never,
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
  });

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
});
