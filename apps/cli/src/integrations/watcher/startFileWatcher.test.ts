import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
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

  it('expires missing-parent retries instead of looping forever', async () => {
    vi.useFakeTimers();
    const file = missingParentOutputFile();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    let calls = 0;

    const stop = startFileWatcher(file, () => {
      calls += 1;
    });

    await vi.advanceTimersByTimeAsync(120_000);
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

    const stop = startFileWatcher(file, () => {
      throw new Error('missing-parent watcher should not fire');
    });

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    stop();

    expect(vi.getTimerCount()).toBe(0);
    const debugCountAfterStop = watcherDebugMessages(debugSpy).length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(watcherDebugMessages(debugSpy)).toHaveLength(debugCountAfterStop);
  });
});
