import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { promoteVersionedPayload } from '@happier-dev/cli-common/firstPartyRuntime';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type {
    InstalledDaemonServiceEntry,
    discoverInstalledDaemonServiceEntries,
} from '@/daemon/service/discoverInstalledDaemonServiceEntries';

const promptAnswers: string[] = [];

const { spawnHappyCLIMock, discoverInstalledDaemonServiceEntriesMock } = vi.hoisted(() => ({
    spawnHappyCLIMock: vi.fn(),
    discoverInstalledDaemonServiceEntriesMock: vi.fn<typeof discoverInstalledDaemonServiceEntries>(
        async () => [] as readonly InstalledDaemonServiceEntry[],
    ),
}));

vi.mock('node:readline', () => ({
    createInterface: () => ({
        question: (_prompt: string, cb: (answer: string) => void) => {
            cb(promptAnswers.shift() ?? '');
        },
        close: () => {},
    }),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: (...args: unknown[]) => spawnHappyCLIMock(...args),
}));

vi.mock('@/daemon/service/discoverInstalledDaemonServiceEntries', async () => {
    const actual = await vi.importActual<typeof import('@/daemon/service/discoverInstalledDaemonServiceEntries')>(
        '@/daemon/service/discoverInstalledDaemonServiceEntries',
    );
    return {
        ...actual,
        discoverInstalledDaemonServiceEntries: (
            ...args: Parameters<typeof actual.discoverInstalledDaemonServiceEntries>
        ) => discoverInstalledDaemonServiceEntriesMock(...args),
    };
});

const DAEMON_SERVICE_ENV_KEYS = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_PLATFORM',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
] as const;

function configureDaemonServiceDiscovery(homeDir: string) {
    const scope = createEnvKeyScope(DAEMON_SERVICE_ENV_KEYS);
    scope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
    });
    return scope;
}

function createInstalledDefaultFollowingService(
    mode: 'user' | 'system',
): InstalledDaemonServiceEntry {
    return {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: mode === 'system'
            ? '/etc/systemd/system/happier-daemon.default.service'
            : '/tmp/happier-daemon.default.service',
        platform: 'linux',
        mode,
        happierHomeDir: '/tmp/happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
    };
}

async function createStagedPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const stagedPayloadPath = join(rootDir, `stage-${versionId}`);
    await mkdir(stagedPayloadPath, { recursive: true });
    await mkdir(join(stagedPayloadPath, 'package-dist'), { recursive: true });
    await writeFile(join(stagedPayloadPath, 'happier'), contents, 'utf8');
    await writeFile(join(stagedPayloadPath, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return stagedPayloadPath;
}

function setTtyMode(stdinIsTTY: boolean, stdoutIsTTY: boolean): () => void {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutIsTTY });

    return () => {
        if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
        if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
        else delete (process.stdout as { isTTY?: boolean }).isTTY;
    };
}

function setProcessPlatform(platform: NodeJS.Platform): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    return () => {
        if (descriptor) Object.defineProperty(process, 'platform', descriptor);
    };
}

describe('happier self release-channel command', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        spawnHappyCLIMock.mockReset();
        discoverInstalledDaemonServiceEntriesMock.mockReset();
        discoverInstalledDaemonServiceEntriesMock.mockResolvedValue([]);
        promptAnswers.length = 0;
    });

    it('prints JSON status and list envelopes for the managed default release-channel inventory', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-json-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const previousArgv = [...process.argv];
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;

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

            output.logs.length = 0;
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'status', '--json'],
                rawArgv: ['happier', 'self', 'release-channel', 'status', '--json'],
                terminalRuntime: null,
            });
            const statusEnvelope = JSON.parse(output.logs.join('\n').trim());
            expect(statusEnvelope).toMatchObject({
                defaultReleaseChannel: 'preview',
                happierShimMatchesDefaultReleaseChannel: true,
                managedReleaseChannels: expect.arrayContaining([
                    expect.objectContaining({
                        releaseChannel: 'preview',
                        isDefault: true,
                    }),
                ]),
            });

            output.logs.length = 0;
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'list', '--json'],
                rawArgv: ['happier', 'self', 'release-channel', 'list', '--json'],
                terminalRuntime: null,
            });
            const listEnvelope = JSON.parse(output.logs.join('\n').trim());
            expect(listEnvelope).toMatchObject({
                defaultReleaseChannel: 'preview',
            });
            expect(listEnvelope.managedReleaseChannels).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    releaseChannel: 'stable',
                    version: '1.0.0',
                    isDefault: false,
                }),
                expect.objectContaining({
                    releaseChannel: 'preview',
                    version: '2.0.0',
                    isDefault: true,
                }),
            ]));
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            if (previousHome == null) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            process.argv = previousArgv;
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('does not fabricate a managed active invocation when the current process is running from an unmanaged source path', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-source-status-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const previousArgv = [...process.argv];
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;

        try {
            process.env.HAPPIER_HOME_DIR = homeDir;
            process.argv[1] = '/repo/apps/cli/dist/index.mjs';

            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: process.env,
                releaseRing: 'stable',
                versionId: '1.0.0',
                stagedPayloadPath: await createStagedPayload(homeDir, '1.0.0', 'stable-binary'),
            });

            const { handleSelfCliCommand } = await import('./self');
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'status', '--json'],
                rawArgv: ['node', 'apps/cli/dist/index.mjs', 'self', 'release-channel', 'status', '--json'],
                terminalRuntime: null,
            });

            const statusEnvelope = JSON.parse(output.logs.join('\n').trim());
            expect(statusEnvelope.activeInvocation).toBeNull();
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            if (previousHome == null) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            process.argv = previousArgv;
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('prompts to restart the default-following background service after switching the default release-channel', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-restart-'));
        const daemonServiceEnv = configureDaemonServiceDiscovery(homeDir);
        const previousArgv = [...process.argv];
        const restoreTty = setTtyMode(true, true);
        const restorePlatform = setProcessPlatform('linux');

        try {
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

            discoverInstalledDaemonServiceEntriesMock.mockImplementation(async (params) =>
                params.mode === 'user' ? [createInstalledDefaultFollowingService('user')] : [],
            );
            spawnHappyCLIMock.mockReturnValue({
                on: (event: string, cb: (value?: number) => void) => {
                    if (event === 'close') cb(0);
                    return undefined;
                },
            });
            promptAnswers.push('y');

            const { handleSelfCliCommand } = await import('./self');
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'use', 'preview'],
                rawArgv: ['happier', 'self', 'release-channel', 'use', 'preview'],
                terminalRuntime: null,
            });

            expect(spawnHappyCLIMock).toHaveBeenCalledWith(['service', 'restart'], expect.objectContaining({
                stdio: 'inherit',
            }));

            const defaultShimPath = join(homeDir, 'bin', process.platform === 'win32' ? 'happier.exe' : 'happier');
            expect(existsSync(defaultShimPath)).toBe(true);
            if (process.platform !== 'win32') {
                expect(lstatSync(defaultShimPath).isSymbolicLink()).toBe(true);
                expect(readlinkSync(defaultShimPath)).toMatch(/cli-preview\/current\/happier|..\/cli-preview\/current\/happier/);
            }
        } finally {
            restorePlatform();
            restoreTty();
            daemonServiceEnv.restore();
            process.argv = previousArgv;
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('prints manual restart guidance in non-interactive mode when a default-following background service exists', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-manual-followup-'));
        const daemonServiceEnv = configureDaemonServiceDiscovery(homeDir);
        const previousArgv = [...process.argv];
        const restoreTty = setTtyMode(false, false);
        const restorePlatform = setProcessPlatform('linux');
        const output = captureConsoleLogAndMuteStdout();

        try {
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

            discoverInstalledDaemonServiceEntriesMock.mockImplementation(async (params) =>
                params.mode === 'user' ? [createInstalledDefaultFollowingService('user')] : [],
            );

            const { handleSelfCliCommand } = await import('./self');
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'use', 'preview'],
                rawArgv: ['happier', 'self', 'release-channel', 'use', 'preview'],
                terminalRuntime: null,
            });

            expect(spawnHappyCLIMock).not.toHaveBeenCalled();
            const out = output.logs.join('\n');
            expect(out).toContain('Default release channel set to preview.');
            expect(out).toContain('happier service restart');
            expect(out).toContain('preview release-channel');
        } finally {
            output.restore();
            restorePlatform();
            restoreTty();
            daemonServiceEnv.restore();
            process.argv = previousArgv;
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('restarts the system-scoped default-following background service with --mode system', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-self-release-channel-system-restart-'));
        const daemonServiceEnv = configureDaemonServiceDiscovery(homeDir);
        const previousArgv = [...process.argv];
        const restoreTty = setTtyMode(true, true);
        const restorePlatform = setProcessPlatform('linux');

        try {
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

            discoverInstalledDaemonServiceEntriesMock.mockImplementation(async (params) =>
                params.mode === 'system' ? [createInstalledDefaultFollowingService('system')] : [],
            );
            spawnHappyCLIMock.mockReturnValue({
                on: (event: string, cb: (value?: number) => void) => {
                    if (event === 'close') cb(0);
                    return undefined;
                },
            });
            promptAnswers.push('y');

            const { handleSelfCliCommand } = await import('./self');
            await handleSelfCliCommand({
                args: ['self', 'release-channel', 'use', 'preview'],
                rawArgv: ['happier', 'self', 'release-channel', 'use', 'preview'],
                terminalRuntime: null,
            });

            expect(discoverInstalledDaemonServiceEntriesMock).toHaveBeenCalledWith(
                expect.objectContaining({ platform: 'linux', mode: 'system' }),
            );
            expect(spawnHappyCLIMock).toHaveBeenCalledWith(
                ['service', 'restart', '--mode', 'system'],
                expect.objectContaining({
                    stdio: 'inherit',
                }),
            );
        } finally {
            restorePlatform();
            restoreTty();
            daemonServiceEnv.restore();
            process.argv = previousArgv;
            await rm(homeDir, { recursive: true, force: true });
        }
    });
});
