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

const { symlinkFailurePlan } = vi.hoisted(() => ({
    symlinkFailurePlan: { enabled: false, throwAfter: 0, callCount: 0 },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();

    return {
        ...actual,
        symlink: vi.fn(async (...args: Parameters<typeof actual.symlink>) => {
            const shouldThrow = symlinkFailurePlan.enabled && symlinkFailurePlan.callCount >= symlinkFailurePlan.throwAfter;
            symlinkFailurePlan.callCount += 1;
            if (shouldThrow) {
                const error = new Error('EPERM: operation not permitted, symlink') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return await actual.symlink(...args);
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
    await writeFile(join(payloadRoot, 'happier'), contents, 'utf8');
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return payloadRoot;
}

describe('promoteVersionedPayload pointer swap atomicity', () => {
    it('fails closed without breaking the existing current pointer when symlink creation fails', async () => {
        await withPlatform('linux', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-promote-pointer-failure-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const { promoteVersionedPayload, resolveInstalledFirstPartyComponentPaths } = await import('./index.js');

                await promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '1.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0', 'first-version'),
                });

                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    processEnv: env,
                });

                expect(await readFile(paths.binaryPath, 'utf8')).toBe('first-version');
                expect(existsSync(paths.currentPath)).toBe(true);

                // Fail on the second symlink call (the current pointer swap), after the previous pointer sync succeeded.
                symlinkFailurePlan.enabled = true;
                symlinkFailurePlan.throwAfter = 1;
                symlinkFailurePlan.callCount = 0;
                await expect(promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '2.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '2.0.0', 'second-version'),
                })).rejects.toThrow(/symlink|eperm/i);

                expect(await readFile(paths.binaryPath, 'utf8')).toBe('first-version');
                expect(existsSync(paths.currentPath)).toBe(true);
            } finally {
                symlinkFailurePlan.enabled = false;
                symlinkFailurePlan.callCount = 0;
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);
});
