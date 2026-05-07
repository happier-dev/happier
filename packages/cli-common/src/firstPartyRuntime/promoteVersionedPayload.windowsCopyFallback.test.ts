import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor is required for this test');
}

const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

const { copyFileFailureSubstrings, cpFailureTargets, renameFailureSubstrings, symlinkFailureSubstrings, symlinkFailureTargets } = vi.hoisted(() => ({
    copyFileFailureSubstrings: new Set<string>(),
    cpFailureTargets: new Set<string>(),
    renameFailureSubstrings: new Set<string>(),
    symlinkFailureSubstrings: new Set<string>(),
    symlinkFailureTargets: new Set<string>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();

    return {
        ...actual,
        cp: vi.fn(async (source: string, destination: string, options?: Parameters<typeof actual.cp>[2]) => {
            if (cpFailureTargets.has(destination)) {
                cpFailureTargets.delete(destination);
                const error = new Error(`ENOENT: no such file or directory, open '${destination}'`) as NodeJS.ErrnoException;
                error.code = 'ENOENT';
                throw error;
            }
            return await actual.cp(source, destination, options);
        }),
        copyFile: vi.fn(async (source: string, destination: string, mode?: Parameters<typeof actual.copyFile>[2]) => {
            for (const substring of copyFileFailureSubstrings) {
                if (destination.includes(substring)) {
                    copyFileFailureSubstrings.delete(substring);
                    const error = new Error(`ENAMETOOLONG: name too long, copyfile '${source}' -> '${destination}'`) as NodeJS.ErrnoException;
                    error.code = 'ENAMETOOLONG';
                    throw error;
                }
            }
            return await actual.copyFile(source, destination, mode);
        }),
        rename: vi.fn(async (oldPath: string, newPath: string) => {
            for (const substring of renameFailureSubstrings) {
                if (oldPath.includes(substring) || newPath.includes(substring)) {
                    renameFailureSubstrings.delete(substring);
                    const error = new Error(`EPERM: operation not permitted, rename '${oldPath}' -> '${newPath}'`) as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
            }
            return await actual.rename(oldPath, newPath);
        }),
        symlink: vi.fn(async (target: string, path: string, type?: Parameters<typeof actual.symlink>[2]) => {
            for (const substring of symlinkFailureSubstrings) {
                if (path.includes(substring)) {
                    symlinkFailureSubstrings.delete(substring);
                    const error = new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`) as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
            }
            if (symlinkFailureTargets.has(path)) {
                symlinkFailureTargets.delete(path);
                const error = new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`) as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return await actual.symlink(target, path, type);
        }),
    };
});

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    try {
        return await run();
    }
    finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
    }
}

async function createPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const payloadRoot = join(rootDir, `payload-${versionId}`);
    await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
    await writeFile(join(payloadRoot, 'happier.exe'), contents, 'utf8');
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return payloadRoot;
}

describe('promoteVersionedPayload Windows copy fallback', () => {
    afterEach(() => {
        copyFileFailureSubstrings.clear();
        cpFailureTargets.clear();
        renameFailureSubstrings.clear();
        symlinkFailureSubstrings.clear();
        symlinkFailureTargets.clear();
        vi.resetModules();
    });

    it('falls back to a manual recursive copy when the Windows junction creation fails', async () => {
        await withPlatform('win32', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-promote-versioned-payload-win32-fallback-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const { promoteVersionedPayload, resolveInstalledFirstPartyComponentPaths } = await import('./index.js');
                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    processEnv: env,
                });
                symlinkFailureTargets.add(paths.currentPath);

                const promotion = await promoteVersionedPayload({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    processEnv: env,
                    versionId: '1.0.0-preview.1',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0-preview.1', 'preview-version'),
                });

                expect(promotion.currentVersionId).toBe('1.0.0-preview.1');
                expect(await readFile(paths.binaryPath, 'utf8')).toBe('preview-version');
                expect(existsSync(join(paths.installRoot, 'current.version'))).toBe(true);
            }
            finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 20000);

    it('quarantines a corrupted Windows install root and retries when preserving previous fails with a long path error', async () => {
        await withPlatform('win32', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-promote-versioned-payload-win32-corrupt-retry-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const { installVersionedPayload, resolveInstalledFirstPartyComponentPaths } = await import('./index.js');
                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    processEnv: env,
                });

                await installVersionedPayload({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    processEnv: env,
                    versionId: '1.0.0-preview.1',
                    payloadRoot: await createPayload(homeDir, '1.0.0-preview.1', 'first-preview-version'),
                });

                renameFailureSubstrings.add('.previous.tmp-');
                copyFileFailureSubstrings.add('.previous.tmp-');

                await expect(installVersionedPayload({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    processEnv: env,
                    versionId: '2.0.0-preview.1',
                    payloadRoot: await createPayload(homeDir, '2.0.0-preview.1', 'second-preview-version'),
                })).resolves.toMatchObject({
                    currentVersionId: '2.0.0-preview.1',
                    previousVersionId: null,
                });
                expect(await readFile(paths.binaryPath, 'utf8')).toBe('second-preview-version');
                expect(existsSync(join(paths.installRoot, 'previous.version'))).toBe(false);

                const happyHomeEntries = await readdir(homeDir);
                expect(happyHomeEntries.some((entry) => entry.startsWith('.cli-preview.corrupt-'))).toBe(true);
            }
            finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 20000);
});
