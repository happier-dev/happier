import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
    const onWatcherUnavailable = vi.fn();
    const onWatcherAttached = vi.fn();
    const stop = startFileWatcher(file, async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('listener rejected delivery');
      }
    }, { emitInitial: false, onWatcherUnavailable, onWatcherAttached });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(file, 'retry-me\n', 'utf8');
    await waitFor(() => calls >= 2, { timeoutMs: 10_000 });
    stop();
    expect(onWatcherUnavailable).toHaveBeenCalledWith(expect.any(Error));
    expect(onWatcherAttached.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports loss and recovers when the watched parent is renamed and recreated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happy-file-watcher-parent-replaced-'));
    const parent = join(root, 'parent');
    await mkdir(parent);
    const file = join(parent, 'session.jsonl');
    await writeFile(file, 'initial\n');
    let calls = 0;
    const onWatcherUnavailable = vi.fn();
    const onWatcherAttached = vi.fn();
    const stop = startFileWatcher(file, () => { calls += 1; }, {
      emitInitial: false, onWatcherUnavailable, onWatcherAttached,
    });
    try {
      await waitFor(() => onWatcherAttached.mock.calls.length > 0);
      await rename(parent, join(root, 'moved'));
      await mkdir(parent);
      await writeFile(file, 'replacement\n');
      await waitFor(() => calls > 0);
      await waitFor(() => onWatcherAttached.mock.calls.length > 1);
      expect(onWatcherUnavailable).toHaveBeenCalledWith(expect.any(Error));
      const before = calls;
      await appendFile(file, 'appended\n');
      await waitFor(() => calls > before);
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes directory children even when the directory was missing at registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happy-file-watcher-created-dir-'));
    const directory = join(root, 'plugins');
    const changes: string[] = [];
    const stop = startFileWatcher(directory, (path) => { changes.push(path); }, {
      emitInitial: false, reportEventPath: true,
    });
    try {
      await mkdir(directory);
      await waitFor(() => changes.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const child = join(directory, 'plugin.ts');
      await writeFile(child, 'export const value = 1;\n');
      await waitFor(() => changes.includes(child));
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the changed child path to directory observers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happy-file-watcher-dir-event-'));
    const child = join(root, 'plugin.ts');
    const changes: string[] = [];
    let attached = false;
    const stop = startFileWatcher(root, (path) => { changes.push(path); }, {
      emitInitial: false, reportEventPath: true, onWatcherAttached: () => { attached = true; },
    });
    try {
      await waitFor(() => attached);
      await writeFile(child, 'export const value = 1;\n');
      await waitFor(() => changes.includes(child));
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes fixed-file creation below a contained alias with initially missing parents without a timer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happy-file-watcher-missing-alias-parent-'));
    const native = join(root, 'native');
    const alias = join(root, 'alias');
    await mkdir(native);
    await symlink(native, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const file = join(alias, 'env', 'manifest.toml');
    let calls = 0;
    let attachments = 0;
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const stop = startFileWatcher(file, () => { calls++; }, {
      emitInitial: false, recovery: 'events', onWatcherAttached: () => { attachments++; },
    });
    try {
      await vi.waitFor(() => expect(attachments).toBe(1));
      await mkdir(join(native, 'env'));
      await writeFile(join(native, 'env', 'manifest.toml'), 'initial');
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      await vi.waitFor(() => expect(attachments).toBeGreaterThan(1));
      const before = calls;
      await appendFile(join(native, 'env', 'manifest.toml'), 'updated');
      await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
      expect(timer.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
    } finally { await stop.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('reattaches a declaration alias from observed replacement without a recovery timer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happy-file-watcher-event-recovery-'));
    const first = join(root, 'first.json');
    const second = join(root, 'second.json');
    const file = join(root, 'package.json');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    await symlink(first, file);
    let calls = 0;
    let attachments = 0;
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const stop = startFileWatcher(file, () => { calls++; }, {
      emitInitial: false, recovery: 'events', onWatcherAttached: () => { attachments++; },
    });
    try {
      await vi.waitFor(() => expect(attachments).toBe(1));
      const replacement = join(root, 'replacement');
      await symlink(second, replacement);
      await rename(replacement, file);
      await vi.waitFor(() => expect(attachments).toBeGreaterThan(1));
      const before = calls;
      await appendFile(second, 'updated');
      await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
      expect(timer.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
    } finally { await stop.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('observes writes to a file symlink target outside the watched parent and follows retargeting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happy-file-watcher-symlink-'));
    const logicalDirectory = join(root, 'logical');
    const nativeDirectory = join(root, 'native');
    await mkdir(logicalDirectory);
    await mkdir(nativeDirectory);
    const target = join(nativeDirectory, 'transcript.jsonl');
    const file = join(logicalDirectory, 'session.jsonl');
    await writeFile(target, 'initial\n');
    await symlink(target, file);
    let calls = 0;
    let attached = false;
    const stop = startFileWatcher(file, () => { calls += 1; }, {
      emitInitial: false, onWatcherAttached: () => { attached = true; },
    });
    try {
      await waitFor(() => attached);
      await appendFile(target, 'external\n');
      await waitFor(() => calls > 0);
      const nextTarget = join(nativeDirectory, 'next.jsonl');
      await writeFile(nextTarget, 'next\n');
      const replacement = join(logicalDirectory, 'replacement');
      await symlink(nextTarget, replacement);
      const before = calls;
      await rename(replacement, file);
      await waitFor(() => calls > before);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const afterRetarget = calls;
      await appendFile(nextTarget, 'retargeted\n');
      await waitFor(() => calls > afterRetarget);
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers when a missing parent appears after the former attachment timeout', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'happy-file-watcher-late-parent-'));
    const file = join(root, 'tasks', 'task.output');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    let calls = 0;
    const onWatcherUnavailable = vi.fn();

    const stop = startFileWatcher(file, () => {
      calls += 1;
    }, { onWatcherUnavailable });

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
    try {
      for (let attempt = 0; attempt < 35; attempt += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
      }
      expect(onWatcherUnavailable).toHaveBeenCalledWith(expect.any(Error));
      await mkdir(join(root, 'tasks'));
      await writeFile(file, 'late creation\n');
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await waitFor(() => calls > 0);
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
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
    expect(onWatcherUnavailable).toHaveBeenCalledOnce();
  });
});
