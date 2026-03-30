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
      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'Review the current scope.');
    } finally {
      await backend.dispose();
    }

    const spawnCalls = spawnSpy.mock.calls as unknown as Array<[string, string[], unknown]>;
    const spawnArgs = spawnCalls[0]?.[1];
    expect(spawnArgs).toContain('--type');
    expect(spawnArgs).toContain('uncommitted');
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
      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'Review the current scope.');
    } finally {
      await backend.dispose();
    }

    const spawnCalls = spawnSpy.mock.calls as unknown as Array<[string, string[], unknown]>;
    const spawnArgs = spawnCalls[0]?.[1];
    expect(spawnArgs).toBeTruthy();
    expect(spawnArgs).toContain('--base');
    expect(spawnArgs).toContain('origin/main');
  });
});
