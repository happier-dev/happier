import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('execution run backend (coderabbit)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('node:child_process');
  });

  it('starts the CodeRabbit execution run through the central runtime', async () => {
    const spawnSpy = vi.fn(() => {
      const child = new FakeChildProcess();
      setTimeout(() => child.stdout.emit('data', 'review output'), 0);
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return { ...original, spawn: spawnSpy };
    });

    const { createExecutionRunBackend } = await import('./backend.testkit');
    const backend = createExecutionRunBackend({
      cwd: process.cwd(),
      backendId: 'coderabbit',
      permissionMode: 'read_only',
      start: {
        intent: 'review',
      },
    });

    const messages: unknown[] = [];
    backend.onMessage((message) => {
      messages.push(message);
    });

    try {
      const started = await backend.startSession('Review the current scope.');

      expect(started.sessionId).toEqual(expect.stringMatching(/^coderabbit_/));
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'model-output',
        fullText: 'review output',
      }));
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally {
      await backend.dispose();
    }
  });
});
