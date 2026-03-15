import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('node:child_process');
});

describe('happier (default claude) help output', () => {
  it('includes global server selection flags', async () => {
    vi.resetModules();
    const execFileSyncSpy = vi.fn(() => 'claude help output');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return { ...actual, execFileSync: execFileSyncSpy };
    });

    const { handleClaudeCliCommand } = await import('./command');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });

    await expect(
      handleClaudeCliCommand({
        args: ['-h'],
        rawArgv: [],
        terminalRuntime: null,
      } as any),
    ).rejects.toThrow('exit:0');

    exitSpy.mockRestore();
    logSpy.mockRestore();

    const stdout = logs.join('\n');
    expect(stdout).toContain('--server-url');
    expect(stdout).toContain('--webapp-url');
    expect(stdout).toContain('--public-server-url');
    expect(stdout).toContain('--server ');
    expect(stdout).not.toContain('--claude-env');

    expect(execFileSyncSpy).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringContaining('claude_local_launcher.cjs'), '--help']),
      expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
    );
  });
});
