import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor is required for this test');
}
const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

const { markerFailurePlan, symlinkFailurePlan } = vi.hoisted(() => ({
    markerFailurePlan: { enabled: false, markerName: '', partialContents: null as string | null, callCount: 0 },
    symlinkFailurePlan: { enabled: false, throwAfter: 0, failuresRemaining: 0, callCount: 0 },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();

    return {
        ...actual,
        symlink: vi.fn(async (...args: Parameters<typeof actual.symlink>) => {
            const shouldThrow = symlinkFailurePlan.enabled
                && symlinkFailurePlan.failuresRemaining > 0
                && symlinkFailurePlan.callCount >= symlinkFailurePlan.throwAfter;
            symlinkFailurePlan.callCount += 1;
            if (shouldThrow) {
                symlinkFailurePlan.failuresRemaining -= 1;
                const error = new Error('EPERM: operation not permitted, symlink') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return await actual.symlink(...args);
        }),
        writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
            const targetPath = String(args[0]);
            if (
                markerFailurePlan.enabled
                && targetPath.includes(markerFailurePlan.markerName)
                && markerFailurePlan.callCount === 0
            ) {
                markerFailurePlan.callCount += 1;
                if (markerFailurePlan.partialContents !== null) {
                    await actual.writeFile(args[0], markerFailurePlan.partialContents, 'utf8');
                }
                const error = new Error(`EIO: mocked marker write failure for '${targetPath}'`) as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            }
            return await actual.writeFile(...args);
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
    await writeFile(join(payloadRoot, 'happier.exe'), contents, 'utf8');
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
                symlinkFailurePlan.failuresRemaining = 1;
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
                symlinkFailurePlan.failuresRemaining = 0;
                symlinkFailurePlan.callCount = 0;
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);

    it.each(['linux', 'win32'] as const)(
        'restores the complete A state on %s when the current marker write fails after the pointer swap',
        async (platform) => {
            await withPlatform(platform, async () => {
                const homeDir = await mkdtemp(join(tmpdir(), `happier-promote-marker-failure-${platform}-`));
                const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

                try {
                    const {
                        promoteVersionedPayload,
                        resolveInstalledFirstPartyComponentPaths,
                    } = await import('./index.js');

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
                    markerFailurePlan.enabled = true;
                    markerFailurePlan.markerName = 'current.version';
                    markerFailurePlan.callCount = 0;

                    await expect(promoteVersionedPayload({
                        componentId: 'happier-cli',
                        processEnv: env,
                        versionId: '2.0.0',
                        stagedPayloadPath: await createPayload(homeDir, '2.0.0', 'second-version'),
                    })).rejects.toThrow(/marker write failure/i);

                    expect(await readFile(paths.binaryPath, 'utf8')).toBe('first-version');
                    expect(await readFile(join(paths.installRoot, 'current.version'), 'utf8')).toBe('1.0.0\n');
                    expect(await readlink(paths.currentPath)).toBe(
                        platform === 'win32'
                            ? join(paths.versionsDir, '1.0.0')
                            : 'versions/1.0.0',
                    );
                    await expect(lstat(paths.previousPath)).rejects.toMatchObject({ code: 'ENOENT' });
                    await expect(lstat(join(paths.installRoot, 'previous.version'))).rejects.toMatchObject({ code: 'ENOENT' });
                } finally {
                    markerFailurePlan.enabled = false;
                    markerFailurePlan.markerName = '';
                    markerFailurePlan.partialContents = null;
                    markerFailurePlan.callCount = 0;
                    await rm(homeDir, { recursive: true, force: true });
                }
            });
        },
        60_000,
    );

    it('leaves no published current payload when an initial promotion cannot publish its marker', async () => {
        await withPlatform('linux', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-initial-promotion-marker-failure-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const {
                    promoteVersionedPayload,
                    resolveInstalledFirstPartyComponentPaths,
                } = await import('./index.js');
                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    processEnv: env,
                });
                markerFailurePlan.enabled = true;
                markerFailurePlan.markerName = 'current.version';
                markerFailurePlan.callCount = 0;

                await expect(promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '1.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0', 'first-version'),
                })).rejects.toThrow(/marker write failure/i);

                await expect(lstat(paths.currentPath)).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(lstat(join(paths.installRoot, 'current.version'))).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(lstat(paths.previousPath)).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(lstat(join(paths.installRoot, 'previous.version'))).rejects.toMatchObject({ code: 'ENOENT' });
            } finally {
                markerFailurePlan.enabled = false;
                markerFailurePlan.markerName = '';
                markerFailurePlan.partialContents = null;
                markerFailurePlan.callCount = 0;
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);

    it('restores an unversioned legacy current payload when promotion cannot publish its marker', async () => {
        await withPlatform('linux', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-legacy-promotion-marker-failure-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const {
                    promoteVersionedPayload,
                    resolveInstalledFirstPartyComponentPaths,
                } = await import('./index.js');
                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    processEnv: env,
                });
                await mkdir(paths.currentPath, { recursive: true });
                await writeFile(join(paths.currentPath, 'happier'), 'legacy-version', 'utf8');

                markerFailurePlan.enabled = true;
                markerFailurePlan.markerName = 'current.version';
                markerFailurePlan.callCount = 0;

                await expect(promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '1.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0', 'first-version'),
                })).rejects.toThrow(/marker write failure/i);

                expect(await readFile(join(paths.currentPath, 'happier'), 'utf8')).toBe('legacy-version');
                await expect(lstat(join(paths.installRoot, 'current.version'))).rejects.toMatchObject({ code: 'ENOENT' });
                expect((await lstat(paths.currentPath)).isDirectory()).toBe(true);
            } finally {
                markerFailurePlan.enabled = false;
                markerFailurePlan.markerName = '';
                markerFailurePlan.partialContents = null;
                markerFailurePlan.callCount = 0;
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);

    it('rejects unsafe public version ids before filesystem mutation', async () => {
        await withPlatform('linux', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-unsafe-version-id-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const {
                    promoteVersionedPayload,
                    resolveFirstPartyVersionInstallPath,
                } = await import('./index.js');
                for (const versionId of [
                    '../escape',
                    '..\\escape',
                    'nested/version',
                    'nested\\version',
                    '/absolute',
                    'C:\\absolute',
                    '.',
                    '..',
                ]) {
                    expect(() => resolveFirstPartyVersionInstallPath({
                        componentId: 'happier-cli',
                        processEnv: env,
                        versionId,
                    })).toThrow(expect.objectContaining({
                        code: 'FIRST_PARTY_VERSION_ID_INVALID',
                    }));
                }

                await expect(promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '../escape',
                    stagedPayloadPath: await createPayload(homeDir, 'unsafe', 'unsafe-version'),
                })).rejects.toMatchObject({
                    code: 'FIRST_PARTY_VERSION_ID_INVALID',
                });
            } finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);

    it('rejects different bytes for an already-installed immutable version id before publication', async () => {
        await withPlatform('linux', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-version-id-conflict-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const {
                    promoteVersionedPayload,
                    resolveInstalledFirstPartyComponentPaths,
                } = await import('./index.js');
                await promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '1.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0-first', 'first-version'),
                });
                const paths = resolveInstalledFirstPartyComponentPaths({
                    componentId: 'happier-cli',
                    processEnv: env,
                });

                await expect(promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '1.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0-conflict', 'different-version'),
                })).rejects.toMatchObject({
                    code: 'FIRST_PARTY_VERSION_ID_CONFLICT',
                });
                expect(await readFile(paths.binaryPath, 'utf8')).toBe('first-version');
                expect(await readFile(join(paths.versionsDir, '1.0.0', 'happier'), 'utf8')).toBe('first-version');

                await expect(promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '1.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0-first', 'first-version'),
                })).resolves.toMatchObject({
                    currentVersionId: '1.0.0',
                });
                expect(await readFile(paths.binaryPath, 'utf8')).toBe('first-version');
            } finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);

    it('reports an incomplete state restoration when the rollback path also fails', async () => {
        await withPlatform('linux', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-promotion-restore-failure-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const { promoteVersionedPayload } = await import('./index.js');

                await promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '1.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '1.0.0', 'first-version'),
                });

                markerFailurePlan.enabled = true;
                markerFailurePlan.markerName = 'current.version';
                markerFailurePlan.callCount = 0;
                // Previous and current pointer publication succeed; restoring current then fails.
                symlinkFailurePlan.enabled = true;
                symlinkFailurePlan.throwAfter = 2;
                symlinkFailurePlan.failuresRemaining = 1;
                symlinkFailurePlan.callCount = 0;

                await expect(promoteVersionedPayload({
                    componentId: 'happier-cli',
                    processEnv: env,
                    versionId: '2.0.0',
                    stagedPayloadPath: await createPayload(homeDir, '2.0.0', 'second-version'),
                })).rejects.toMatchObject({
                    code: 'FIRST_PARTY_PAYLOAD_STATE_RESTORE_INCOMPLETE',
                    stateRestored: false,
                });
            } finally {
                markerFailurePlan.enabled = false;
                markerFailurePlan.markerName = '';
                markerFailurePlan.partialContents = null;
                markerFailurePlan.callCount = 0;
                symlinkFailurePlan.enabled = false;
                symlinkFailurePlan.failuresRemaining = 0;
                symlinkFailurePlan.callCount = 0;
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);

    it('keeps the published marker intact when its next write fails partway through', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-version-marker-atomic-write-'));
        const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

        try {
            const {
                resolveFirstPartyInstallLayout,
                writeInstalledVersionMarker,
            } = await import('./index.js');
            const layout = resolveFirstPartyInstallLayout({
                componentId: 'happier-cli',
                processEnv: env,
            });
            await mkdir(layout.installRoot, { recursive: true });
            await writeInstalledVersionMarker({
                layout,
                marker: 'current',
                versionId: '1.0.0',
            });

            markerFailurePlan.enabled = true;
            markerFailurePlan.markerName = 'current.version';
            markerFailurePlan.partialContents = '2.0';
            markerFailurePlan.callCount = 0;

            await expect(writeInstalledVersionMarker({
                layout,
                marker: 'current',
                versionId: '2.0.0',
            })).rejects.toThrow(/marker write failure/i);
            expect(await readFile(join(layout.installRoot, 'current.version'), 'utf8')).toBe('1.0.0\n');
        } finally {
            markerFailurePlan.enabled = false;
            markerFailurePlan.markerName = '';
            markerFailurePlan.partialContents = null;
            markerFailurePlan.callCount = 0;
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('keeps the pointer and marker coherent across concurrent promotion attempts', async () => {
        await withPlatform('linux', async () => {
            const homeDir = await mkdtemp(join(tmpdir(), 'happier-concurrent-promotion-'));
            const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

            try {
                const {
                    promoteVersionedPayload,
                    resolveInstalledFirstPartyComponentPaths,
                } = await import('./index.js');
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
                for (let round = 0; round < 12; round += 1) {
                    const leftVersion = `2.0.${round * 2}`;
                    const rightVersion = `2.0.${round * 2 + 1}`;
                    const leftPayload = await createPayload(homeDir, leftVersion, leftVersion);
                    const rightPayload = await createPayload(homeDir, rightVersion, rightVersion);
                    const results = await Promise.allSettled([
                        promoteVersionedPayload({
                            componentId: 'happier-cli',
                            processEnv: env,
                            versionId: leftVersion,
                            stagedPayloadPath: leftPayload,
                        }),
                        promoteVersionedPayload({
                            componentId: 'happier-cli',
                            processEnv: env,
                            versionId: rightVersion,
                            stagedPayloadPath: rightPayload,
                        }),
                    ]);
                    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

                    const currentMarker = (await readFile(
                        join(paths.installRoot, 'current.version'),
                        'utf8',
                    )).trim();
                    expect(await readlink(paths.currentPath)).toBe(`versions/${currentMarker}`);
                    expect(await readFile(paths.binaryPath, 'utf8')).toBe(currentMarker);
                }
            } finally {
                await rm(homeDir, { recursive: true, force: true });
            }
        });
    }, 60_000);
});
