import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor is required for this test');
}
const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

const { cpFailureTargets, symlinkFailureTargets } = vi.hoisted(() => ({
    cpFailureTargets: new Set<string>(),
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
        symlink: vi.fn(async (target: string, path: string, type?: Parameters<typeof actual.symlink>[2]) => {
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
        cpFailureTargets.clear();
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
});
