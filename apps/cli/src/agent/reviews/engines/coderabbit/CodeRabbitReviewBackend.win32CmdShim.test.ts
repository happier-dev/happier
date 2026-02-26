import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'node:events';

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeStdin {
  end(): void {}
}

class FakeChildProcess extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new FakeStream();
  stderr = new FakeStream();

  kill(): boolean {
    return true;
  }
}

describe('CodeRabbitReviewBackend Windows .CMD shim spawning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('node:child_process');
  });

  it('wraps .cmd commands with cmd.exe on Windows', async () => {
    await withPlatform('win32', async () => {
      vi.resetModules();

      const spawnSpy = vi.fn(() => {
        const child = new FakeChildProcess();
        setTimeout(() => child.emit('close', 0), 0);
        return child as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
      });

      vi.doMock('node:child_process', async (importOriginal) => {
        const original = await importOriginal<typeof import('node:child_process')>();
        return { ...original, spawn: spawnSpy };
      });

      const cmdPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\coderabbit.CMD';
      const { CodeRabbitReviewBackend } = await import('./CodeRabbitReviewBackend');

      const backend = new CodeRabbitReviewBackend({
        cwd: process.cwd(),
        env: { ...process.env, HAPPIER_CODERABBIT_REVIEW_CMD: cmdPath },
      });
      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'test');
      } finally {
        await backend.dispose();
      }

      expect(spawnSpy).toHaveBeenCalled();
      expect(spawnSpy).toHaveBeenCalledWith(
        'cmd.exe',
        ['/d', '/s', '/c', expect.stringContaining(cmdPath)],
        expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }),
      );
    });
  });
});
