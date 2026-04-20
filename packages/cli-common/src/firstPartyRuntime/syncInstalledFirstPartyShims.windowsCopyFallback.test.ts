import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeDefaultManagedReleaseChannel } from './defaultReleaseChannelState';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor is required for this test');
}

const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

const { linkFailureTargets } = vi.hoisted(() => ({
    linkFailureTargets: new Set<string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();

    return {
        ...actual,
        linkSync: vi.fn((existingPath: string, newPath: string) => {
            if (linkFailureTargets.has(newPath)) {
                linkFailureTargets.delete(newPath);
                const error = new Error(`EPERM: operation not permitted, link '${existingPath}' -> '${newPath}'`) as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return actual.linkSync(existingPath, newPath);
        }),
    };
});

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();

    return {
        ...actual,
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

async function createStagedPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const stagedPayloadPath = join(rootDir, `stage-${versionId}`);
    await mkdir(stagedPayloadPath, { recursive: true });
    await mkdir(join(stagedPayloadPath, 'package-dist'), { recursive: true });
    await writeFile(join(stagedPayloadPath, 'happier.exe'), contents, 'utf8');
    await writeFile(join(stagedPayloadPath, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return stagedPayloadPath;
}

describe('syncInstalledFirstPartyShims Windows copy fallback', () => {
    afterEach(() => {
        linkFailureTargets.clear();
        vi.resetModules();
    });

    it('falls back to copyFile when Windows hard-link creation fails', async () => {
        await withPlatform('win32', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-sync-shims-win32-copy-fallback-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const { promoteVersionedPayload, syncInstalledFirstPartyShims } = await import('./index.js');
                await writeDefaultManagedReleaseChannel({
                    processEnv: env,
                    releaseChannel: 'preview',
                });
                await promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    channel: 'preview',
                    versionId: '1.0.0-preview.1',
                    stagedPayloadPath: await createStagedPayload(homeDir, '1.0.0-preview.1', 'preview-binary'),
                });

                const happierShimPath = join(homeDir, 'bin', 'happier.exe');
                const hprevShimPath = join(homeDir, 'bin', 'hprev.exe');
                linkFailureTargets.add(happierShimPath);
                linkFailureTargets.add(hprevShimPath);

                const result = await syncInstalledFirstPartyShims({
                    componentId: 'happier-cli',
                    processEnv: env,
                    channel: 'preview',
                    defaultReleaseChannelOverride: 'preview',
                });

                expect(result.shimPaths).toEqual([happierShimPath, hprevShimPath]);
                expect(existsSync(happierShimPath)).toBe(true);
                expect(existsSync(hprevShimPath)).toBe(true);
                expect(await readFile(happierShimPath, 'utf8')).toBe('preview-binary');
                expect(await readFile(hprevShimPath, 'utf8')).toBe('preview-binary');
            }
            finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);
});
