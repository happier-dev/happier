import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import type { DaemonRunningInspection } from '@/daemon/controlClient';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const { inspectDaemonMock, stopDaemonMock, spawnDetachedMock, waitRunningMock } = vi.hoisted(() => ({
    inspectDaemonMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' })),
    stopDaemonMock: vi.fn(),
    spawnDetachedMock: vi.fn(async () => ({ unref: () => {} })),
    waitRunningMock: vi.fn(async () => true),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonMock,
        checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => false),
        listDaemonSessions: vi.fn(async () => []),
        stopDaemon: stopDaemonMock,
        stopDaemonSession: vi.fn(async () => false),
    };
});

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
    spawnDetachedDaemonStartSync: spawnDetachedMock,
}));

vi.mock('@/daemon/waitForDaemonRunningWithinBudget', () => ({
    waitForDaemonRunningWithinBudget: waitRunningMock,
}));

vi.mock('@/daemon/multiDaemon', () => ({
    listDaemonStatusesForAllKnownServers: vi.fn(async () => []),
    stopAllDaemonsBestEffort: vi.fn(async () => {}),
}));

import { handleDaemonCliCommand } from './daemon';

describe('handleDaemonCliCommand: daemon restart', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
    ]);

    afterEach(() => {
        envScope.restore();
        inspectDaemonMock.mockReset();
        inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' as const }));
        stopDaemonMock.mockReset();
        spawnDetachedMock.mockReset();
        waitRunningMock.mockReset();
        vi.restoreAllMocks();
    });

    it('stops and then starts the daemon', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: false });
        expect(spawnDetachedMock).toHaveBeenCalledTimes(1);
        expect(waitRunningMock).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('passes stopSessions when --kill-sessions is provided', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--kill-sessions'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('forwards takeover intent to restartDaemonAndWait when --takeover is provided', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--takeover'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(spawnDetachedMock).toHaveBeenCalledWith(expect.objectContaining({
            env: expect.objectContaining({
                HAPPIER_DAEMON_TAKEOVER: '1',
            }),
        }));
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('fails closed without --takeover when a manual relay runtime owns the relay', async () => {
        const runningInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual-restart',
            },
        };
        inspectDaemonMock.mockResolvedValue(runningInspection);

        const output = captureConsoleText();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).not.toHaveBeenCalled();
        expect(spawnDetachedMock).not.toHaveBeenCalled();
        expect(waitRunningMock).not.toHaveBeenCalled();
        expect(output.text()).toContain('manual relay runtime');
        expect(output.text()).toContain('daemon restart --takeover');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails closed when the current relay owner source is unknown', async () => {
        const runningInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
            },
        };
        inspectDaemonMock.mockResolvedValue(runningInspection);

        const output = captureConsoleLogAndMuteStdout();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart'],
                } as any),
            ).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).not.toHaveBeenCalled();
        expect(spawnDetachedMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('could not be determined safely');
    });

    it('prints a takeover notice before restarting when --takeover replaces a manual relay runtime', async () => {
        const runningInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual-restart',
            },
        };
        inspectDaemonMock.mockResolvedValue(runningInspection);

        const output = captureConsoleText();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as any);

        try {
            await expect(
                handleDaemonCliCommand({
                    args: ['daemon', 'restart', '--takeover'],
                } as any),
            ).rejects.toThrow(/exit:0/);
        } finally {
            output.restore();
        }

        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
        expect(spawnDetachedMock).toHaveBeenCalledWith(expect.objectContaining({
            env: expect.objectContaining({
                HAPPIER_DAEMON_TAKEOVER: '1',
            }),
        }));
        expect(waitRunningMock).toHaveBeenCalledTimes(1);
        expect(output.text()).toContain('Taking over the current manual relay runtime');
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('fails closed when a background service is already installed for the active relay', async () => {
        await withTempDir('happier-daemon-restart-service-installed-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ handleDaemonCliCommand }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
                import('./daemon'),
                import('@/daemon/service/cli'),
            ]);

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(
                paths.installedPath,
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            const output = captureConsoleText();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`exit:${code ?? ''}`);
            }) as any);

            try {
                await expect(
                    handleDaemonCliCommand({
                        args: ['daemon', 'restart'],
                    } as any),
                ).rejects.toThrow(/exit:1/);
            } finally {
                output.restore();
            }

            expect(stopDaemonMock).not.toHaveBeenCalled();
            expect(spawnDetachedMock).not.toHaveBeenCalled();
            expect(waitRunningMock).not.toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(output.text()).toContain('background service is already installed');
            expect(output.text()).toContain('happier service restart');
        });
    });
});
