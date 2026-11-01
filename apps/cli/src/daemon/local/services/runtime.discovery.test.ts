import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';

import { createLocalServicesDaemonRuntime } from './runtime';

const observations = vi.hoisted(() => ({ directories: [] as string[], attachments: new Set<string>(), starts: [] as string[], events: [] as string[],
    failedWatchPath: undefined as string | undefined,
    heldRead: undefined as Readonly<{ path: string; entered(): void; resume: Promise<void> }> | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
        const result = await actual.readFile(...args);
        const held = observations.heldRead;
        if (held && String(args[0]) === held.path) {
            observations.heldRead = undefined;
            held.entered();
            await held.resume;
        }
        return result;
    }, readdir: (...args: Parameters<typeof actual.readdir>) => {
        observations.directories.push(String(args[0]));
        return actual.readdir(...args);
    } };
});
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
        if (String(args[0]) === observations.failedWatchPath) throw Object.assign(new Error(`Watch descriptors unavailable: ${String(args[0])}`),
            { code: 'EMFILE', errno: -24, syscall: 'watch', path: String(args[0]) });
        const watcher = actual.watch(...args);
        const path = String(args[0]);
        observations.attachments.add(path);
        observations.starts.push(path);
        watcher.on('change', (_kind, filename) => observations.events.push(String(filename)));
        watcher.on('close', () => observations.attachments.delete(path));
        return watcher;
    } };
});

function scripts(snapshot: LocalServiceLauncherSnapshotV1) {
    return snapshot.targets.map(target => target.sourceClass?.kind === 'package_script'
        ? `${target.sourceClass.packageName}:${target.sourceClass.scriptName}` : target.id);
}

describe('Services declaration discovery demand', () => {
    it('reads only the requested root, admits changes immediately, and retains sibling observations', async () => {
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-discovery-')));
        const selected = join(directory, 'selected');
        const sibling = join(directory, 'sibling');
        for (const [root, name] of [[selected, 'selected'], [sibling, 'sibling']] as const) {
            await mkdir(join(root, 'child'), { recursive: true });
            await writeFile(join(root, 'package.json'), JSON.stringify({ name, packageManager: 'npm@10', scripts: { dev: 'serve' } }));
        }
        let failSource = false;
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false,
            inventoryEnabled: () => true, now: () => 1_000,
            workspaceFacts: () => {
                if (failSource) throw new Error('Workspace transport unavailable');
                return [{ id: 'selected', path: selected }, { id: 'sibling', path: sibling }];
            },
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        try {
            observations.directories.length = 0;
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: selected }))).toEqual(['selected:dev']);
            expect.soft(observations.directories.filter(path => path === sibling || path.startsWith(`${sibling}/`))).toHaveLength(0);
            observations.directories.length = 0;
            expect((await runtime.launcherRoutes.getSnapshot({ workspaceRoot: join(directory, 'unadmitted') })).targets).toEqual([]);
            expect(observations.directories).toHaveLength(0);
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: sibling });
            failSource = true;
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: selected }))).toEqual(['selected:dev']);
            failSource = false;
            await writeFile(join(selected, 'package.json'), JSON.stringify({ name: 'selected', packageManager: 'npm@10', scripts: { preview: 'serve' } }));
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: selected }))).toEqual(['selected:preview']);
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: selected, discovery: 'cached' }))).toEqual(['selected:preview']);
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: sibling, discovery: 'cached' }))).toEqual(['sibling:dev']);
            // Package scripts are Workspace suggestions; Machine Services does not surface them.
            expect((await runtime.launcherRoutes.getSnapshot({ scope: 'machine', discovery: 'cached' })).targets).toEqual([]);
            await writeFile(join(selected, 'package.json'), JSON.stringify({ name: 'selected', packageManager: 'npm@10', scripts: {} }));
            await Promise.all([runtime.launcherRoutes.getSnapshot({ workspaceRoot: selected }), runtime.launcherRoutes.getSnapshot({ workspaceRoot: sibling })]);
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: selected, discovery: 'cached' }))).toEqual([]);
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: sibling, discovery: 'cached' }))).toEqual(['sibling:dev']);
        } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
    });

    it('keeps accepted nested-package identities across scoped reads without traversing siblings', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-qualified-scope-')));
        const selected = join(root, 'web');
        const sibling = join(root, 'other');
        for (const [directory, name] of [[selected, 'web'], [sibling, 'other']] as const) {
            await mkdir(directory);
            await writeFile(join(directory, 'package.json'), JSON.stringify({ name, packageManager: 'npm@10', scripts: { dev: 'serve' } }));
        }
        const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => ({ facts: [{ id: workspace.id, path: root }], acceptedWorkspaceRefs: [workspace], diagnostics: [] }),
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        try {
            const workspaceSnapshot = await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            const before = workspaceSnapshot.targets.find(target => target.cwd === selected);
            expect(before?.declaration?.workspaceRefId).toBe(workspace.id);
            observations.directories.length = 0;
            const scoped = await runtime.launcherRoutes.getSnapshot({ workspaceRoot: selected });
            expect(scoped.targets).toHaveLength(1);
            expect(scoped.targets[0]).toMatchObject({ id: before!.id, declaration: before!.declaration });
            expect(observations.directories.filter(directory => directory === root || directory === sibling || directory.startsWith(`${sibling}/`))).toHaveLength(0);
        } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
    });

    it('watches declarations only for mounted demand and ignores unrelated file changes', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-watch-')));
        await mkdir(join(root, 'node_modules', 'dependency'), { recursive: true });
        await writeFile(join(root, 'README.md'), 'initial');
        await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'watched', packageManager: 'npm@10', scripts: { dev: 'serve' } }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false,
            inventoryEnabled: () => true, workspaceFacts: () => [{ id: 'workspace', path: root }],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const cancellation = new AbortController();
        const otherCancellation = new AbortController();
        let watch: Promise<unknown> | undefined;
        let otherWatch: Promise<unknown> | undefined;
        try {
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            expect(observations.attachments.has(root)).toBe(false);
            const readsBeforeMount = observations.directories.filter(path => path === root).length;
            const cursor = runtime.inventoryRegistry.getSnapshot().generatedAt;
            watch = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: cursor, signal: cancellation.signal });
            await vi.waitFor(() => expect(observations.attachments.has(root)).toBe(true));
            await vi.waitFor(() => expect(observations.directories.filter(path => path === root).length).toBeGreaterThan(readsBeforeMount));
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            expect([...observations.attachments].filter(path => path.startsWith(join(root, 'node_modules')))).toHaveLength(0);
            otherWatch = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: cursor, signal: otherCancellation.signal });
            await vi.waitFor(() => expect(runtime.inventoryRoutes.watcherCount()).toBe(2));
            cancellation.abort();
            await expect(watch).resolves.toMatchObject({ changed: false });
            expect(observations.attachments.has(root)).toBe(true);
            observations.directories.length = 0;
            observations.events.length = 0;
            await writeFile(join(root, 'README.md'), 'unrelated');
            await vi.waitFor(() => expect(observations.events).toContain('README.md'));
            expect(observations.directories).toHaveLength(0);
            observations.events.length = 0;
            await rm(join(root, 'README.md'));
            await vi.waitFor(() => expect(observations.events).toContain('README.md'));
            expect(observations.directories).toHaveLength(0);
            await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'watched', packageManager: 'npm@10', scripts: { preview: 'serve' } }));
            await expect(otherWatch).resolves.toMatchObject({ changed: true });
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))).toEqual(['watched:preview']);
            await vi.waitFor(() => expect(observations.attachments.has(root)).toBe(false));
            observations.directories.length = 0;
            await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'watched', packageManager: 'npm@10', scripts: { start: 'serve' } }));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(observations.directories).toHaveLength(0);
            // A new mounted watch reconciles the detached interval before it parks.
            watch = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt,
                signal: otherCancellation.signal });
            await expect(watch).resolves.toMatchObject({ changed: true });
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))).toEqual(['watched:start']);
        } finally { cancellation.abort(); otherCancellation.abort(); await Promise.all([watch, otherWatch]); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
    });

    it('shares a canonical attachment across logical aliases and admits every alias before publishing', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-alias-')));
        const root = join(base, 'actual');
        const alias = join(base, 'alias');
        await mkdir(join(root, '.happier'), { recursive: true });
        const manifest = join(root, '.happier', 'project.json');
        await writeFile(manifest, JSON.stringify({ version: 1, services: { worker: { source: { kind: 'command', command: 'worker' } } } }));
        await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        const refs = [root, alias].map((rootPath, index) => ({ id: `workspace-${index}`, serverId: 'home', machineId: 'machine', rootPath, createdAtMs: 1 }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => ({ facts: refs.map(ref => ({ id: ref.id, path: ref.rootPath })), acceptedWorkspaceRefs: refs, diagnostics: [] }),
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const cancellation = new AbortController();
        let watch: Promise<unknown> | undefined;
        try {
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: alias });
            const readsBeforeMount = observations.directories.filter(path => path === root).length;
            observations.starts.length = 0;
            watch = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt, signal: cancellation.signal });
            await vi.waitFor(() => expect(observations.attachments.has(join(root, '.happier'))).toBe(true));
            await vi.waitFor(() => expect(observations.directories.filter(path => path === root).length).toBeGreaterThan(readsBeforeMount));
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            expect(observations.starts.filter(path => path === root)).toHaveLength(1);
            expect(observations.starts.filter(path => path === alias)).toHaveLength(0);
            await writeFile(manifest, JSON.stringify({ version: 1, services: { jobs: { source: { kind: 'command', command: 'jobs' } } } }));
            await expect(watch).resolves.toMatchObject({ changed: true });
            for (const workspaceRoot of [root, alias]) {
                const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(await runtime.launcherRoutes.getSnapshot({ workspaceRoot, discovery: 'cached' }));
                expect(snapshot.targets.map(target => target.declaration?.selection)).toEqual([{ kind: 'manifest', name: 'jobs' }]);
            }
        } finally { cancellation.abort(); await watch; await runtime.stop(); await rm(base, { recursive: true, force: true }); }
    });

    it('observes contained declaration symlink targets and replacement without reading unrelated targets', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-definition-alias-')));
        const hidden = join(root, 'node_modules', 'templates');
        await mkdir(hidden, { recursive: true });
        const target = join(hidden, 'source.json');
        const replacementTarget = join(hidden, 'replacement.json');
        const packageFile = join(root, 'package.json');
        const writeScript = (file: string, name: string) => writeFile(file, JSON.stringify({ name: 'alias', packageManager: 'npm@10', scripts: { [name]: 'serve' } }));
        await writeScript(target, 'dev');
        await symlink(target, packageFile);
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => [{ id: 'workspace', path: root }],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const cancellation = new AbortController();
        let pending: Promise<unknown> | undefined;
        const mount = () => runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt, signal: cancellation.signal });
        try {
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            const readsBeforeMount = observations.directories.filter(path => path === root).length;
            pending = mount();
            await vi.waitFor(() => expect(observations.attachments.has(packageFile)).toBe(true));
            await vi.waitFor(() => expect(observations.directories.filter(path => path === root).length).toBeGreaterThan(readsBeforeMount));
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            observations.directories.length = 0;
            await writeScript(join(hidden, 'unrelated.json'), 'start');
            expect(observations.directories).toHaveLength(0);
            await writeScript(target, 'preview');
            await expect(pending).resolves.toMatchObject({ changed: true });
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))).toEqual(['alias:preview']);
            pending = mount();
            await vi.waitFor(() => expect(observations.attachments.has(packageFile)).toBe(true));
            await writeScript(replacementTarget, 'start');
            const replacement = join(root, 'replacement');
            await symlink(replacementTarget, replacement);
            await rename(replacement, packageFile);
            await expect(pending).resolves.toMatchObject({ changed: true });
            pending = mount();
            await vi.waitFor(() => expect(observations.attachments.has(packageFile)).toBe(true));
            await writeScript(replacementTarget, 'serve');
            await expect(pending).resolves.toMatchObject({ changed: true });
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))).toEqual(['alias:serve']);
        } finally { cancellation.abort(); await pending; await runtime.stop(); await rm(root, { recursive: true, force: true }); }
    });

    it('retires a held declaration read with the last viewer and permits a later fresh scoped read', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-retirement-')));
        const packageFile = join(root, 'package.json');
        const writeScript = (script: string) => writeFile(packageFile, JSON.stringify({ name: 'retirement', packageManager: 'npm@10', scripts: { [script]: 'serve' } }));
        await writeScript('dev');
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => [{ id: 'workspace', path: root }],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const cancellation = new AbortController();
        let watch: Promise<unknown> | undefined;
        let release!: () => void;
        let entered!: () => void;
        let freshRead: Promise<LocalServiceLauncherSnapshotV1> | undefined;
        const resumed = new Promise<void>(resolve => { release = resolve; });
        const held = new Promise<void>(resolve => { entered = resolve; });
        let publications = 0;
        const unsubscribe = runtime.inventoryRegistry.subscribe(() => { publications++; });
        try {
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            const readsBeforeMount = observations.directories.filter(path => path === root).length;
            watch = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt, signal: cancellation.signal });
            await vi.waitFor(() => expect(observations.attachments.has(root)).toBe(true));
            await vi.waitFor(() => expect(observations.directories.filter(path => path === root).length).toBeGreaterThan(readsBeforeMount));
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            publications = 0;
            observations.heldRead = { path: packageFile, entered, resume: resumed };
            await writeScript('preview');
            await held;
            cancellation.abort();
            await expect(watch).resolves.toMatchObject({ changed: false });
            await writeScript('start');
            expect(publications).toBe(0);
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))).toEqual(['retirement:dev']);
            // The retired filesystem read remains held: a new viewer must be
            // able to obtain fresh data without waiting for that old demand.
            let fresh: LocalServiceLauncherSnapshotV1 | undefined;
            freshRead = runtime.launcherRoutes.getSnapshot({ workspaceRoot: root }).then(snapshot => { fresh = snapshot; return snapshot; });
            await vi.waitFor(() => expect(fresh && scripts(fresh)).toEqual(['retirement:start']));
            release();
        } finally {
            observations.heldRead = undefined;
            release(); cancellation.abort(); await Promise.all([watch, freshRead]); unsubscribe(); await runtime.stop(); await rm(root, { recursive: true, force: true });
        }
    });

    it('observes existing declarations beside a missing workspace ancestry and recovers its creation from events', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-missing-root-')));
        const root = join(base, 'existing');
        const missing = join(base, 'removed', 'nested', 'workspace');
        await mkdir(root);
        await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'existing', packageManager: 'npm@10', scripts: { dev: 'serve' } }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => [{ path: root }, { path: missing }],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const cancellation = new AbortController();
        let pending: Promise<unknown> | undefined;
        try {
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            pending = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt,
                signal: cancellation.signal });
            await vi.waitFor(() => expect(observations.attachments.has(root)
                || runtime.inventoryRegistry.getSnapshot().diagnostics.length > 0).toBe(true));
            expect(runtime.inventoryRegistry.getSnapshot().diagnostics).toEqual([]);
            expect(observations.attachments.has(root)).toBe(true);
            await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'existing', packageManager: 'npm@10', scripts: { preview: 'serve' } }));
            await expect(pending).resolves.toMatchObject({ changed: true });
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))).toEqual(['existing:preview']);
            pending = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt,
                signal: cancellation.signal });
            await vi.waitFor(() => expect(observations.attachments.has(root)).toBe(true));
            await mkdir(missing, { recursive: true });
            await writeFile(join(missing, 'package.json'), JSON.stringify({ name: 'restored', packageManager: 'npm@10', scripts: { dev: 'serve' } }));
            await vi.waitFor(async () => expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: missing, discovery: 'cached' })))
                .toEqual(['restored:dev']));
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root, discovery: 'cached' }))).toEqual(['existing:preview']);
            await expect(pending).resolves.toMatchObject({ changed: true });
            expect(runtime.inventoryRegistry.getSnapshot().diagnostics).toEqual([]);
        } finally { cancellation.abort(); await pending; await runtime.stop(); await rm(base, { recursive: true, force: true }); }
    });

    it('surfaces declaration observation loss without invalidating native facts and recovers on a fresh read', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-watch-unavailable-')));
        await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'recovery', packageManager: 'npm@10', scripts: { dev: 'serve' } }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => [{ id: 'workspace', path: root }],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const cancellation = new AbortController();
        let pending: Promise<unknown> | undefined;
        try {
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            const before = runtime.inventoryRegistry.getSnapshot();
            observations.failedWatchPath = root;
            pending = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: before.generatedAt, signal: cancellation.signal });
            await expect(pending).resolves.toMatchObject({ changed: true });
            expect(runtime.inventoryRegistry.getSnapshot()).toMatchObject({ refreshState: before.refreshState, entries: before.entries,
                diagnostics: [expect.objectContaining({ code: 'local_services_declaration_observation_unavailable', severity: 'warning' })] });
            expect(runtime.inventoryRegistry.getSnapshot().diagnostics[0]).toMatchObject({ message: expect.stringContaining('EMFILE') });
            expect(JSON.parse(runtime.inventoryRegistry.getSnapshot().diagnostics[0]!.message!)).toEqual({
                role: 'project_root', root, class: 'Error', code: 'EMFILE', errno: -24, syscall: 'watch',
            });
            await runtime.refreshInventoryNow();
            expect(runtime.inventoryRegistry.getSnapshot().diagnostics).toContainEqual(
                expect.objectContaining({ code: 'local_services_declaration_observation_unavailable', message: expect.stringContaining('EMFILE') }));
            observations.failedWatchPath = undefined;
            expect(scripts(await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root }))).toEqual(['recovery:dev']);
            pending = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt, signal: cancellation.signal });
            // Recovery is a material diagnostic change: it answers the parked
            // watch and releases that demand, rather than leaving an attachment.
            await expect(pending).resolves.toMatchObject({ changed: true });
            expect(runtime.inventoryRegistry.getSnapshot().diagnostics).toEqual([]);
        } finally { observations.failedWatchPath = undefined; cancellation.abort(); await pending; await runtime.stop(); await rm(root, { recursive: true, force: true }); }
    });

    it('reconciles once per unscoped parked-watch renewal without a discovery timer or unchanged publication', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-services-renewal-')));
        await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'renewal', packageManager: 'npm@10', scripts: { dev: 'serve' } }));
        let observedAt = 1_000;
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine', startLoop: false, inventoryEnabled: () => true,
            now: () => observedAt, workspaceFacts: () => [{ id: 'workspace', path: root }],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const cancellation = new AbortController();
        let pending: Promise<unknown> | undefined;
        let publications = 0;
        const unsubscribe = runtime.inventoryRegistry.subscribe(() => { publications++; });
        try {
            await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            observations.directories.length = 0;
            publications = 0;
            // The canonical deadline timer rechecks Date.now after every fire.
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            const renewals = 10 * 60_000 / MACHINE_WATCH_WINDOW_MS;
            for (let index = 0; index < renewals; index++) {
                pending = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt, signal: cancellation.signal });
                await vi.waitFor(() => expect(observations.directories.filter(path => path === root)).toHaveLength(index + 1));
                await vi.advanceTimersByTimeAsync(MACHINE_WATCH_WINDOW_MS);
                await expect(pending).resolves.toMatchObject({ changed: false });
                await vi.waitFor(() => expect(observations.attachments.has(root)).toBe(false));
                observedAt += MACHINE_WATCH_WINDOW_MS;
            }
            expect(observations.directories.filter(path => path === root)).toHaveLength(renewals);
            expect(publications).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally { cancellation.abort(); await pending; unsubscribe(); await runtime.stop(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
    });
});
