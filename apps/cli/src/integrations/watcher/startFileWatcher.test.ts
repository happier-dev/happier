import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFileWatcher } from './startFileWatcher';

async function waitFor(condition: () => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const intervalMs = opts?.intervalMs ?? 25;
  const start = Date.now();
  while (true) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function missingParentOutputFile(): string {
  return join(tmpdir(), `happy-file-watcher-missing-parent-${randomUUID()}`, 'tasks', 'task.output');
}

function watcherDebugMessages(debugSpy: ReturnType<typeof vi.spyOn>): string[] {
  return debugSpy.mock.calls.map(([message]) => String(message));
}

describe('startFileWatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires when a missing file is created and later modified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-file-watcher-'));
    const file = join(dir, 'out.jsonl');

    let calls = 0;
    const stop = startFileWatcher(file, () => {
      calls += 1;
    });

    await writeFile(file, 'hello\n', 'utf8');
    await waitFor(() => calls >= 1);

    await appendFile(file, 'world\n', 'utf8');
    await waitFor(() => calls >= 2);

    stop();

    const callsBefore = calls;
    await appendFile(file, 'after-stop\n', 'utf8');
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(callsBefore);
  });

  it('can skip the initial callback for an existing watched path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-file-watcher-dir-'));
    const file = join(dir, 'plugin.ts');
    await writeFile(file, 'export const value = 1;\n', 'utf8');
    let calls = 0;

    const stop = startFileWatcher(file, () => {
      calls += 1;
    }, { emitInitial: false });

    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(0);

    await appendFile(file, 'export const next = 2;\n', 'utf8');
    await waitFor(() => calls >= 1);

    stop();
  });

  it('reports attachment before a caller may rely on observing later changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-file-watcher-ready-'));
    const file = join(dir, 'session.jsonl');
    await writeFile(file, 'initial\n', 'utf8');
    let attached = false;
    const stop = startFileWatcher(file, () => {}, {
      emitInitial: false,
      onWatcherAttached: () => {
        attached = true;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();

    expect(attached).toBe(true);
  });

  it('treats creation after registration as a change when initial emission is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-file-watcher-created-'));
    const file = join(dir, 'session.jsonl');
    let calls = 0;
    const stop = startFileWatcher(file, () => {
      calls += 1;
    }, { emitInitial: false });

    await writeFile(file, 'created\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 500));
    stop();

    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('continues across append, atomic replacement, deletion, and recreation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-file-watcher-recreate-'));
    const file = join(dir, 'session.jsonl');
    await writeFile(file, 'initial\n', 'utf8');
    let calls = 0;
    const stop = startFileWatcher(file, () => {
      calls += 1;
    }, { emitInitial: false });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(file, 'append\n', 'utf8');
    await waitFor(() => calls >= 1);

    const replacement = join(dir, 'replacement.jsonl');
    await writeFile(replacement, 'replacement\n', 'utf8');
    await rename(replacement, file);
    await waitFor(() => calls >= 2);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await unlink(file);
    await waitFor(() => calls >= 3);
    const beforeRecreate = calls;
    await writeFile(file, 'recreated\n', 'utf8');
    await waitFor(() => calls > beforeRecreate, { timeoutMs: 10_000 });

    stop();
  });

  it('restarts and redrives when an asynchronous change callback rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-file-watcher-redrive-'));
    const file = join(dir, 'session.jsonl');
    await writeFile(file, 'initial\n', 'utf8');
    let calls = 0;
    const stop = startFileWatcher(file, async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('listener rejected delivery');
      }
    }, { emitInitial: false });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(file, 'retry-me\n', 'utf8');
    await waitFor(() => calls >= 2, { timeoutMs: 10_000 });

    stop();
  });

  it('expires missing-parent retries instead of looping forever', async () => {
    vi.useFakeTimers();
    const file = missingParentOutputFile();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    let calls = 0;
    const onWatcherUnavailable = vi.fn();

    const stop = startFileWatcher(file, () => {
      calls += 1;
    }, { onWatcherUnavailable });

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(120_000);
      if (watcherDebugMessages(debugSpy).some((message) =>
        message.includes('Parent directory still missing'))) {
        break;
      }
    }
    expect(watcherDebugMessages(debugSpy).some((message) =>
      message.includes('Parent directory still missing'))).toBe(true);
    expect(onWatcherUnavailable).toHaveBeenCalledOnce();
    const debugCountAfterExpiry = watcherDebugMessages(debugSpy).length;

    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toBe(0);
    expect(watcherDebugMessages(debugSpy)).toHaveLength(debugCountAfterExpiry);
    expect(watcherDebugMessages(debugSpy).length).toBeLessThanOrEqual(3);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a missing-parent retry timer when stopped', async () => {
    vi.useFakeTimers();
    const file = missingParentOutputFile();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const onWatcherUnavailable = vi.fn();

    const stop = startFileWatcher(file, () => {
      throw new Error('missing-parent watcher should not fire');
    }, { onWatcherUnavailable });

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    stop();

    expect(vi.getTimerCount()).toBe(0);
    const debugCountAfterStop = watcherDebugMessages(debugSpy).length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(watcherDebugMessages(debugSpy)).toHaveLength(debugCountAfterStop);
    expect(onWatcherUnavailable).not.toHaveBeenCalled();
  });
});
