import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';

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

class ControlledChildProcess extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new FakeStream();
  stderr = new FakeStream();

  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  close(code: number | null = 0): void {
    this.emit('close', code);
  }
}

describe('CodeRabbitReviewBackend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('node:child_process');
  });

  it('defaults to uncommitted review type when no intentInput is provided', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-backend-default-'));

    const spawnSpy = vi.fn(() => {
      const child = new FakeChildProcess();
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return { ...original, spawn: spawnSpy };
    });

    const { CodeRabbitReviewBackend } = await import('./CodeRabbitReviewBackend');
    const backend = new CodeRabbitReviewBackend({
      cwd: workspace,
      env: { ...process.env, HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit' },
    });

    try {
      await backend.provisionSession({ initialPrompt: 'Review the current scope.' });
    } finally {
      await backend.dispose();
    }

    const spawnCalls = spawnSpy.mock.calls as unknown as Array<[string, string[], unknown]>;
    const spawnArgs = spawnCalls[0]?.[1];
    expect(spawnArgs).toContain('--type');
    expect(spawnArgs).toContain('uncommitted');
  });

  it('exposes the execution-run host runtime contract directly', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-host-runtime-'));

    const spawnSpy = vi.fn(() => {
      const child = new FakeChildProcess();
      setTimeout(() => child.stdout.emit('data', 'review output'));
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return { ...original, spawn: spawnSpy };
    });

    const { CodeRabbitReviewBackend } = await import('./CodeRabbitReviewBackend');
    const backend = new CodeRabbitReviewBackend({
      cwd: workspace,
      env: { ...process.env, HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit' },
    }) as unknown as {
      readResumeSupport: (opts?: { captureReplay?: boolean }) => Promise<boolean>;
      provisionSession: (opts?: { initialPrompt?: string; resumeSessionId?: string }) => Promise<{ sessionId: string }>;
      subscribeMessages: (handler: (msg: unknown) => void) => () => void;
      dispose: () => Promise<void>;
      startSession?: unknown;
      onMessage?: unknown;
    };

    const messages: unknown[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    try {
      expect(backend.startSession).toBeUndefined();
      expect(backend.onMessage).toBeUndefined();
      await expect(backend.readResumeSupport()).resolves.toBe(false);
      const started = await backend.provisionSession({ initialPrompt: 'Review the current scope.' });
      expect(started.sessionId).toEqual(expect.any(String));
      expect(messages).toContainEqual(expect.objectContaining({ type: 'model-output' }));
    } finally {
      unsubscribe();
      await backend.dispose();
    }
  });

  it('passes a resolved base ref for committed reviews when base.kind is none', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'happier-coderabbit-backend-remote-'));
    runGit(remote, ['init', '--bare', '--initial-branch=main']);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-backend-workspace-'));
    runGit(workspace, ['init', '--initial-branch=main']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'base']);
    runGit(workspace, ['remote', 'add', 'origin', remote]);
    runGit(workspace, ['push', '-u', 'origin', 'main']);

    const spawnSpy = vi.fn(() => {
      const child = new FakeChildProcess();
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return { ...original, spawn: spawnSpy };
    });

    const { CodeRabbitReviewBackend } = await import('./CodeRabbitReviewBackend');
    const backend = new CodeRabbitReviewBackend({
      cwd: workspace,
      env: { ...process.env, HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit' },
      start: {
        intentInput: {
          engineIds: ['coderabbit'],
          instructions: 'Review the current scope.',
          changeType: 'committed',
          base: { kind: 'none' },
        },
      },
    });

    try {
      await backend.provisionSession({ initialPrompt: 'Review the current scope.' });
    } finally {
      await backend.dispose();
    }

    const spawnCalls = spawnSpy.mock.calls as unknown as Array<[string, string[], unknown]>;
    const spawnArgs = spawnCalls[0]?.[1];
    expect(spawnArgs).toBeTruthy();
    expect(spawnArgs).toContain('--base');
    expect(spawnArgs).toContain('origin/main');
  });

  it('waits for the child close before cancellation and dispose resolve', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-dispose-wait-'));
    const child = new ControlledChildProcess();

    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return { ...original, spawn: vi.fn(() => child as unknown as import('node:child_process').ChildProcessWithoutNullStreams) };
    });

    const { CodeRabbitReviewBackend } = await import('./CodeRabbitReviewBackend');
    const backend = new CodeRabbitReviewBackend({
      cwd: workspace,
      env: {
        ...process.env,
        HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
      },
    });

    const started = await backend.provisionSession();
    const sendOutcomePromise = backend
      .sendPrompt(started.sessionId, 'Review the current scope.')
      .then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelPromise = backend.cancel(started.sessionId);
    const disposePromise = backend.dispose();

    let cancelResolved = false;
    let disposeResolved = false;
    void cancelPromise.then(() => {
      cancelResolved = true;
    });
    void disposePromise.then(() => {
      disposeResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(child.killCalls).toBeGreaterThan(0);
    expect(cancelResolved).toBe(false);
    expect(disposeResolved).toBe(false);

    child.close(null);

    await expect(sendOutcomePromise).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringMatching(/cancelled/i),
      }),
    });
    await expect(cancelPromise).resolves.toBeUndefined();
    await expect(disposePromise).resolves.toBeUndefined();
  });

  it('waits for the child close before timing out the review run', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-timeout-wait-'));
    const child = new ControlledChildProcess();

    vi.doMock('node:child_process', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:child_process')>();
      return { ...original, spawn: vi.fn(() => child as unknown as import('node:child_process').ChildProcessWithoutNullStreams) };
    });

    const { CodeRabbitReviewBackend } = await import('./CodeRabbitReviewBackend');
    const backend = new CodeRabbitReviewBackend({
      cwd: workspace,
      env: {
        ...process.env,
        HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
        HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS: '1',
      },
    });

    const started = await backend.provisionSession();
    const sendOutcomePromise = backend
      .sendPrompt(started.sessionId, 'Review the current scope.')
      .then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));

    await new Promise((resolve) => setTimeout(resolve, 5));

    let settled = false;
    void sendOutcomePromise.finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(child.killCalls).toBeGreaterThan(0);
    expect(settled).toBe(false);

    child.close(null);

    await expect(sendOutcomePromise).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringMatching(/timed out/i),
      }),
    });
  });
});
