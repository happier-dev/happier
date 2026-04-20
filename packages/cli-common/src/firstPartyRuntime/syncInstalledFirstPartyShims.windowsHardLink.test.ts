import { statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeDefaultManagedReleaseChannel } from './defaultReleaseChannelState';
import { promoteVersionedPayload } from './promoteVersionedPayload';
import { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor is required for this test');
}

const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

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

describe('syncInstalledFirstPartyShims Windows hard-link path', () => {
    it('prefers hard links for Windows shim installation', async () => {
        await withPlatform('win32', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-sync-shims-win32-link-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
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

                const result = await syncInstalledFirstPartyShims({
                    componentId: 'happier-cli',
                    processEnv: env,
                    channel: 'preview',
                    defaultReleaseChannelOverride: 'preview',
                });

                expect(result.shimPaths).toEqual([
                    join(homeDir, 'bin', 'happier.exe'),
                    join(homeDir, 'bin', 'hprev.exe'),
                ]);
                expect(await readFile(result.shimPaths[0]!, 'utf8')).toBe('preview-binary');
                expect(await readFile(result.shimPaths[1]!, 'utf8')).toBe('preview-binary');
                expect(statSync(result.shimPaths[0]!).nlink).toBeGreaterThan(1);
                expect(statSync(result.shimPaths[1]!).nlink).toBeGreaterThan(1);
            }
            finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    });
});
