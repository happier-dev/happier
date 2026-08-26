import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFileWatcher } from './startFileWatcher';

const realSetTimeout = setTimeout;

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

async function advanceMissingParentRetriesUntilExpired(debugSpy: ReturnType<typeof vi.spyOn>): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (watcherDebugMessages(debugSpy).some((message) => message.includes('stopping watcher'))) {
      return;
    }
    await vi.advanceTimersByTimeAsync(1_000);
    // The retry timer is fake, but each retry performs a real fs.stat. Give
    // libuv a bounded amount of real time before advancing the next fake
    // second so the test cannot outrun filesystem callbacks on a loaded runner.
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for missing-parent watcher expiry. Logs:\n${watcherDebugMessages(debugSpy).join('\n')}`);
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

    await stop();

    const callsBefore = calls;
    await appendFile(file, 'after-stop\n', 'utf8');
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(callsBefore);
  });

  it('expires missing-parent retries instead of looping forever', async () => {
    vi.useFakeTimers();
    const file = missingParentOutputFile();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    let calls = 0;

    const stop = startFileWatcher(file, () => {
      calls += 1;
    });

    await Promise.resolve();
    await advanceMissingParentRetriesUntilExpired(debugSpy);
    const debugCountAfterExpiry = watcherDebugMessages(debugSpy).length;

    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toBe(0);
    expect(watcherDebugMessages(debugSpy)).toHaveLength(debugCountAfterExpiry);
    expect(watcherDebugMessages(debugSpy).length).toBeLessThanOrEqual(3);

    await stop();
  });

  it('clears a missing-parent retry timer when stopped', async () => {
    vi.useFakeTimers();
    const file = missingParentOutputFile();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    const stop = startFileWatcher(file, () => {
      throw new Error('missing-parent watcher should not fire');
    });

    await Promise.resolve();

    await stop();

    const debugCountAfterStop = watcherDebugMessages(debugSpy).length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(watcherDebugMessages(debugSpy)).toHaveLength(debugCountAfterStop);
  });
});
