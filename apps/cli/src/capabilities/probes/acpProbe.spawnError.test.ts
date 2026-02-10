import { describe, expect, it, vi } from 'vitest';

import { DefaultTransport } from '@/agent/transport';
import { EventEmitter } from 'node:events';

class FakeChildProcess extends EventEmitter {
  killed = false;
  stdin: null = null;
  stdout: null = null;
  stderr: null = null;

  kill(_signal?: string) {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

describe('probeAcpAgentCapabilities spawn error handling', () => {
  it('does not leak uncaughtException when ACP command is missing', async () => {
    const uncaught: unknown[] = [];
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };

    process.on('uncaughtException', onUncaught);
    try {
      const { probeAcpAgentCapabilities } = await import('./acpProbe');
      const result = await probeAcpAgentCapabilities({
        command: 'happier-missing-acp-binary-for-probe-test',
        args: [],
        cwd: process.cwd(),
        env: {},
        transport: new DefaultTransport('codex'),
        timeoutMs: 250,
      });

      expect(result.ok).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not leak unhandledRejection when a spawn error fires after an early failure', async () => {
    vi.resetModules();

    let fakeChild: FakeChildProcess | null = null;
    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return {
        ...original,
        spawn: vi.fn(() => {
          fakeChild = new FakeChildProcess();
          return fakeChild as unknown as import('node:child_process').ChildProcess;
        }),
      };
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };

    process.on('unhandledRejection', onUnhandled);
    try {
      const { probeAcpAgentCapabilities } = await import('./acpProbe');
      const result = await probeAcpAgentCapabilities({
        command: 'fake-acp-probe',
        args: [],
        cwd: process.cwd(),
        env: {},
        transport: new DefaultTransport('codex'),
        timeoutMs: 50,
      });

      expect(result.ok).toBe(false);

      // Simulate an async spawn error arriving after we already returned.
      setTimeout(() => {
        fakeChild?.emit('error', new Error('spawn failed'));
      }, 0);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.unmock('node:child_process');
    }
  });
});
