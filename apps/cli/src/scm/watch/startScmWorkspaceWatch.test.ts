import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';

const boundary = vi.hoisted(() => ({ failurePath: '', failureCode: '', paths: [] as string[], active: new Map<string, number>() }));
// Native resource exhaustion is an OS boundary; keep real traversal, Git and native delivery.
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, watch: (path: string, options: import('node:fs').WatchOptionsWithStringEncoding,
        listener: import('node:fs').WatchListener<string>) => {
        boundary.paths.push(path);
        if (path === boundary.failurePath) throw Object.assign(new Error('Native watch capacity exhausted'), { code: boundary.failureCode });
        const watcher = actual.watch(path, options, listener);
        boundary.active.set(path, (boundary.active.get(path) ?? 0) + 1);
        watcher.once('close', () => {
            const remaining = (boundary.active.get(path) ?? 0) - 1;
            if (remaining === 0) boundary.active.delete(path);
            else boundary.active.set(path, remaining);
        });
        return watcher;
    } };
});

import { startScmWorkspaceWatch } from './startScmWorkspaceWatch';

const registration = createGitScmBackendRuntimeRegistration();
const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
    definition: { id: registration.id }, qualifiedId: 'scm-git/git',
    executableDefinition: registration.runtime!, registration,
})]);

const git = promisify(execFile);
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
    await vi.waitFor(() => expect(boundary.active.size).toBe(0));
    boundary.failurePath = '';
    boundary.failureCode = '';
    boundary.paths = [];
    vi.unstubAllEnvs();
});

async function fixture() {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'happier-scm-watch-')));
    cleanup.push(() => rm(parent, { recursive: true, force: true }));
    const directory = join(parent, 'repo');
    await mkdir(directory);
    await git('git', ['init', '-q', directory]);
    return directory;
}

async function inotifyCount() {
    const descriptors = await readdir('/proc/self/fdinfo');
    const contents = await Promise.all(descriptors.map(name => readFile(`/proc/self/fdinfo/${name}`, 'utf8').catch(() => '')));
    return contents.reduce((count, content) => count + (content.match(/^inotify wd:/gm)?.length ?? 0), 0);
}

it('observes nested external content, empty directories and new subtrees with directory-sized native resources', async () => {
    const directory = await fixture();
    const nested = join(directory, 'src', 'nested');
    const empty = join(directory, 'empty');
    await mkdir(nested, { recursive: true });
    await mkdir(empty);
    await mkdir(join(directory, 'ignored', 'deep'), { recursive: true });
    await writeFile(join(directory, '.gitignore'), 'ignored/\nfuture-ignored/\n');
    await Promise.all(Array.from({ length: 128 }, (_, i) => writeFile(join(nested, `${i}.ts`), 'initial')));
    const changed = vi.fn();
    const ready = vi.fn();
    const unavailable = vi.fn();
    const baseline = process.platform === 'linux' ? await inotifyCount() : null;
    const dispose = startScmWorkspaceWatch({ directory, registry, onChange: changed, onReady: ready, onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(unavailable).not.toHaveBeenCalled();
    if (process.platform === 'linux') {
        for (const path of [directory, join(directory, 'src'), nested, empty]) {
            expect(boundary.paths.filter(value => value === path)).toHaveLength(1);
        }
        expect(boundary.paths).not.toContain(join(directory, 'ignored'));
        expect(boundary.paths).not.toContain(join(nested, '0.ts'));
    }
    changed.mockClear();
    await appendFile(join(nested, '0.ts'), 'external');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    changed.mockClear();
    await writeFile(join(empty, 'first.ts'), 'external');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await mkdir(join(directory, 'future-ignored', 'deep'), { recursive: true });
    const created = join(directory, 'new', 'deep');
    await mkdir(created, { recursive: true });
    if (process.platform === 'linux') await vi.waitFor(() => expect(boundary.paths).toContain(created));
    changed.mockClear();
    await writeFile(join(created, 'external.ts'), 'external');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    if (process.platform === 'linux') expect(boundary.paths).not.toContain(join(directory, 'future-ignored'));
    changed.mockClear();
    await git('git', ['-C', directory, 'symbolic-ref', 'HEAD', 'refs/heads/external']);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    dispose();
    if (baseline !== null) await vi.waitFor(async () => expect(await inotifyCount()).toBe(baseline));
});

it.skipIf(process.platform !== 'linux')('re-filters ignore changes and keeps force-added tracked directories visible', async () => {
    const directory = await fixture();
    await mkdir(join(directory, 'ignored', 'tracked'), { recursive: true });
    await mkdir(join(directory, 'ignored', 'untracked'), { recursive: true });
    await mkdir(join(directory, 'later'), { recursive: true });
    await writeFile(join(directory, '.gitignore'), 'ignored/\nlater/\n');
    await writeFile(join(directory, 'ignored', 'tracked', 'kept.ts'), 'tracked');
    await git('git', ['-C', directory, 'add', '-f', 'ignored/tracked/kept.ts']);
    const ready = vi.fn();
    const changed = vi.fn();
    const unavailable = vi.fn();
    const dispose = startScmWorkspaceWatch({ directory, registry, onReady: ready, onChange: changed, onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(boundary.paths).toContain(join(directory, 'ignored', 'tracked'));
    expect(boundary.paths).not.toContain(join(directory, 'ignored', 'untracked'));
    expect(boundary.paths).not.toContain(join(directory, 'later'));
    await writeFile(join(directory, '.gitignore'), 'ignored/\n');
    await vi.waitFor(() => expect(boundary.paths).toContain(join(directory, 'later')));
    changed.mockClear();
    await writeFile(join(directory, 'later', 'visible.ts'), 'external');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(unavailable).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'linux')('re-filters repository excludes and the index through native metadata events', async () => {
    const directory = await fixture();
    await mkdir(join(directory, 'excluded'));
    await writeFile(join(directory, '.git', 'info', 'exclude'), 'excluded/\n');
    const ready = vi.fn();
    const changed = vi.fn();
    const unavailable = vi.fn();
    const dispose = startScmWorkspaceWatch({ directory, registry, onReady: ready, onChange: changed, onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(boundary.paths).not.toContain(join(directory, 'excluded'));
    await writeFile(join(directory, 'excluded', 'tracked.ts'), 'force-added');
    await git('git', ['-C', directory, 'add', '-f', 'excluded/tracked.ts']);
    await vi.waitFor(() => expect(boundary.paths).toContain(join(directory, 'excluded')));
    changed.mockClear();
    await appendFile(join(directory, 'excluded', 'tracked.ts'), 'external');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(unavailable).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'linux')('observes configured global excludes and ignores content excluded inside watched directories', async () => {
    const directory = await fixture();
    const globalIgnore = join(directory, '..', 'global-ignore');
    await writeFile(globalIgnore, 'excluded/\nignored.txt\n.gitignore\n');
    await git('git', ['-C', directory, 'config', 'core.excludesFile', globalIgnore]);
    await mkdir(join(directory, 'excluded'));
    await writeFile(join(directory, 'ignored.txt'), 'ignored');
    const ready = vi.fn();
    const changed = vi.fn();
    const unavailable = vi.fn();
    const dispose = startScmWorkspaceWatch({ directory, registry, onReady: ready, onChange: changed, onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    changed.mockClear();
    await appendFile(join(directory, 'ignored.txt'), 'external');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(changed).not.toHaveBeenCalled();
    await writeFile(globalIgnore, 'ignored.txt\n.gitignore\n');
    await vi.waitFor(() => expect(boundary.paths).toContain(join(directory, 'excluded')));
    await writeFile(join(directory, '.gitignore'), 'excluded/\n');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await vi.waitFor(() => expect(boundary.active.has(join(directory, 'excluded'))).toBe(false));
    expect(unavailable).not.toHaveBeenCalled();
});

it.each(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])('observes previously absent %s configuration through Git-owned candidate paths', async variable => {
    const directory = await fixture();
    const globalConfig = join(directory, '..', 'gitconfig');
    const globalIgnore = join(directory, '..', 'global-ignore');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(directory, '..', 'absent-global-config'));
    vi.stubEnv('GIT_CONFIG_SYSTEM', join(directory, '..', 'absent-system-config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
    vi.stubEnv(variable, globalConfig);
    await writeFile(globalIgnore, 'excluded/\n');
    await mkdir(join(directory, 'excluded'));
    const ready = vi.fn();
    const changed = vi.fn();
    const unavailable = vi.fn();
    const dispose = startScmWorkspaceWatch({ directory, registry, onReady: ready, onChange: changed, onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    if (process.platform === 'linux') expect(boundary.active.has(join(directory, 'excluded'))).toBe(true);
    await git('git', ['config', '--file', globalConfig, 'core.excludesFile', globalIgnore]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    if (process.platform === 'linux') {
        await vi.waitFor(() => expect(boundary.active.has(join(directory, 'excluded'))).toBe(false));
    }
    expect(unavailable).not.toHaveBeenCalled();
});

it('does not enroll a non-repository tree without an SCM visibility authority', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'happier-not-scm-')));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const unavailable = vi.fn();
    const ready = vi.fn();
    const dispose = startScmWorkspaceWatch({ directory, registry, onReady: ready, onChange: vi.fn(), onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_REPOSITORY' })));
    expect(ready).not.toHaveBeenCalled();
    expect(boundary.paths).toHaveLength(0);
});

it.each(['ENOSPC', 'EMFILE'])('settles %s once and releases every native watch without retrying', async code => {
    const directory = await fixture();
    const nested = join(directory, 'nested');
    await mkdir(nested);
    boundary.failurePath = process.platform === 'linux' ? nested : directory;
    boundary.failureCode = code;
    const baseline = process.platform === 'linux' ? await inotifyCount() : null;
    const unavailable = vi.fn();
    const ready = vi.fn();
    const dispose = startScmWorkspaceWatch({ directory, registry, onChange: vi.fn(), onReady: ready, onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ code, message: expect.any(String) })));
    expect(unavailable).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    if (baseline !== null) await vi.waitFor(async () => expect(await inotifyCount()).toBe(baseline));
    expect(boundary.paths.filter(path => path === boundary.failurePath)).toHaveLength(1);
});

it('observes through the admitted workspace source and releases every source watch on dispose', async () => {
    const { localWorkspaceSource } = await import('@/workspaces/source/localWorkspaceSource');
    const directory = await fixture();
    await writeFile(join(directory, 'tracked.txt'), 'one');
    const used: string[] = [];
    const released: string[] = [];
    // A target stand-in sharing this disk: kind/id differ, so every reach must go through it.
    const source = { ...localWorkspaceSource, kind: 'target' as const, id: 'target:watch-test',
        realpath: async (path: string) => { used.push('realpath'); return await localWorkspaceSource.realpath(path); },
        // A target keeps its own environment and receives only the operation's overlays.
        spawn: (request: Parameters<typeof localWorkspaceSource.spawn>[0]) => {
            used.push('spawn'); return localWorkspaceSource.spawn({ ...request, env: { ...process.env, ...request.env } });
        },
        watchTree: (...args: Parameters<typeof localWorkspaceSource.watchTree>) => {
            used.push('watchTree'); const stop = localWorkspaceSource.watchTree(...args); return () => { released.push('watchTree'); stop(); };
        },
        watchFile: (...args: Parameters<typeof localWorkspaceSource.watchFile>) => {
            used.push('watchFile'); const stop = localWorkspaceSource.watchFile(...args); return () => { released.push('watchFile'); stop(); };
        } };
    const ready = vi.fn();
    const changed = vi.fn();
    const unavailable = vi.fn();
    const dispose = startScmWorkspaceWatch({ source, directory, registry, onReady: ready, onChange: changed, onUnavailable: unavailable });
    cleanup.push(dispose);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(unavailable).not.toHaveBeenCalled();
    expect(used).toEqual(expect.arrayContaining(['realpath', 'spawn', 'watchTree', 'watchFile']));
    await appendFile(join(directory, 'tracked.txt'), 'two');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 10_000 });
    dispose();
    expect(released.filter(kind => kind === 'watchTree').length).toBe(used.filter(kind => kind === 'watchTree').length);
    expect(released.filter(kind => kind === 'watchFile').length).toBe(used.filter(kind => kind === 'watchFile').length);
});


it.skipIf(process.platform !== 'linux')('re-filters each hosted Session when its XDG default ignore file changes', async () => {
    const directories = await Promise.all([fixture(), fixture()]);
    await Promise.all(directories.map((directory, index) => runAddedHostedSession({
        environment: { ...process.env, HOME: join(directory, '..'), USERPROFILE: join(directory, '..'),
            XDG_CONFIG_HOME: join(directory, '..', 'session-xdg'),
            GIT_CONFIG_GLOBAL: join(directory, '..', 'absent-global'), GIT_CONFIG_SYSTEM: join(directory, '..', 'absent-system') },
        workingDirectory: directory, end() {},
    }, async () => {
        const configDirectory = join(directory, '..', 'session-xdg', 'git');
        await mkdir(configDirectory, { recursive: true });
        await mkdir(join(directory, 'excluded'));
        const ready = vi.fn();
        const unavailable = vi.fn();
        const changed = vi.fn();
        const dispose = startScmWorkspaceWatch({ directory, registry, onReady: ready, onUnavailable: unavailable, onChange: changed });
        cleanup.push(dispose);
        await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
        expect(unavailable).not.toHaveBeenCalled();
        expect(boundary.active.has(join(directory, 'excluded'))).toBe(true);
        await writeFile(join(configDirectory, 'ignore'), 'excluded/\n');
        await vi.waitFor(() => expect(boundary.active.has(join(directory, 'excluded')), 'Session ' + index).toBe(false));
        expect(changed).toHaveBeenCalled();
    })));
});
