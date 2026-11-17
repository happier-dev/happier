import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as filesystem from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { discoverLocalServiceRunTargets, resolveLocalServiceRunTargetCommand } from './runTargets';
import { buildLocalServiceLauncherSnapshot } from './suggestions';
import { matchWorkspaceAssociation } from '../inventory/provenance';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

async function makeRepo(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-local-services-'));
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('discoverLocalServiceRunTargets', () => {
    it('retains opted-in roots without service declarations and removes an explicit opt-out on refresh', async () => {
        const root = await makeRepo();
        try {
            await mkdir(join(root, '.happier'));
            const manifestPath = join(root, '.happier/project.json');
            await writeJson(manifestPath, { version: 1, worktreePorts: { enabled: true, slots: 2 } });
            const workspace = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
            const input = { roots: [root], acceptedWorkspaceRefs: [workspace], includePackageScripts: false };
            const enabled = await discoverLocalServiceRunTargets(input);
            expect(enabled.targets).toEqual([]);
            expect(enabled).toMatchObject({ worktreePortDefinitions: [{ rootPath: root, slots: 2 }] });
            await writeJson(manifestPath, { version: 1, worktreePorts: { enabled: false } });
            expect((await discoverLocalServiceRunTargets(input)).worktreePortDefinitions).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('reads each package tree once, retaining declared Workspace services and one implicit script per physical package', async () => {
        const root = await makeRepo();
        const reads = vi.spyOn(filesystem, 'readdir'); // Observe the real filesystem boundary; internal discovery stays real.
        try {
            await writeJson(join(root, 'package.json'), { name: 'web', scripts: { dev: 'vite' } });
            await writeFile(join(root, 'Procfile'), 'api: node api.js\n');
            const refs = Array.from({ length: 16 }, (_, index) => ({
                id: `workspace-${index}`, serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1,
            }));
            const input = { roots: Array.from({ length: 32 }, () => root), acceptedWorkspaceRefs: refs };
            const targets = (await discoverLocalServiceRunTargets(input)).targets;
            expect(reads.mock.calls.filter(([directory]) => directory === root)).toHaveLength(1);
            for (const workspace of refs) {
                expect(targets.filter(target => 'workspaceId' in target && target.workspaceId === workspace.id)
                    .map(target => 'title' in target ? target.title : target.id).sort())
                    .toEqual(workspace === refs[0] ? ['api', 'web:dev'] : ['api']);
            }

            reads.mockClear();
            await writeFile(join(root, 'Procfile'), 'api: node api.js\nworker: node worker.js\n');
            await mkdir(join(root, 'nested'));
            await writeJson(join(root, 'nested', 'package.json'), { name: 'nested', scripts: { start: 'node server.js' } });
            const changed = (await discoverLocalServiceRunTargets({ ...input, roots: [...input.roots, join(root, 'nested')] })).targets;
            expect(reads.mock.calls.filter(([directory]) => directory === root)).toHaveLength(1);
            expect(reads.mock.calls.filter(([directory]) => directory === join(root, 'nested'))).toHaveLength(1);
            for (const workspace of refs) {
                expect(changed.filter(target => 'workspaceId' in target && target.workspaceId === workspace.id)
                    .map(target => 'title' in target ? target.title : target.id).sort())
                    .toEqual(workspace === refs[0] ? ['api', 'nested:start', 'web:dev', 'worker'] : ['api', 'worker']);
            }
        } finally {
            reads.mockRestore();
            await rm(root, { recursive: true, force: true });
        }
    });
    it('keeps the manifest authority for a same-name native service in each accepted checkout', async () => {
        const root = await makeRepo();
        try {
            await mkdir(join(root, '.happier'));
            await writeJson(join(root, '.happier/project.json'), { version: 1, services: {
                db: { source: { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'db' } },
                web: { source: { kind: 'command', command: 'node server.js' }, port: 5173 },
            } });
            await writeFile(join(root, 'compose.yaml'), 'services:\n  db:\n    image: postgres\n  cache:\n    image: redis\n');
            await writeFile(join(root, 'Procfile'), 'web: node server.js\n');
            const refs = ['one', 'two'].map(id => ({ id, serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 }));
            const targets = (await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: refs })).targets;
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(buildLocalServiceLauncherSnapshot({
                machineId: 'machine', updatedAt: 1, runTargets: targets, inventoryEntries: [], previewResources: [],
            }));
            for (const ref of refs) {
                const declarations = snapshot.targets.filter(target => target.workspaceId === ref.id);
                expect(declarations.map(target => target.title).sort()).toEqual(['cache', 'db', 'web']);
                expect(declarations.find(target => target.title === 'db')?.declaration?.selection).toEqual({ kind: 'manifest', name: 'db' });
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('projects one declaration per native source even when its manifest name differs from the detected target', async () => {
        const root = await makeRepo();
        try {
            await mkdir(join(root, '.happier'));
            await writeJson(join(root, 'package.json'), { name: 'storefront', scripts: { dev: 'python3 -m http.server 5173', preview: 'vite preview' } });
            await writeJson(join(root, '.happier/project.json'), { version: 1, services: {
                web: { source: { kind: 'native', tool: 'package_script', file: '.\\package.json', target: 'dev' }, port: 5173 },
                database: { source: { kind: 'native', tool: 'compose', file: './compose.yaml', target: 'db' } },
            } });
            await writeFile(join(root, 'compose.yaml'), 'services:\n  db:\n    image: postgres\n  cache:\n    image: redis\n');
            const refs = ['one', 'two'].map(id => ({ id, serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 }));
            const targets = (await discoverLocalServiceRunTargets({ roots: [root], acceptedWorkspaceRefs: refs })).targets;
            const machineTargets = (await discoverLocalServiceRunTargets({ roots: [root], acceptedWorkspaceRefs: refs,
                includePackageScripts: false })).targets;
            for (const ref of refs) {
                expect(targets.filter(target => 'workspaceId' in target && target.workspaceId === ref.id)
                    .map(target => 'title' in target ? target.title : target.id).sort())
                    .toEqual(ref === refs[0] ? ['cache', 'database', 'storefront:preview', 'web'] : ['cache', 'database', 'web']);
                expect(machineTargets.filter(target => 'workspaceId' in target && target.workspaceId === ref.id)
                    .map(target => 'title' in target ? target.title : target.id).sort())
                    .toEqual(['cache', 'database', 'web']);
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('names detected listeners from one matching declaration in their own accepted checkout without granting managed custody', async () => {
        const root = await makeRepo();
        try {
            await mkdir(join(root, '.happier'));
            await writeJson(join(root, '.happier/project.json'), { version: 1, services: {
                api: { source: { kind: 'command', command: 'node api.js' }, port: 3005 },
                commandOnly: { source: { kind: 'command', command: 'node web.js' } },
                duplicateA: { source: { kind: 'command', command: 'node a.js' }, port: 6006 },
                duplicateB: { source: { kind: 'command', command: 'node b.js' }, port: 6006 },
            } });
            const runTargets = (await discoverLocalServiceRunTargets({ roots: [root], acceptedWorkspaceRefs: [{
                id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1,
            }] })).targets;
            const entry = (id: string, port: number, cwd: string, command: string) => ({
                id, machineId: 'machine', address: { kind: 'wildcard' as const, host: '::', family: 'ipv6' as const },
                port, protocol: 'tcp' as const, detectedAt: 1, lastSeenAt: 1, state: 'listening' as const,
                source: 'detected' as const, labels: [], confidence: 'high' as const,
                // The scanner recognizes this server child through its npm-dev ancestor.
                classification: { kind: 'npm-dev', signals: ['npm run dev'] },
                processOwnershipConfidence: 'medium' as const, workspaceAssociationConfidence: 'high' as const,
                diagnostics: [], presentation: { addressLabel: `localhost:${port}`, displayName: 'node' },
                provenance: { process: { pid: port, lineagePids: [port], command, cwd, redacted: true as const },
                    workspace: matchWorkspaceAssociation({ cwd, workspaces: [{ id: 'accepted', path: root }] }).workspace },
            });
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(buildLocalServiceLauncherSnapshot({
                machineId: 'machine', updatedAt: 1, runTargets, previewResources: [], inventoryEntries: [
                    entry('api', 3005, root, 'node api.js'),
                    entry('command', 5173, root, 'node web.js'),
                    entry('ambiguous', 6006, root, 'node unrelated.js'),
                    entry('foreign', 3005, `${root}-other`, 'node api.js'),
                ],
            }));
            expect(snapshot.targets.filter(target => target.source === 'inventory_entry').map(target => [target.id, target.title]))
                .toEqual([['inventory:api', 'api'], ['inventory:foreign', 'node'],
                    ['inventory:command', 'commandOnly'], ['inventory:ambiguous', 'node']]);
            expect(snapshot.targets.filter(target => target.source === 'inventory_entry')
                .every(target => !target.declaration && !target.actions.includes('manage'))).toBe(true);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('keeps accepted package presentation on the same contained manager selection as native execution', async () => {
        const parent = await makeRepo();
        const root = join(parent, 'accepted');
        try {
            await writeJson(join(parent, 'package.json'), { packageManager: 'bun@1.2.8' });
            await mkdir(root);
            await writeJson(join(root, 'package.json'), { name: 'accepted', scripts: { dev: 'vite' } });
            const targets = (await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [{
                id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project',
            }] })).targets;
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
            const targets = (await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [{
                id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project',
            }] })).targets;
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
            const targets = (await discoverLocalServiceRunTargets({ roots: [root, unrelated], acceptedWorkspaceRefs: [workspace] })).targets;
            const qualified = targets.filter(target => 'declaration' in target);
            expect(qualified).toHaveLength(2);
            expect(qualified).toEqual(expect.arrayContaining([
                expect.objectContaining({ cwd: root, workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                    declaration: { workspaceRefId: 'accepted', selection: { kind: 'native', source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } } } }),
                expect.objectContaining({ cwd: join(root, 'web'), workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                    declaration: { workspaceRefId: 'accepted', selection: { kind: 'native', source: { kind: 'native', tool: 'package_script', file: 'web/package.json', target: 'start' } } } }),
            ]));
            expect(targets.filter(target => !('declaration' in target))).toMatchObject([{ id: expect.stringMatching(/^unqualified:dev:[a-f0-9]{12}$/u), cwd: unrelated }]);
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
    it('offers each physical package script through its nearest accepted Workspace instead of an accepted ancestor', async () => {
        const root = await makeRepo();
        const child = join(root, 'WAVE93-SERVICES-ART');
        const sibling = join(root, 'WAVE93-SERVICES-ART-other');
        try {
            await mkdir(child);
            await mkdir(sibling);
            await writeJson(join(root, 'package.json'), { name: 'parent', scripts: { start: 'node parent.js' } });
            await writeJson(join(child, 'package.json'), { name: 'wave93-services-art', scripts: { start: 'node child.js' } });
            await writeJson(join(sibling, 'package.json'), { name: 'sibling', scripts: { start: 'node sibling.js' } });
            const parentRef = { id: 'parent', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
            const childRef = { ...parentRef, id: 'child', rootPath: child };
            for (const acceptedWorkspaceRefs of [[parentRef, childRef], [childRef, parentRef]]) {
                const runTargets = (await discoverLocalServiceRunTargets({ roots: [root], acceptedWorkspaceRefs })).targets;
                const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(buildLocalServiceLauncherSnapshot({
                    machineId: 'machine', updatedAt: 1, runTargets, inventoryEntries: [], previewResources: [],
                }));
                expect(snapshot.targets.map(target => ({ cwd: target.cwd, declaration: target.declaration })))
                    .toEqual(expect.arrayContaining([
                        { cwd: root, declaration: { workspaceRefId: 'parent', selection: { kind: 'native',
                            source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'start' } } } },
                        { cwd: child, declaration: { workspaceRefId: 'child', selection: { kind: 'native',
                            source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'start' } } } },
                        { cwd: sibling, declaration: { workspaceRefId: 'parent', selection: { kind: 'native',
                            source: { kind: 'native', tool: 'package_script', file: 'WAVE93-SERVICES-ART-other/package.json', target: 'start' } } } },
                    ]));
                expect(snapshot.targets).toHaveLength(3);
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('does not offer package files that escape their root through a symlink', async () => {
        const root = await makeRepo();
        const outside = await makeRepo();
        try {
            await writeJson(join(outside, 'package.json'), { name: 'outside', scripts: { dev: 'echo private' } });
            await symlink(join(outside, 'package.json'), join(root, 'package.json'));
            expect((await discoverLocalServiceRunTargets({ roots: [root] })).targets).toEqual([]);
            expect(await resolveLocalServiceRunTargetCommand({ cwd: root, runTargetId: 'outside:dev' })).toBeNull();
        } finally {
            await Promise.all([root, outside].map((directory) => rm(directory, { recursive: true, force: true })));
        }
    });
    it('honors an inherited packageManager declaration over a conflicting lockfile', async () => {
        const root = await makeRepo();
        try {
            await writeJson(join(root, 'package.json'), { name: 'root', packageManager: 'bun@1.2.8' });
            await writeFile(join(root, 'pnpm-lock.yaml'), '');
            await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
            const cwd = join(root, 'web');
            await mkdir(cwd);
            await writeJson(join(cwd, 'package.json'), { name: 'web', scripts: { dev: 'vite' } });
            const targets = (await discoverLocalServiceRunTargets({ roots: [root] })).targets;
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
        const targets = (await discoverLocalServiceRunTargets({ roots: [root] })).targets;
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

        const targets = (await discoverLocalServiceRunTargets({ roots: [root] })).targets;

        expect(targets.map((target) => ({
            id: target.id,
            cwd: target.cwd,
            packageManager: target.packageManager,
            scriptName: target.scriptName,
            command: target.command,
        }))).toEqual([
            {
                id: expect.stringMatching(/^repo-root:dev:[a-f0-9]{12}$/u),
                cwd: root,
                packageManager: 'pnpm',
                scriptName: 'dev',
                command: 'vite --host 0.0.0.0',
            },
            {
                id: expect.stringMatching(/^@acme\/web:preview:[a-f0-9]{12}$/u),
                cwd: join(root, 'apps', 'web'),
                packageManager: 'pnpm',
                scriptName: 'preview',
                command: 'vite preview',
            },
            {
                id: expect.stringMatching(/^@acme\/web:start:[a-f0-9]{12}$/u),
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

        const targets = (await discoverLocalServiceRunTargets({ roots: [root] })).targets;

        expect(targets).toHaveLength(1);
        expect(targets[0]?.launchIntent).toEqual({
            kind: 'packageScript',
            packageManager: 'npm',
            cwd: root,
            scriptName: 'serve',
        });
        expect('executablePath' in (targets[0]?.launchIntent ?? {})).toBe(false);
    });

    it('keeps package-script target ids stable and unique across scoped sibling discovery and reopening', async () => {
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

        const targets = (await discoverLocalServiceRunTargets({ roots: [root] })).targets;

        expect(targets).toHaveLength(2);
        expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);
        expect(new Set(targets.map((target) => target.cwd))).toEqual(new Set([
            join(root, 'apps', 'web'),
            join(root, 'examples', 'web'),
        ]));
        for (const target of targets) {
            const scoped = (await discoverLocalServiceRunTargets({ roots: [target.cwd] })).targets;
            expect(scoped.map(candidate => candidate.id)).toEqual([target.id]);
            expect(((await discoverLocalServiceRunTargets({ roots: [target.cwd] })).targets).map(candidate => candidate.id)).toEqual([target.id]);
            expect(((await discoverLocalServiceRunTargets({ roots: [`${target.cwd}/`] })).targets).map(candidate => candidate.id)).toEqual([target.id]);
        }
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

        expect((await discoverLocalServiceRunTargets({ roots: [root] })).targets).toHaveLength(1);
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
            const targets = (await discoverLocalServiceRunTargets({ roots: [root, secondRoot] })).targets;
            expect(targets.map((target) => target.id)).toEqual([
                expect.stringMatching(/^late:dev:[a-f0-9]{12}$/u), expect.stringMatching(/^second:dev:[a-f0-9]{12}$/u),
            ]);
        } finally {
            await Promise.all([root, secondRoot].map((directory) => rm(directory, { recursive: true, force: true })));
        }
    });
});
