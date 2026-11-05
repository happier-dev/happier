import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createLocalServiceDeclarationWatch } from './declarationWatch';

const native = vi.hoisted(() => ({ starts: [] as string[], active: new Set<string>() }));
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
        const watcher = actual.watch(...args);
        const path = String(args[0]);
        native.starts.push(path);
        native.active.add(path);
        watcher.on('close', () => native.active.delete(path));
        return watcher;
    } };
});

describe('Local Service declaration observation scope', () => {
    it('enrolls finite accepted declaration directories without traversing retained Session roots or unrelated project trees', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'happier-declaration-scope-')));
        const retained = join(base, 'home');
        const root = join(base, 'project');
        const unrelated = join(root, 'source', 'deep', 'tree');
        await mkdir(unrelated, { recursive: true });
        await mkdir(join(retained, '.cache', 'tools', 'nested'), { recursive: true });
        await mkdir(join(root, '.happier'), { recursive: true });
        await writeFile(join(root, '.happier', 'project.json'), JSON.stringify({ version: 1 }));
        let observations = 0;
        const errors: unknown[] = [];
        const watcher = createLocalServiceDeclarationWatch({
            readWorkspaceFacts: async () => ({ facts: [{ path: retained }, { path: join(retained, '.cache') }, { path: root }],
                acceptedWorkspaceRefs: [{ id: 'project', serverId: 'server', machineId: 'machine', rootPath: root, createdAtMs: 1 }], diagnostics: [] }),
            onChanged: async () => { observations++; }, onError: error => errors.push(error),
        });
        native.starts.length = 0;
        try {
            watcher.setDemand(true);
            await vi.waitFor(() => expect(observations).toBeGreaterThan(0));
            expect(native.starts.filter(path => path === retained || path.startsWith(`${retained}/`))).toEqual([]);
            expect(native.starts.filter(path => path === join(root, 'source') || path.startsWith(`${root}/source/`))).toEqual([]);
            expect(native.active.has(root)).toBe(true);
            expect(native.active.has(join(root, '.happier'))).toBe(true);
            // One native parent sentinel and the two existing declaration dirs;
            // descriptor cost does not depend on retained or source-tree size.
            expect(new Set(native.starts)).toEqual(new Set([base, root, join(root, '.happier')]));
            expect(native.starts).toHaveLength(3);
            expect(errors).toEqual([]);
        } finally {
            watcher.setDemand(false);
            await vi.waitFor(() => expect(native.active.size).toBe(0));
            await rm(base, { recursive: true, force: true });
        }
    });

    it('treats accepted home, cache and filesystem roots as finite declarations rather than recursive package demand', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'happier-declaration-broad-roots-')));
        const home = join(base, 'home');
        const cache = join(home, '.cache');
        const unrelated = join(cache, 'tools', 'nested');
        await mkdir(unrelated, { recursive: true });
        let observations = 0;
        const errors: unknown[] = [];
        const roots = [parse(base).root, home, cache];
        const watcher = createLocalServiceDeclarationWatch({
            readWorkspaceFacts: async () => ({ facts: roots.map(path => ({ path })), acceptedWorkspaceRefs: roots.map((rootPath, index) => ({
                id: `project-${index}`, serverId: 'server', machineId: 'machine', rootPath, createdAtMs: 1,
            })), diagnostics: [] }),
            onChanged: async () => { observations++; }, onError: error => errors.push(error),
        });
        native.starts.length = 0;
        try {
            watcher.setDemand(true);
            await vi.waitFor(() => expect(observations).toBeGreaterThan(0));
            expect(native.active.has(home)).toBe(true);
            expect(native.active.has(cache)).toBe(true);
            expect(native.starts.filter(path => path === join(cache, 'tools') || path.startsWith(`${cache}/tools/`))).toEqual([]);
            expect(errors).toEqual([]);
        } finally {
            watcher.setDemand(false);
            await vi.waitFor(() => expect(native.active.size).toBe(0));
            await rm(base, { recursive: true, force: true });
        }
    });

    it('observes new declaration ancestry and content without admitting sibling trees', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-declaration-creation-')));
        let observations = 0;
        const errors: unknown[] = [];
        const watcher = createLocalServiceDeclarationWatch({
            readWorkspaceFacts: async () => ({ facts: [], acceptedWorkspaceRefs: [{ id: 'project', serverId: 'server',
                machineId: 'machine', rootPath: root, createdAtMs: 1 }], diagnostics: [] }),
            onChanged: async (_roots, _signal, options) => {
                expect(options).toEqual({ includePackageScripts: false });
                observations++;
            }, onError: error => errors.push(error),
        });
        try {
            watcher.setDemand(true);
            await vi.waitFor(() => expect(observations).toBeGreaterThan(0));
            await mkdir(join(root, '.flox', 'env'), { recursive: true });
            await vi.waitFor(() => expect(native.active.has(join(root, '.flox', 'env'))).toBe(true));
            const before = observations;
            await writeFile(join(root, '.flox', 'env', 'manifest.toml'), '[services.worker]\ncommand = "worker"\n');
            await vi.waitFor(() => expect(observations).toBeGreaterThan(before));
            const afterCreation = observations;
            await writeFile(join(root, '.flox', 'env', 'manifest.toml'), '[services.worker]\ncommand = "jobs"\n');
            await vi.waitFor(() => expect(observations).toBeGreaterThan(afterCreation));
            await mkdir(join(root, 'unrelated', 'nested'), { recursive: true });
            expect(native.active.has(join(root, 'unrelated'))).toBe(false);
            expect(errors).toEqual([]);
        } finally {
            watcher.setDemand(false);
            await vi.waitFor(() => expect(native.active.size).toBe(0));
            await rm(root, { recursive: true, force: true });
        }
    });

    it('recursively observes only explicitly requested package scopes, including new nested packages and reconnects', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-declaration-package-scope-')));
        const selected = join(root, 'selected');
        const sibling = join(root, 'sibling');
        await mkdir(join(selected, 'packages'), { recursive: true });
        await mkdir(join(sibling, 'deep'), { recursive: true });
        const changes: (readonly string[] | undefined)[] = [];
        const watcher = createLocalServiceDeclarationWatch({
            readWorkspaceFacts: async () => ({ facts: [{ path: root }], acceptedWorkspaceRefs: [{ id: 'selected',
                serverId: 'server', machineId: 'machine', rootPath: selected, createdAtMs: 1 }], diagnostics: [] }),
            onChanged: async (roots, _signal, options) => { if (options?.includePackageScripts) changes.push(roots); },
            onError: error => { throw error; },
        });
        watcher.updatePackageRoots([selected]);
        native.starts.length = 0;
        try {
            watcher.setDemand(true);
            await vi.waitFor(() => expect(native.active.has(join(selected, 'packages'))).toBe(true));
            expect(native.starts.filter(path => path === sibling || path.startsWith(`${sibling}/`))).toEqual([]);
            expect(changes).not.toContain(undefined);
            const nested = join(selected, 'packages', 'new');
            await mkdir(nested);
            await vi.waitFor(() => expect(native.active.has(nested)).toBe(true));
            changes.length = 0;
            await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'new', scripts: { dev: 'serve' } }));
            await vi.waitFor(() => expect(changes).toContainEqual([selected]));
            watcher.setDemand(false);
            await vi.waitFor(() => expect(native.active.size).toBe(0));
            watcher.setDemand(true);
            await vi.waitFor(() => expect(native.active.has(nested)).toBe(true));
        } finally {
            watcher.setDemand(false);
            await vi.waitFor(() => expect(native.active.size).toBe(0));
            await rm(root, { recursive: true, force: true });
        }
    });
});
