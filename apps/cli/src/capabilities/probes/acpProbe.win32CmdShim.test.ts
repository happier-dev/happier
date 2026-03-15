import { describe, expect, it, vi } from 'vitest';
import { DefaultTransport } from '@/agent/transport';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

class FakeChildProcess extends EventEmitter {
  killed = false;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(_signal?: string) {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

describe('probeAcpAgentCapabilities (Windows cmd shim)', () => {
  it('wraps command-only .cmd shims with cmd.exe on Windows', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }

    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    try {
      vi.resetModules();

      type SpawnFn = (command: string, args: ReadonlyArray<string>, options: Record<string, unknown>) => unknown;
      const spawnMock = vi.fn<SpawnFn>(() => new FakeChildProcess() as any);
      vi.doMock('node:child_process', async (importOriginal) => {
        const original = await importOriginal<typeof import('node:child_process')>();
        return { ...original, spawn: spawnMock };
      });

      const { probeAcpAgentCapabilities } = await import('./acpProbe');
      const result = await probeAcpAgentCapabilities({
        command: 'fake-acp.cmd',
        args: ['--stdio'],
        cwd: process.cwd(),
        env: {},
        transport: new DefaultTransport('codex'),
        timeoutMs: 10,
      });

      expect(result.ok).toBe(false);
      expect(spawnMock).toHaveBeenCalled();
      const [spawnCommand, spawnArgs, spawnOptions] = spawnMock.mock.calls.at(0)!;

      expect(spawnCommand).toBe('cmd.exe');
      expect(spawnArgs.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(spawnArgs[3]).toContain('fake-acp.cmd');
      expect(spawnArgs[3]).toContain('--stdio');
      expect(spawnOptions).toEqual(expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }));
      expect(spawnOptions?.shell).not.toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
});
