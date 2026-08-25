import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverLocalServiceRunTargets } from './runTargets';

async function makeRepo(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-local-services-'));
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('discoverLocalServiceRunTargets', () => {
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

    it('honors the directory traversal budget to keep discovery bounded', async () => {
        const root = await makeRepo();
        await mkdir(join(root, 'apps', 'web'), { recursive: true });
        await writeJson(join(root, 'package.json'), {
            name: 'repo-root',
            scripts: {
                dev: 'vite',
            },
        });
        await writeJson(join(root, 'apps', 'web', 'package.json'), {
            name: 'web',
            scripts: {
                dev: 'vite --host 127.0.0.1',
            },
        });

        const targets = await discoverLocalServiceRunTargets({
            roots: [root],
            maxVisitedDirectories: 1,
        });

        expect(targets.map((target) => target.id)).toEqual(['repo-root:dev']);
    });
});
