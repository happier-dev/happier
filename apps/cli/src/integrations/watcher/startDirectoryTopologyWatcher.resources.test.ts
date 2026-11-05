import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const synchronousFilesystem = vi.hoisted(() => ({ canonicalizations: 0, stats: 0, containmentChecks: 0 }));

// Native filesystem calls are the system boundary; retain the real watcher and traversal.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
            synchronousFilesystem.canonicalizations += 1;
            return actual.realpathSync(...args);
        },
        statSync: (...args: Parameters<typeof actual.statSync>) => {
            synchronousFilesystem.stats += 1;
            return actual.statSync(...args);
        },
    };
});

// Path containment is platform work; file events must not scan unrelated watchers.
vi.mock('node:path', async importOriginal => {
    const actual = await importOriginal<typeof import('node:path')>();
    return { ...actual, relative: (...args: Parameters<typeof actual.relative>) => {
        synchronousFilesystem.containmentChecks += 1;
        return actual.relative(...args);
    } };
});

import { startDirectoryTopologyWatcher } from './startDirectoryTopologyWatcher';

async function inotifyWatchCount() {
    const descriptors = await readdir('/proc/self/fdinfo');
    const contents = await Promise.all(descriptors.map(name =>
        readFile(`/proc/self/fdinfo/${name}`, 'utf8').catch(() => ''),
    ));
    return contents.reduce((count, content) => count + (content.match(/^inotify wd:/gm)?.length ?? 0), 0);
}

it.skipIf(process.platform !== 'linux')('observes a native tree with one Linux watch per directory, independent of transcript count', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'happier-topology-resources-')));
    const root = join(parent, 'sessions');
    const day = join(root, '2026', '10');
    await mkdir(day, { recursive: true });
    await Promise.all(Array.from({ length: 128 }, (_, i) => writeFile(join(day, `${i}.jsonl`), '{}\n')));
    const baseline = await inotifyWatchCount();
    synchronousFilesystem.canonicalizations = 0;
    synchronousFilesystem.stats = 0;
    const ready = vi.fn();
    const changed = vi.fn();
    const unavailable = vi.fn();
    const dispose = startDirectoryTopologyWatcher(root, changed, { onReady: ready, onUnavailable: unavailable });
    try {
        await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
        expect(unavailable).not.toHaveBeenCalled();
        // Three directories beneath the root plus its existing recovery sentinel.
        expect(await inotifyWatchCount() - baseline).toBe(4);
        synchronousFilesystem.containmentChecks = 0;
        await writeFile(join(day, 'new.jsonl'), '{}\n');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(join(day, 'new.jsonl')));
        expect(await inotifyWatchCount() - baseline).toBe(4);
        // Enrolling the same native tree may not monopolize the daemon main thread
        // with synchronous path/metadata work, regardless of its transcript count.
        expect(synchronousFilesystem.canonicalizations).toBe(0);
        expect(synchronousFilesystem.stats).toBe(0);
        expect(synchronousFilesystem.containmentChecks).toBe(0);
    } finally {
        dispose();
        await vi.waitFor(async () => expect(await inotifyWatchCount()).toBe(baseline));
        await rm(parent, { recursive: true, force: true });
    }
});

it.skipIf(process.platform !== 'linux')('enrols new subtrees and recovers deleted roots without following recreated symlinks', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'happier-topology-recovery-')));
    const root = join(parent, 'sessions');
    const outside = join(parent, 'outside');
    await mkdir(outside);
    await mkdir(root);
    const baseline = await inotifyWatchCount();
    const changed = vi.fn();
    const ready = vi.fn();
    const unavailable = vi.fn();
    const dispose = startDirectoryTopologyWatcher(root, changed, { onReady: ready, onUnavailable: unavailable });
    try {
        await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
        const nested = join(root, 'new', 'day');
        await mkdir(nested, { recursive: true });
        await writeFile(join(nested, 'initial.jsonl'), '{}\n');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(join(root, 'new')));
        await vi.waitFor(async () => expect(await inotifyWatchCount() - baseline).toBe(4));
        await writeFile(join(nested, 'later.jsonl'), '{}\n');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(join(nested, 'later.jsonl')));
        changed.mockClear();
        await appendFile(join(nested, 'later.jsonl'), '{}\n');
        await new Promise(resolve => setTimeout(resolve, 50));
        // Content is delivered by startFileWatcher, not a topology invalidation.
        expect(changed).not.toHaveBeenCalled();

        await rm(join(root, 'new'), { recursive: true });
        await vi.waitFor(async () => expect(await inotifyWatchCount() - baseline).toBe(2));
        changed.mockClear();
        await mkdir(nested, { recursive: true });
        await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(join(root, 'new')));
        await vi.waitFor(async () => expect(await inotifyWatchCount() - baseline).toBe(4));
        await writeFile(join(nested, 'recreated.jsonl'), '{}\n');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(join(nested, 'recreated.jsonl')));

        await rm(root, { recursive: true });
        await vi.waitFor(async () => expect(await inotifyWatchCount() - baseline).toBe(1));
        await symlink(outside, root, 'dir');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(undefined));
        changed.mockClear();
        await writeFile(join(outside, 'unobserved.jsonl'), '{}\n');
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(await inotifyWatchCount() - baseline).toBe(1);
        // Parent recovery notifications can finish after the root was replaced.
        // An outside file must never acquire a watch or produce a file notification.
        expect(changed.mock.calls.every(([path]) => path === undefined)).toBe(true);
        await rm(root);
        await mkdir(root);
        await vi.waitFor(async () => expect(await inotifyWatchCount() - baseline).toBe(2));
        await writeFile(join(root, 'returned.jsonl'), '{}\n');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(join(root, 'returned.jsonl')));
        expect(unavailable).not.toHaveBeenCalled();
    } finally {
        dispose();
        await vi.waitFor(async () => expect(await inotifyWatchCount()).toBe(baseline));
        await rm(parent, { recursive: true, force: true });
    }
});
