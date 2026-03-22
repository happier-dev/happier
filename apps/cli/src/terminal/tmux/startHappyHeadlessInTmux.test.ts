import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TmuxCommandResult, TmuxSpawnOptions } from '@/integrations/tmux';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

vi.mock('chalk', () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
  },
}));

const mockSpawnInTmux = vi.fn(
  async (_args: string[], _options: TmuxSpawnOptions, _env?: Record<string, string>) => ({ success: true as const }),
);
const mockExecuteTmuxCommand = vi.fn(
  async (): Promise<TmuxCommandResult> => ({ returncode: 0, stdout: '', stderr: '', command: ['tmux'] }),
);

vi.mock('@/integrations/tmux', () => {
  class TmuxUtilities {
    static DEFAULT_SESSION_NAME = 'happy';
    constructor() {}
    executeTmuxCommand = mockExecuteTmuxCommand;
    spawnInTmux = mockSpawnInTmux;
  }

  return {
    isTmuxAvailable: vi.fn(async () => true),
    selectPreferredTmuxSessionName: () => 'picked',
    TmuxUtilities,
  };
});

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: () => ({ runtime: 'node', filePath: 'node', args: ['happy'] }),
}));

describe.sequential('startHappyHeadlessInTmux', () => {
  const trackedEnvKeys = ['TMUX', 'TMUX_PANE', 'HAPPY_TEST_FOO'] as const;
  const baselineEnv: Record<string, string | undefined> = Object.fromEntries(
    trackedEnvKeys.map((key) => [key, process.env[key]]),
  );

  let nowSpy: ReturnType<typeof vi.spyOn>;
  let output = captureConsoleText();

  const restoreTrackedEnv = () => {
    for (const key of trackedEnvKeys) {
      const value = baselineEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  beforeEach(() => {
    restoreTrackedEnv();
    vi.clearAllMocks();
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123);
    output.restore();
    output = captureConsoleText();
  });

  afterEach(() => {
    nowSpy.mockRestore();
    output.restore();
    restoreTrackedEnv();
  });

  it('prints only select-window when already inside tmux', async () => {
    process.env.TMUX = '1';
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    expect(output.lines.some((line) => line.includes('Started Happier in tmux'))).toBe(true);
    expect(output.lines.some((line) => line.includes('tmux select-window -t') && line.includes('picked:happy-123-claude'))).toBe(true);
    expect(output.lines.some((line) => line.includes('tmux attach -t'))).toBe(false);
  }, 15_000);

  it('prints attach then select-window when outside tmux', async () => {
    delete process.env.TMUX;
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    const attachIdx = output.lines.findIndex((line) => line.includes('tmux attach -t') && line.includes('happy'));
    const selectIdx = output.lines.findIndex((line) => line.includes('tmux select-window -t') && line.includes('happy:happy-123-claude'));
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeLessThan(selectIdx);
  });

  it('does not pass TMUX variables through to the tmux window environment', async () => {
    process.env.TMUX = '1';
    process.env.TMUX_PANE = '%1';
    process.env.HAPPY_TEST_FOO = 'bar';
    const { startHappyHeadlessInTmux } = await import('./startHappyHeadlessInTmux');

    await startHappyHeadlessInTmux([]);

    const env = mockSpawnInTmux.mock.calls[0]?.[2] as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env?.TMUX).toBeUndefined();
    expect(env?.TMUX_PANE).toBeUndefined();
    expect(env?.HAPPY_TEST_FOO).toBe('bar');
  });
});
