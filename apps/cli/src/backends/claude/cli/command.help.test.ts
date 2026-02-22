import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeCliCommand } from './command';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('happier (default claude) help output', () => {
  it('includes global server selection flags', async () => {
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
  });
});
