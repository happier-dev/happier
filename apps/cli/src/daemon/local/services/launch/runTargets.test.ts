import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverLocalServiceRunTargets, resolveLocalServiceRunTargetCommand } from './runTargets';

async function makeRepo(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-local-services-'));
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('discoverLocalServiceRunTargets', () => {
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
