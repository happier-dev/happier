import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    promoteVersionedPayload,
    readDefaultManagedReleaseChannel,
    writeDefaultManagedReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';

async function createStagedPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const stagedPayloadPath = join(rootDir, `stage-${versionId}`);
    await mkdir(stagedPayloadPath, { recursive: true });
    await mkdir(join(stagedPayloadPath, 'package-dist'), { recursive: true });
    await writeFile(join(stagedPayloadPath, 'happier'), contents, 'utf8');
    await writeFile(join(stagedPayloadPath, 'happier.exe'), contents, 'utf8');
    await writeFile(join(stagedPayloadPath, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return stagedPayloadPath;
}

describe('happier self release-channel', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('switches the default managed release-channel and repoints the happier shim to the selected install', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-lane-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const previousArgv = [...process.argv];
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`process.exit(${code ?? 0})`);
        }) as never);

        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.argv[1] = join(homeDir, 'bin', 'happier');

            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: process.env,
                releaseRing: 'stable',
                versionId: '1.0.0',
                stagedPayloadPath: await createStagedPayload(homeDir, '1.0.0', 'stable-binary'),
            });
            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: process.env,
                releaseRing: 'preview',
                versionId: '2.0.0',
                stagedPayloadPath: await createStagedPayload(homeDir, '2.0.0', 'preview-binary'),
            });

            const { handleSelfCliCommand } = await import('./self');
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'use', 'preview'],
                rawArgv: ['happier', 'self', 'release-channel', 'use', 'preview'],
                terminalRuntime: null,
            });

            await expect(readDefaultManagedReleaseChannel({ processEnv: process.env })).resolves.toBe('preview');

            const defaultShimPath = join(homeDir, 'bin', process.platform === 'win32' ? 'happier.exe' : 'happier');
            expect(existsSync(defaultShimPath)).toBe(true);
            if (process.platform !== 'win32') {
                expect(lstatSync(defaultShimPath).isSymbolicLink()).toBe(true);
                expect(readlinkSync(defaultShimPath)).toMatch(/cli-preview\/current\/happier|..\/cli-preview\/current\/happier/);
            }
            expect(errorSpy).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            if (previousHome == null) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = previousHome;
            }
            process.argv = previousArgv;
            logSpy.mockRestore();
            errorSpy.mockRestore();
            exitSpy.mockRestore();
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('prints structured release-channel status with managed inventory and default shim alignment', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-status-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const previousPath = process.env.PATH;
        const previousArgv = [...process.argv];
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`process.exit(${code ?? 0})`);
        }) as never);

        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            const managedBinDir = join(homeDir, 'bin');
            process.env.PATH = managedBinDir;
            vi.resetModules();

            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: process.env,
                releaseRing: 'stable',
                versionId: '1.0.0',
                stagedPayloadPath: await createStagedPayload(homeDir, '1.0.0', 'stable-binary'),
            });
            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: process.env,
                releaseRing: 'preview',
                versionId: '2.0.0',
                stagedPayloadPath: await createStagedPayload(homeDir, '2.0.0', 'preview-binary'),
            });
            process.argv[1] = join(homeDir, 'bin', process.platform === 'win32' ? 'happier.exe' : 'happier');

            const { handleSelfCliCommand } = await import('./self');
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'use', 'preview'],
                rawArgv: ['happier', 'self', 'release-channel', 'use', 'preview'],
                terminalRuntime: null,
            });
            logSpy.mockClear();
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'status', '--json'],
                rawArgv: ['happier', 'self', 'release-channel', 'status', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(logSpy.mock.calls.map((call) => call.join(' ')).join('\n'));
            expect(parsed.defaultReleaseChannel).toBe('preview');
            expect(parsed.happierShimMatchesDefaultReleaseChannel).toBe(true);
            expect(parsed.managedReleaseChannels).toEqual([
                expect.objectContaining({
                    releaseChannel: 'stable',
                    label: 'stable',
                    version: '1.0.0',
                    isDefault: false,
                }),
                expect.objectContaining({
                    releaseChannel: 'preview',
                    label: 'preview',
                    version: '2.0.0',
                    isDefault: true,
                }),
            ]);
            expect(errorSpy).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            if (previousHome == null) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = previousHome;
            }
            if (previousPath == null) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
            process.argv = previousArgv;
            logSpy.mockRestore();
            errorSpy.mockRestore();
            exitSpy.mockRestore();
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('lists managed release channels and non-managed installs separately', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-list-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const previousPath = process.env.PATH;
        const previousArgv = [...process.argv];
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`process.exit(${code ?? 0})`);
        }) as never);

        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            const managedBinDir = join(homeDir, 'bin');
            const unmanagedBinDir = join(homeDir, 'other-bin');
            process.env.PATH = [managedBinDir, unmanagedBinDir].join(delimiter);
            vi.resetModules();

            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: process.env,
                releaseRing: 'stable',
                versionId: '1.0.0',
                stagedPayloadPath: await createStagedPayload(homeDir, '1.0.0', 'stable-binary'),
            });
            await writeDefaultManagedReleaseChannel({
                processEnv: process.env,
                releaseChannel: 'stable',
            });

            await mkdir(unmanagedBinDir, { recursive: true });
            const unmanagedBinaryPath = join(unmanagedBinDir, process.platform === 'win32' ? 'happier.exe' : 'happier');
            await writeFile(unmanagedBinaryPath, '#!/bin/sh\n', 'utf8');
            await chmod(unmanagedBinaryPath, 0o755);

            process.argv[1] = join(homeDir, 'bin', process.platform === 'win32' ? 'happier.exe' : 'happier');

            const { handleSelfCliCommand } = await import('./self');
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'list'],
                rawArgv: ['happier', 'self', 'release-channel', 'list'],
                terminalRuntime: null,
            });

            const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
            expect(output).toContain('Managed release channels');
            expect(output).toContain('stable');
            expect(output).toContain('Other Happier installs');
            expect(output).toContain(unmanagedBinaryPath);
            expect(errorSpy).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            if (previousHome == null) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = previousHome;
            }
            if (previousPath == null) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
            process.argv = previousArgv;
            logSpy.mockRestore();
            errorSpy.mockRestore();
            exitSpy.mockRestore();
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('treats a copied happier shim as aligned with the default managed release-channel on Windows', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-status-copy-'));
        const originalPlatform = process.platform;

        try {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            vi.resetModules();
            const shimPath = join(tempDir, 'happier.exe');
            const binaryPath = join(tempDir, 'current', 'happier.exe');
            await mkdir(join(tempDir, 'current'), { recursive: true });
            await writeFile(shimPath, 'preview-binary', 'utf8');
            await writeFile(binaryPath, 'preview-binary', 'utf8');

            const { areManagedShimAndBinaryAligned } = await import('./self/areManagedShimAndBinaryAligned');
            expect(areManagedShimAndBinaryAligned({
                shimPath,
                binaryPath,
                platform: 'win32',
            })).toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});
