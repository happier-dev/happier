import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverLocalServiceRunTargets, resolveLocalServiceRunTargetCommand } from './runTargets';
import { buildLocalServiceLauncherSnapshot } from './suggestions';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

async function makeRepo(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-local-services-'));
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('discoverLocalServiceRunTargets', () => {
    it('keeps accepted package presentation on the same contained manager selection as native execution', async () => {
        const parent = await makeRepo();
        const root = join(parent, 'accepted');
        try {
            await writeJson(join(parent, 'package.json'), { packageManager: 'bun@1.2.8' });
            await mkdir(root);
            await writeJson(join(root, 'package.json'), { name: 'accepted', scripts: { dev: 'vite' } });
            const targets = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [{
                id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project',
            }] });
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(buildLocalServiceLauncherSnapshot({
                machineId: 'machine', updatedAt: 1, runTargets: targets, inventoryEntries: [], previewResources: [],
            }));
            expect(snapshot.targets[0]?.commandPreview).toBe('npm run dev');
        } finally { await rm(parent, { recursive: true, force: true }); }
    });
    it('projects valid long Service and package names without rejecting their source identities', async () => {
        const root = await makeRepo();
        try {
            const name = 'service-name-'.repeat(30);
            await mkdir(join(root, '.happier'));
            await writeJson(join(root, '.happier', 'project.json'), { version: 1, services: { [name]: { source: { kind: 'command', command: 'echo service' } } } });
            await writeJson(join(root, 'package.json'), { name, scripts: { dev: 'vite' } });
            const targets = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [{
                id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project',
            }] });
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(buildLocalServiceLauncherSnapshot({
                machineId: 'machine', updatedAt: 1, runTargets: targets, inventoryEntries: [], previewResources: [],
            }));
            expect(snapshot.targets).toHaveLength(2);
            const target = snapshot.targets.find(candidate => candidate.declaration?.selection.kind === 'manifest')!;
            expect(target.declaration?.selection).toEqual({ kind: 'manifest', name });
            expect(name.startsWith(target.title.replace(/…$/u, ''))).toBe(true);
            const packageTarget = snapshot.targets.find(candidate => candidate.source === 'package_script')!;
            expect(packageTarget.sourceClass).toMatchObject({ kind: 'package_script', packageName: name, scriptName: 'dev' });
            expect(packageTarget.declaration?.selection).toEqual({ kind: 'native',
                source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('qualifies nested accepted package declarations with their real Workspace address and leaves unrelated roots inert', async () => {
        const root = await makeRepo();
        const unrelated = await makeRepo();
        try {
            await writeJson(join(root, 'package.json'), { name: 'accepted-root', scripts: { dev: 'vite' } });
            await mkdir(join(root, 'web'));
            await writeJson(join(root, 'web', 'package.json'), { name: 'accepted-web', scripts: { start: 'next start' } });
            await writeJson(join(unrelated, 'package.json'), { name: 'unqualified', scripts: { dev: 'vite' } });
            const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project' };
            const targets = await discoverLocalServiceRunTargets({ roots: [root, unrelated], acceptedWorkspaceRefs: [workspace] });
            const qualified = targets.filter(target => 'declaration' in target);
            expect(qualified).toHaveLength(2);
            expect(qualified).toEqual(expect.arrayContaining([
                expect.objectContaining({ cwd: root, workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                    declaration: { workspaceRefId: 'accepted', selection: { kind: 'native', source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } } } }),
                expect.objectContaining({ cwd: join(root, 'web'), workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                    declaration: { workspaceRefId: 'accepted', selection: { kind: 'native', source: { kind: 'native', tool: 'package_script', file: 'web/package.json', target: 'start' } } } }),
            ]));
            expect(targets.filter(target => !('declaration' in target))).toMatchObject([{ id: 'unqualified:dev', cwd: unrelated }]);
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(buildLocalServiceLauncherSnapshot({
                machineId: 'machine', updatedAt: 1, runTargets: targets, inventoryEntries: [], previewResources: [],
            }));
            expect(snapshot.targets.filter(target => target.declaration)).toEqual(expect.arrayContaining([
                expect.objectContaining({ source: 'package_script', cwd: join(root, 'web'),
                    sourceClass: expect.objectContaining({ kind: 'package_script', packageName: 'accepted-web', scriptName: 'start' }),
                    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                }),
            ]));
        } finally { await Promise.all([root, unrelated].map(directory => rm(directory, { recursive: true, force: true }))); }
    });
    it('does not offer package files that escape their root through a symlink', async () => {
        const root = await makeRepo();
        const outside = await makeRepo();
        try {
            await writeJson(join(outside, 'package.json'), { name: 'outside', scripts: { dev: 'echo private' } });
            await symlink(join(outside, 'package.json'), join(root, 'package.json'));
            expect(await discoverLocalServiceRunTargets({ roots: [root] })).toEqual([]);
            expect(await resolveLocalServiceRunTargetCommand({ cwd: root, runTargetId: 'outside:dev' })).toBeNull();
        } finally {
            await Promise.all([root, outside].map((directory) => rm(directory, { recursive: true, force: true })));
        }
    });
    it('honors an inherited packageManager declaration over a conflicting lockfile', async () => {
        const root = await makeRepo();
        try {
            await writeJson(join(root, 'package.json'), { name: 'root', packageManager: 'bun@1.2.8' });
            await writeFile(join(root, 'yarn.lock'), '');
            const cwd = join(root, 'web');
            await mkdir(cwd);
            await writeJson(join(cwd, 'package.json'), { name: 'web', scripts: { dev: 'vite' } });
            const targets = await discoverLocalServiceRunTargets({ roots: [root] });
            expect(targets[0]?.packageManager).toBe('bun');
            expect(await resolveLocalServiceRunTargetCommand({ cwd, runTargetId: targets[0]!.id })).toBe('bun run dev');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it('uses the same nearest lockfile manager for discovery and shell execution', async () => {
        const root = await makeRepo();
        await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
        const cwd = join(root, 'web');
        await mkdir(cwd);
        await writeFile(join(cwd, 'package-lock.json'), '{}');
        await writeJson(join(cwd, 'package.json'), { name: 'web;echo injected', scripts: { dev: 'vite' } });
        const targets = await discoverLocalServiceRunTargets({ roots: [root] });
        expect(targets[0]?.packageManager).toBe('npm');
        expect(await resolveLocalServiceRunTargetCommand({ cwd, runTargetId: targets[0]!.id })).toBe('npm run dev');
        expect(await resolveLocalServiceRunTargetCommand({ cwd, runTargetId: 'web;echo injected:dev & malicious' })).toBeNull();
    });
    it('discovers server-oriented package scripts across workspace folders', async () => {
        const root = await makeRepo();
        await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
        await writeJson(join(root, 'package.json'), {
            name: 'repo-root',
            scripts: {
                build: 'tsc -b',
                dev: 'vite --host 0.0.0.0',
                test: 'vitest',
            },
        });
        await mkdir(join(root, 'apps', 'web'), { recursive: true });
        await writeJson(join(root, 'apps', 'web', 'package.json'), {
            name: '@acme/web',
            scripts: {
                start: 'next start',
                preview: 'vite preview',
            },
        });

        const targets = await discoverLocalServiceRunTargets({ roots: [root] });

        expect(targets.map((target) => ({
            id: target.id,
            cwd: target.cwd,
            packageManager: target.packageManager,
            scriptName: target.scriptName,
            command: target.command,
        }))).toEqual([
            {
                id: 'repo-root:dev',
                cwd: root,
                packageManager: 'pnpm',
                scriptName: 'dev',
                command: 'vite --host 0.0.0.0',
            },
            {
                id: '@acme/web:preview',
                cwd: join(root, 'apps', 'web'),
                packageManager: 'pnpm',
                scriptName: 'preview',
                command: 'vite preview',
            },
            {
                id: '@acme/web:start',
                cwd: join(root, 'apps', 'web'),
                packageManager: 'pnpm',
                scriptName: 'start',
                command: 'next start',
            },
        ]);
    });

    it('skips dependency folders and returns launch intent without resolving a system package-manager binary', async () => {
        const root = await makeRepo();
        await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
        await writeJson(join(root, 'package.json'), {
            name: 'repo-root',
            scripts: {
                lint: 'eslint .',
                serve: 'astro dev',
            },
        });
        await writeJson(join(root, 'node_modules', 'ignored', 'package.json'), {
            name: 'ignored',
            scripts: { dev: 'vite' },
        });

        const targets = await discoverLocalServiceRunTargets({ roots: [root] });

        expect(targets).toHaveLength(1);
        expect(targets[0]?.launchIntent).toEqual({
            kind: 'packageScript',
            packageManager: 'npm',
            cwd: root,
            scriptName: 'serve',
        });
        expect('executablePath' in (targets[0]?.launchIntent ?? {})).toBe(false);
    });

    it('keeps package-script target ids unique when sibling workspaces share a package name', async () => {
        const root = await makeRepo();
        await mkdir(join(root, 'apps', 'web'), { recursive: true });
        await mkdir(join(root, 'examples', 'web'), { recursive: true });
        for (const directory of [join(root, 'apps', 'web'), join(root, 'examples', 'web')]) {
            await writeJson(join(directory, 'package.json'), {
                name: 'web',
                scripts: {
                    dev: 'vite',
                },
            });
        }

        const targets = await discoverLocalServiceRunTargets({ roots: [root] });

        expect(targets).toHaveLength(2);
        expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);
        expect(new Set(targets.map((target) => target.cwd))).toEqual(new Set([
            join(root, 'apps', 'web'),
            join(root, 'examples', 'web'),
        ]));
    });

    it('skips malformed package manifests without failing the whole discovery pass', async () => {
        const root = await makeRepo();
        await mkdir(join(root, 'broken'), { recursive: true });
        await writeJson(join(root, 'package.json'), {
            name: 'repo-root',
            scripts: {
                dev: 'vite',
            },
        });
        await writeFile(join(root, 'broken', 'package.json'), '{ this is not json', 'utf8');

        await expect(discoverLocalServiceRunTargets({ roots: [root] })).resolves.toHaveLength(1);
    });

    it('discovers scripts beyond the former directory cutoff and in subsequent roots', async () => {
        const root = await makeRepo();
        const secondRoot = await makeRepo();
        try {
            for (let index = 0; index < 5_001; index += 1) {
                await mkdir(join(root, `folder-${String(index).padStart(5, '0')}`));
            }
            await writeJson(join(root, 'folder-05000', 'package.json'), { name: 'late', scripts: { dev: 'vite' } });
            await writeJson(join(secondRoot, 'package.json'), { name: 'second', scripts: { dev: 'vite' } });
            const targets = await discoverLocalServiceRunTargets({ roots: [root, secondRoot] });
            expect(targets.map((target) => target.id)).toEqual(['late:dev', 'second:dev']);
        } finally {
            await Promise.all([root, secondRoot].map((directory) => rm(directory, { recursive: true, force: true })));
        }
    });
});
