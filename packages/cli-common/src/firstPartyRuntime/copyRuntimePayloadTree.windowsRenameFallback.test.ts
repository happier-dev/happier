import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor is required for this test');
}

const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

const { renameMock, renameDelegate, renameFailureTargets, rmMock, rmDelegate, readdirMock, readdirDelegate } = vi.hoisted(() => ({
    renameMock: vi.fn(),
    renameDelegate: { current: null as null | typeof import('node:fs/promises').rename },
    renameFailureTargets: new Set<string>(),
    rmMock: vi.fn(),
    rmDelegate: { current: null as null | typeof import('node:fs/promises').rm },
    readdirMock: vi.fn(),
    readdirDelegate: { current: null as null | typeof import('node:fs/promises').readdir },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    renameDelegate.current = actual.rename;
    rmDelegate.current = actual.rm;
    readdirDelegate.current = actual.readdir;
    return {
        ...actual,
        rename: renameMock,
        rm: rmMock,
        readdir: readdirMock,
    };
});

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    try {
        return await run();
    } finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
    }
}

describe('replaceRuntimePayloadTree Windows rename fallback', () => {
    beforeEach(() => {
        readdirMock.mockImplementation((target, options) => readdirDelegate.current!(target, options));
    });

    afterEach(() => {
        renameFailureTargets.clear();
        renameMock.mockReset();
        rmMock.mockReset();
        readdirMock.mockReset();
        vi.resetModules();
    });

    it('falls back to copying the staged payload when Windows blocks the final rename with EPERM', async () => {
        await withPlatform('win32', async () => {
            const workspace = await mkdtemp(join(tmpdir(), 'happier-copy-runtime-payload-tree-win32-'));
            const sourcePath = join(workspace, 'source');
            const destinationPath = join(workspace, 'dest');

            if (!renameDelegate.current || !rmDelegate.current) {
                throw new Error('expected node:fs/promises delegates to be initialized');
            }

            renameMock.mockImplementation(async (from, to) => {
                if (to === destinationPath && String(from).includes('.dest.tmp-') && renameFailureTargets.has(destinationPath)) {
                    renameFailureTargets.delete(destinationPath);
                    const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
                return renameDelegate.current!(from, to);
            });
            rmMock.mockImplementation((target, options) => rmDelegate.current!(target, options));
            renameFailureTargets.add(destinationPath);

            await mkdir(join(sourcePath, 'package-dist'), { recursive: true });
            await writeFile(join(sourcePath, 'happier.exe'), 'runtime-binary', 'utf8');
            await writeFile(join(sourcePath, 'package-dist', 'index.mjs'), 'export default "ok";\n', 'utf8');

            try {
                const { replaceRuntimePayloadTree } = await import('./copyRuntimePayloadTree');
                await replaceRuntimePayloadTree({
                    sourcePath,
                    destinationPath,
                });

                expect(await readFile(join(destinationPath, 'happier.exe'), 'utf8')).toBe('runtime-binary');
                expect(await readFile(join(destinationPath, 'package-dist', 'index.mjs'), 'utf8')).toContain('ok');
                expect(existsSync(sourcePath)).toBe(true);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        });
    });

    it('consumes the staged payload on Windows when consumeSourcePath is requested', async () => {
        await withPlatform('win32', async () => {
            const workspace = await mkdtemp(join(tmpdir(), 'happier-copy-runtime-payload-tree-win32-consume-'));
            const sourcePath = join(workspace, 'source');
            const destinationPath = join(workspace, 'dest');

            if (!renameDelegate.current || !rmDelegate.current) {
                throw new Error('expected node:fs/promises delegates to be initialized');
            }

            renameMock.mockImplementation((from, to) => renameDelegate.current!(from, to));
            rmMock.mockImplementation((target, options) => rmDelegate.current!(target, options));

            await mkdir(join(sourcePath, 'package-dist'), { recursive: true });
            await writeFile(join(sourcePath, 'happier.exe'), 'runtime-binary', 'utf8');
            await writeFile(join(sourcePath, 'package-dist', 'index.mjs'), 'export default "ok";\n', 'utf8');

            try {
                const { replaceRuntimePayloadTree } = await import('./copyRuntimePayloadTree');
                await replaceRuntimePayloadTree({
                    sourcePath,
                    destinationPath,
                    consumeSourcePath: true,
                });

                expect(await readFile(join(destinationPath, 'happier.exe'), 'utf8')).toBe('runtime-binary');
                expect(await readFile(join(destinationPath, 'package-dist', 'index.mjs'), 'utf8')).toContain('ok');
                expect(existsSync(sourcePath)).toBe(false);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        });
    });

    it('does not recursively prune a consumed Windows payload that the release archive already filtered', async () => {
        await withPlatform('win32', async () => {
            const workspace = await mkdtemp(join(tmpdir(), 'happier-copy-runtime-payload-tree-win32-filtered-'));
            const sourcePath = join(workspace, 'source');
            const destinationPath = join(workspace, 'dest');

            if (!renameDelegate.current || !rmDelegate.current || !readdirDelegate.current) {
                throw new Error('expected node:fs/promises delegates to be initialized');
            }

            renameMock.mockImplementation((from, to) => renameDelegate.current!(from, to));
            rmMock.mockImplementation((target, options) => rmDelegate.current!(target, options));
            readdirMock.mockImplementation((target, options) => readdirDelegate.current!(target, options));

            await mkdir(join(sourcePath, 'package-dist'), { recursive: true });
            await mkdir(join(sourcePath, 'node_modules', 'large-package', 'nested'), { recursive: true });
            await writeFile(join(sourcePath, 'happier.exe'), 'runtime-binary', 'utf8');
            await writeFile(join(sourcePath, 'package-dist', 'index.mjs'), 'export default "ok";\n', 'utf8');
            await writeFile(join(sourcePath, 'node_modules', 'large-package', 'nested', 'index.js'), 'module.exports = 1;\n', 'utf8');

            try {
                const { replaceRuntimePayloadTree } = await import('./copyRuntimePayloadTree');
                await replaceRuntimePayloadTree({
                    sourcePath,
                    destinationPath,
                    consumeSourcePath: true,
                    sourcePathAlreadyFiltered: true,
                });

                expect(await readFile(join(destinationPath, 'happier.exe'), 'utf8')).toBe('runtime-binary');
                expect(existsSync(sourcePath)).toBe(false);
                expect(readdirMock).not.toHaveBeenCalled();
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        });
    });

    it('treats locked backup cleanup as non-fatal after successful payload promotion', async () => {
        await withPlatform('win32', async () => {
            const workspace = await mkdtemp(join(tmpdir(), 'happier-copy-runtime-payload-tree-win32-'));
            const sourcePath = join(workspace, 'source');
            const destinationPath = join(workspace, 'installed-runtime');
            const backupPathMarker = `.${basename(destinationPath)}.bak-`;
            let backupRmAttempts = 0;

            if (!renameDelegate.current || !rmDelegate.current) {
                throw new Error('expected node:fs/promises delegates to be initialized');
            }

            renameMock.mockImplementation((from, to) => renameDelegate.current!(from, to));
            rmMock.mockImplementation(async (target, options) => {
                const targetPath = String(target);
                if (targetPath.includes(backupPathMarker)) {
                    backupRmAttempts += 1;
                    if (backupRmAttempts >= 2) {
                        const error = new Error(`EACCES: permission denied, rm '${targetPath}'`) as NodeJS.ErrnoException;
                        error.code = 'EACCES';
                        throw error;
                    }
                }
                return rmDelegate.current!(target, options);
            });

            await mkdir(join(sourcePath, 'package-dist'), { recursive: true });
            await writeFile(join(sourcePath, 'happier.exe'), 'runtime-binary', 'utf8');
            await writeFile(join(sourcePath, 'package-dist', 'index.mjs'), 'export default "ok";\n', 'utf8');
            await mkdir(destinationPath, { recursive: true });
            await writeFile(join(destinationPath, 'happier.exe'), 'old-runtime-binary', 'utf8');

            try {
                const { replaceRuntimePayloadTree } = await import('./copyRuntimePayloadTree');
                await expect(
                    replaceRuntimePayloadTree({
                        sourcePath,
                        destinationPath,
                    }),
                ).resolves.toBeUndefined();

                expect(await readFile(join(destinationPath, 'happier.exe'), 'utf8')).toBe('runtime-binary');
                expect(await readFile(join(destinationPath, 'package-dist', 'index.mjs'), 'utf8')).toContain('ok');
                expect(existsSync(sourcePath)).toBe(true);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        });
    });

    it('preserves symlinked payload entries on the Windows copy fallback path', async () => {
        await withPlatform('win32', async () => {
            const workspace = await mkdtemp(join(tmpdir(), 'happier-copy-runtime-payload-tree-win32-symlink-'));
            const sourcePath = join(workspace, 'source');
            const destinationPath = join(workspace, 'dest');
            const externalTargetPath = join(workspace, 'external-sidecar.js');

            if (!renameDelegate.current) {
                throw new Error('expected node:fs/promises.rename delegate to be initialized');
            }

            renameMock.mockImplementation(async (from, to) => renameDelegate.current!(from, to));
            rmMock.mockImplementation((target, options) => rmDelegate.current!(target, options));

            await mkdir(join(sourcePath, 'generated'), { recursive: true });
            await writeFile(externalTargetPath, 'export const outside = true;\n', 'utf8');
            await symlink(externalTargetPath, join(sourcePath, 'generated', 'runtime-sidecar.js'));

            try {
                const { replaceRuntimePayloadTree } = await import('./copyRuntimePayloadTree');
                await replaceRuntimePayloadTree({
                    sourcePath,
                    destinationPath,
                });

                const installedPath = join(destinationPath, 'generated', 'runtime-sidecar.js');
                expect((await lstat(installedPath)).isSymbolicLink()).toBe(true);
                expect(await readlink(installedPath)).toBe(externalTargetPath);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        });
    });
});
