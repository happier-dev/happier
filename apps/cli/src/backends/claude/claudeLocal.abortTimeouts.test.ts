import { describe, it, expect, vi } from 'vitest';

const { mockSpawn, mockResolveClaudeCliPath, mockIsClaudeCliJavaScriptFile } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockResolveClaudeCliPath: vi.fn(),
  mockIsClaudeCliJavaScriptFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./utils/path', () => ({
  getProjectPath: vi.fn((path: string) => path),
}));

vi.mock('./utils/systemPrompt', () => ({
  getClaudeSystemPrompt: () => 'test-system-prompt',
  systemPrompt: () => 'test-system-prompt',
}));

vi.mock('./utils/resolveClaudeCliPath', () => ({
  resolveClaudeCliPath: mockResolveClaudeCliPath,
  isClaudeCliJavaScriptFile: mockIsClaudeCliJavaScriptFile,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

vi.mock('./utils/claudeCheckSession', () => ({
  claudeCheckSession: vi.fn(() => true),
}));

describe('claudeLocal abort escalation timers', () => {
  it('uses configured abort escalation/kill delays (SIGINT → SIGTERM → SIGKILL)', async () => {
    const previousEscalate = process.env.HAPPIER_CLAUDE_LOCAL_ABORT_ESCALATE_AFTER_MS;
    const previousKill = process.env.HAPPIER_CLAUDE_LOCAL_ABORT_KILL_AFTER_MS;
    process.env.HAPPIER_CLAUDE_LOCAL_ABORT_ESCALATE_AFTER_MS = '50';
    process.env.HAPPIER_CLAUDE_LOCAL_ABORT_KILL_AFTER_MS = '100';

    try {
      vi.useFakeTimers();
      vi.resetModules();

      // Force the direct (non-node-launcher) spawn path so we don't need to mock the JS runtime resolver.
      mockResolveClaudeCliPath.mockReturnValue('/tmp/claude');
      mockIsClaudeCliJavaScriptFile.mockReturnValue(false);

      const kill = vi.fn(() => true);

      mockSpawn.mockReturnValueOnce({
        pid: 4242,
        killed: false,
        stdio: [null, null, null, null],
        on: vi.fn((event: string, callback: (...args: any[]) => void) => {
          if (event === 'exit') {
            // Resolve after SIGKILL would have fired (50ms + 100ms + 50ms = 150ms).
            setTimeout(() => callback(0, null), 150);
          }
        }),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        kill,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: {
          on: vi.fn(),
          end: vi.fn(),
        },
      });

      const controller = new AbortController();
      const { claudeLocal } = await import('./claudeLocal');
      const promise = claudeLocal({
        abort: controller.signal,
        sessionId: null,
        path: '/tmp',
        onSessionFound: () => {},
        claudeArgs: [],
      });

      controller.abort();

      expect(kill).toHaveBeenCalledWith('SIGINT');

      await vi.advanceTimersByTimeAsync(49);
      expect(kill).not.toHaveBeenCalledWith('SIGTERM');
      expect(kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(50);
      expect(kill).toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(50);
      await expect(promise).resolves.toBeTruthy();
    } finally {
      vi.useRealTimers();
      if (previousEscalate === undefined) delete process.env.HAPPIER_CLAUDE_LOCAL_ABORT_ESCALATE_AFTER_MS;
      else process.env.HAPPIER_CLAUDE_LOCAL_ABORT_ESCALATE_AFTER_MS = previousEscalate;
      if (previousKill === undefined) delete process.env.HAPPIER_CLAUDE_LOCAL_ABORT_KILL_AFTER_MS;
      else process.env.HAPPIER_CLAUDE_LOCAL_ABORT_KILL_AFTER_MS = previousKill;
    }
  });
});
