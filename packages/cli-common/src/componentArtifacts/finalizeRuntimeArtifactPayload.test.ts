import { cp, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { extractArchivePayloadToDirectory, inspectTarArchiveEntries } from '@happier-dev/release-runtime/archiveExtraction';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';

const fsFailurePlan = vi.hoisted(() => ({
    failCopy: false,
    failStagedRename: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        cp: async (
            source: Parameters<typeof actual.cp>[0],
            destination: Parameters<typeof actual.cp>[1],
            options: Parameters<typeof actual.cp>[2],
        ) => {
            if (fsFailurePlan.failCopy) throw new Error('injected payload copy failure');
            return await actual.cp(source, destination, options);
        },
        rename: async (
            oldPath: Parameters<typeof actual.rename>[0],
            newPath: Parameters<typeof actual.rename>[1],
        ) => {
            if (fsFailurePlan.failStagedRename && basename(String(oldPath)) === 'entry') {
                throw new Error('injected staged rename failure');
            }
            return await actual.rename(oldPath, newPath);
        },
    };
});

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'finalize-runtime-artifact-payload-'));
    tempDirs.push(directory);
    return directory;
}

describe('finalizeRuntimeArtifactPayload', () => {
    afterEach(async () => {
        fsFailurePlan.failCopy = false;
        fsFailurePlan.failStagedRename = false;
        await Promise.all(tempDirs.splice(0).map(async (directory) => {
            await rm(directory, { recursive: true, force: true });
        }));
    });

    it('rejects a linked payload root before mutating its target', async () => {
        const rootDir = await createTempDir();
        const sourceDir = join(rootDir, 'source');
        const payloadDir = join(rootDir, 'payload');
        const packageManagerBinPath = join(sourceDir, 'node_modules', '.bin', 'tool');
        await mkdir(join(sourceDir, 'node_modules', '.bin'), { recursive: true });
        await writeFile(packageManagerBinPath, 'external-package-manager-shim', 'utf8');
        await symlink(
            sourceDir,
            payloadDir,
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
            /root must be a physical directory/i,
        );

        expect((await lstat(payloadDir)).isSymbolicLink()).toBe(true);
        expect(await readFile(packageManagerBinPath, 'utf8')).toBe('external-package-manager-shim');
    });

    it('rejects an escaping node_modules link before mutating its target', async () => {
        const rootDir = await createTempDir();
        const externalNodeModulesDir = join(rootDir, 'external-node-modules');
        const payloadDir = join(rootDir, 'payload');
        const packageManagerBinPath = join(externalNodeModulesDir, '.bin', 'tool');
        await mkdir(join(externalNodeModulesDir, '.bin'), { recursive: true });
        await mkdir(payloadDir, { recursive: true });
        await writeFile(packageManagerBinPath, 'external-package-manager-shim', 'utf8');
        await symlink(
            externalNodeModulesDir,
            join(payloadDir, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
            /escapes the artifact/i,
        );

        expect((await lstat(join(payloadDir, 'node_modules'))).isSymbolicLink()).toBe(true);
        expect(await readFile(packageManagerBinPath, 'utf8')).toBe('external-package-manager-shim');
    });

    it.skipIf(process.platform === 'win32')('removes package-manager links before planning retained link materialization', async () => {
        const rootDir = await createTempDir();
        const payloadDir = join(rootDir, 'payload');
        await mkdir(join(payloadDir, 'runtime'), { recursive: true });
        await mkdir(join(payloadDir, 'aliases'), { recursive: true });
        await mkdir(join(payloadDir, 'node_modules', '.bin'), { recursive: true });
        await writeFile(join(payloadDir, 'runtime', 'tool'), 'runtime', 'utf8');
        await symlink(
            join('..', '..', 'runtime', 'tool'),
            join(payloadDir, 'node_modules', '.bin', 'tool'),
        );
        await symlink(
            join('..', 'runtime', 'tool'),
            join(payloadDir, 'aliases', 'tool'),
        );

        await finalizeRuntimeArtifactPayload(payloadDir);

        await expect(lstat(join(payloadDir, 'node_modules', '.bin'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(payloadDir, 'aliases', 'tool'), 'utf8')).toBe('runtime');
    });

    it(
        'materializes contained symlinks and hardlinks into an update-safe payload without mutating its source',
        async () => {
            const rootDir = await createTempDir();
            const sourceDir = join(rootDir, 'source');
            const payloadDir = join(rootDir, 'payload');
            const archivePath = join(rootDir, 'payload.tar.gz');
            const extractDir = join(rootDir, 'extracted');

            await mkdir(join(sourceDir, 'runtime'), { recursive: true });
            await mkdir(join(sourceDir, 'aliases'), { recursive: true });
            await writeFile(join(sourceDir, 'runtime', 'tool'), '#!/bin/sh\necho runtime\n', 'utf8');
            await chmod(join(sourceDir, 'runtime', 'tool'), 0o755);
            await symlink(
                process.platform === 'win32' ? join(sourceDir, 'runtime') : join('..', 'runtime'),
                join(sourceDir, 'aliases', 'runtime'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            if (process.platform !== 'win32') {
                await symlink(join('..', 'runtime', 'tool'), join(sourceDir, 'aliases', 'tool'));
            }
            await link(join(sourceDir, 'runtime', 'tool'), join(sourceDir, 'runtime', 'tool-hardlink'));

            await cp(sourceDir, payloadDir, {
                recursive: true,
                dereference: false,
                verbatimSymlinks: true,
            });
            if (process.platform === 'win32') {
                await rm(join(payloadDir, 'aliases', 'runtime'), { recursive: true });
                await symlink(
                    join(payloadDir, 'runtime'),
                    join(payloadDir, 'aliases', 'runtime'),
                    'junction',
                );
            }
            // Node's recursive copy deliberately does not promise hardlink preservation.
            await rm(join(payloadDir, 'runtime', 'tool-hardlink'));
            await link(join(payloadDir, 'runtime', 'tool'), join(payloadDir, 'runtime', 'tool-hardlink'));

            const sourceToolBefore = await stat(join(sourceDir, 'runtime', 'tool'));
            const sourceHardlinkBefore = await stat(join(sourceDir, 'runtime', 'tool-hardlink'));

            await finalizeRuntimeArtifactPayload(payloadDir);

            expect((await lstat(join(payloadDir, 'aliases', 'runtime'))).isDirectory()).toBe(true);
            expect((await lstat(join(payloadDir, 'aliases', 'runtime'))).isSymbolicLink()).toBe(false);
            expect(await readFile(join(payloadDir, 'aliases', 'runtime', 'tool'), 'utf8')).toBe(
                '#!/bin/sh\necho runtime\n',
            );
            expect((await stat(join(payloadDir, 'aliases', 'runtime', 'tool'))).mode & 0o777).toBe(
                (await stat(join(payloadDir, 'runtime', 'tool'))).mode & 0o777,
            );
            if (process.platform !== 'win32') {
                expect((await stat(join(payloadDir, 'aliases', 'runtime', 'tool'))).mode & 0o777).toBe(0o755);
                expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isFile()).toBe(true);
                expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isSymbolicLink()).toBe(false);
            }

            const payloadTool = await stat(join(payloadDir, 'runtime', 'tool'));
            const payloadHardlink = await stat(join(payloadDir, 'runtime', 'tool-hardlink'));
            expect(payloadTool.ino).not.toBe(payloadHardlink.ino);
            expect(payloadTool.nlink).toBe(1);
            expect(payloadHardlink.nlink).toBe(1);

            expect((await lstat(join(sourceDir, 'aliases', 'runtime'))).isSymbolicLink()).toBe(true);
            expect((await stat(join(sourceDir, 'runtime', 'tool'))).ino).toBe(sourceToolBefore.ino);
            expect((await stat(join(sourceDir, 'runtime', 'tool-hardlink'))).ino).toBe(sourceHardlinkBefore.ino);
            expect(sourceToolBefore.ino).toBe(sourceHardlinkBefore.ino);

            await finalizeRuntimeArtifactPayload(payloadDir);
            expect((await stat(join(payloadDir, 'runtime', 'tool'))).ino).toBe(payloadTool.ino);
            expect((await stat(join(payloadDir, 'runtime', 'tool-hardlink'))).ino).toBe(payloadHardlink.ino);

            await tar.c({
                cwd: rootDir,
                file: archivePath,
                gzip: true,
                portable: true,
            }, ['payload']);
            const entries = await inspectTarArchiveEntries({ archivePath });
            expect(entries.some((entry) => entry.path === 'payload/aliases/runtime/tool')).toBe(true);

            await extractArchivePayloadToDirectory({
                archivePath,
                archiveName: 'payload.tar.gz',
                extractDir,
            });
            expect(await readFile(join(extractDir, 'payload', 'aliases', 'runtime', 'tool'), 'utf8')).toBe(
                '#!/bin/sh\necho runtime\n',
            );
        },
    );

    it.skipIf(process.platform === 'win32')('rejects broken, escaping, and special payload entries before materializing any links', async () => {
        const rootDir = await createTempDir();
        const outsidePath = join(rootDir, 'outside.txt');
        await writeFile(outsidePath, 'outside-original', 'utf8');

        for (const topology of ['broken', 'escaping'] as const) {
            const payloadDir = join(rootDir, topology);
            await mkdir(join(payloadDir, 'links'), { recursive: true });
            await writeFile(join(payloadDir, 'target'), 'inside', 'utf8');
            await symlink(join('..', 'target'), join(payloadDir, 'links', 'contained'));
            await symlink(
                topology === 'broken' ? join('..', 'missing') : join('..', '..', 'outside.txt'),
                join(payloadDir, 'links', topology),
            );

            await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
                topology === 'broken' ? /cannot be resolved/i : /escapes the artifact/i,
            );
            expect((await lstat(join(payloadDir, 'links', 'contained'))).isSymbolicLink()).toBe(true);
            expect(await readFile(outsidePath, 'utf8')).toBe('outside-original');
        }

        const specialPayloadDir = await mkdtemp('/tmp/hrp-special-');
        tempDirs.push(specialPayloadDir);
        const socketPath = join(specialPayloadDir, 'runtime.sock');
        const { createServer } = await import('node:net');
        const { once } = await import('node:events');
        const server = createServer();
        try {
            server.listen(socketPath);
            await once(server, 'listening');
            await expect(finalizeRuntimeArtifactPayload(specialPayloadDir)).rejects.toThrow(
                /unsupported file type/i,
            );
        } finally {
            server.close();
            await once(server, 'close');
        }
    });

    it.skipIf(process.platform === 'win32')('rolls back link replacement and cleans staging after copy or rename failure', async () => {
        for (const failure of ['copy', 'rename'] as const) {
            const rootDir = await createTempDir();
            const payloadDir = join(rootDir, failure);
            await mkdir(join(payloadDir, 'runtime'), { recursive: true });
            await mkdir(join(payloadDir, 'aliases'), { recursive: true });
            await writeFile(join(payloadDir, 'runtime', 'tool'), 'runtime', 'utf8');
            await symlink(join('..', 'runtime', 'tool'), join(payloadDir, 'aliases', 'tool'));

            fsFailurePlan.failCopy = failure === 'copy';
            fsFailurePlan.failStagedRename = failure === 'rename';
            await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
                failure === 'copy' ? /injected payload copy failure/i : /injected staged rename failure/i,
            );
            fsFailurePlan.failCopy = false;
            fsFailurePlan.failStagedRename = false;

            expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isSymbolicLink()).toBe(true);
            expect(await readFile(join(payloadDir, 'aliases', 'tool'), 'utf8')).toBe('runtime');
            expect(
                (await readdir(join(payloadDir, 'aliases')))
                    .filter((entry) => entry.startsWith('.happier-materialize-link-')),
            ).toEqual([]);
        }
    });
});
