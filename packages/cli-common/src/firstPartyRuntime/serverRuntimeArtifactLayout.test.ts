import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    relocateServerRuntimeArtifactClosure,
    resolveManagedServerRuntimePaths,
} from './serverRuntimeArtifactLayout.js';

const tempRoots: string[] = [];

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('server runtime artifact layout', () => {
    it('relocates the complete executable-relative closure together', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-server-runtime-layout-'));
        tempRoots.push(root);
        await mkdir(join(root, 'runtime'), { recursive: true });
        await mkdir(join(root, 'prisma', 'migrations'), { recursive: true });
        await mkdir(join(root, 'generated'), { recursive: true });
        await mkdir(join(root, 'node_modules'), { recursive: true });
        await writeFile(join(root, 'happier-server'), 'server\n');
        await writeFile(join(root, 'happier-server-migrate'), 'migrate\n');
        await writeFile(join(root, 'runtime', 'runner'), 'runner\n');
        await writeFile(join(root, 'prisma', 'migrations', 'migration.sql'), '-- migration\n');

        const relocated = await relocateServerRuntimeArtifactClosure({ payloadRoot: root, platform: 'linux' });

        expect(relocated.serverBinaryPath).toBe(join(root, 'bin', 'happier-server'));
        expect(relocated.migrationBinaryPath).toBe(join(root, 'bin', 'happier-server-migrate'));
        await expect(readFile(join(root, 'bin', 'runtime', 'runner'), 'utf8')).resolves.toBe('runner\n');
        await expect(readFile(join(root, 'bin', 'prisma', 'migrations', 'migration.sql'), 'utf8'))
            .resolves.toBe('-- migration\n');
        await expect(access(join(root, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(join(root, 'prisma'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('resolves one canonical managed runtime root on every platform', () => {
        expect(resolveManagedServerRuntimePaths({ installRoot: '/opt/happier', platform: 'linux' })).toEqual({
            runtimeRoot: '/opt/happier/bin',
            serverBinaryPath: '/opt/happier/bin/happier-server',
            migrationBinaryPath: '/opt/happier/bin/happier-server-migrate',
        });
        expect(resolveManagedServerRuntimePaths({ installRoot: 'C:\\Happier', platform: 'win32' })).toEqual({
            runtimeRoot: join('C:\\Happier', 'bin'),
            serverBinaryPath: join('C:\\Happier', 'bin', 'happier-server.exe'),
            migrationBinaryPath: join('C:\\Happier', 'bin', 'happier-server-migrate.exe'),
        });
    });
});
