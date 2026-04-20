import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor is required for this test');
}

const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

const { lockedRmTargets } = vi.hoisted(() => ({
    lockedRmTargets: new Map<string, string>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();

    return {
        ...actual,
        rm: vi.fn(async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
            const targetPath = typeof path === 'string' ? path : path.toString();
            const code = lockedRmTargets.get(targetPath);
            if (code) {
                const error = new Error(`${code}: mocked locked-version prune failure for '${targetPath}'`) as NodeJS.ErrnoException;
                error.code = code;
                throw error;
            }
            return await actual.rm(path, options);
        }),
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

async function createPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const payloadRoot = join(rootDir, `payload-${versionId}`);
    await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
    await writeFile(join(payloadRoot, 'happier.exe'), contents, 'utf8');
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return payloadRoot;
}

describe('installVersionedPayload Windows locked-version pruning', () => {
    it('keeps the new preview install active when pruning an older locked version fails', async () => {
        await withPlatform('win32', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-install-versioned-payload-win32-prune-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const {
                    installVersionedPayload,
                    resolveFirstPartyVersionInstallPath,
                    resolveInstalledFirstPartyComponentPaths,
                } = await import('./index.js');

                await installVersionedPayload({
                    componentId: 'happier-cli',
                    versionId: '1.0.0-preview.1',
                    payloadRoot: await createPayload(homeDir, '1.0.0-preview.1', 'first-preview'),
                    processEnv: env,
                    channel: 'preview',
                });
                await installVersionedPayload({
                    componentId: 'happier-cli',
                    versionId: '2.0.0-preview.1',
                    payloadRoot: await createPayload(homeDir, '2.0.0-preview.1', 'second-preview'),
                    processEnv: env,
                    channel: 'preview',
                });

                const lockedVersionPath = resolveFirstPartyVersionInstallPath({
                    componentId: 'happier-cli',
                    versionId: '1.0.0-preview.1',
                    processEnv: env,
                    channel: 'preview',
                });
                lockedRmTargets.set(lockedVersionPath, 'EACCES');

                await expect(installVersionedPayload({
                    componentId: 'happier-cli',
                    versionId: '3.0.0-preview.1',
                    payloadRoot: await createPayload(homeDir, '3.0.0-preview.1', 'third-preview'),
                    processEnv: env,
                    channel: 'preview',
                })).resolves.toMatchObject({
                    currentVersionId: '3.0.0-preview.1',
                    previousVersionId: '2.0.0-preview.1',
                });

                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    processEnv: env,
                    channel: 'preview',
                });

                expect(await readFile(paths.binaryPath, 'utf8')).toBe('third-preview');
                expect(existsSync(lockedVersionPath)).toBe(true);
                expect(await readFile(join(lockedVersionPath, 'happier.exe'), 'utf8')).toBe('first-preview');
            } finally {
                lockedRmTargets.clear();
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);
});
