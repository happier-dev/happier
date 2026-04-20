import { lstatSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

async function createPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const payloadRoot = join(rootDir, `payload-${versionId}`);
    await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
    await writeFile(join(payloadRoot, 'happier.exe'), contents, 'utf8');
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return payloadRoot;
}

describe('promoteVersionedPayload Windows junction pointer', () => {
    afterEach(() => {
        vi.resetModules();
    });

    it('uses a junction for the current payload pointer on Windows when the platform allows it', async () => {
        await withPlatform('win32', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-promote-versioned-payload-win32-junction-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const { promoteVersionedPayload, resolveInstalledFirstPartyComponentPaths } = await import('./index.js');

                await promoteVersionedPayload({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    processEnv: env,
                    versionId: '1.0.0-preview.1',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0-preview.1', 'preview-version'),
                });

                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    processEnv: env,
                });

                expect(lstatSync(paths.currentPath).isSymbolicLink()).toBe(true);
                expect(await readFile(paths.binaryPath, 'utf8')).toBe('preview-version');
            }
            finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 20000);
});
