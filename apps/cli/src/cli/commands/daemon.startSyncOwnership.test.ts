import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonRunningInspection } from '@/daemon/controlClient';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const { inspectDaemonMock, startDaemonMock } = vi.hoisted(() => ({
    inspectDaemonMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' })),
    startDaemonMock: vi.fn(async () => {}),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonMock,
    };
});

vi.mock('@/daemon/startDaemon', () => ({
    startDaemon: startDaemonMock,
}));

import { handleDaemonCliCommand } from './daemon';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('handleDaemonCliCommand: daemon start-sync', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_DAEMON_RUNTIME_ID',
    ]);

    afterEach(() => {
        envScope.restore();
        inspectDaemonMock.mockReset();
        inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' }));
        startDaemonMock.mockReset();
        vi.restoreAllMocks();
        vi.doUnmock('@/daemon/ownership/evaluateCurrentDaemonOwner');
        vi.resetModules();
    });

    it('fails closed when a different relay owner already owns the relay', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: '',
        });
        const conflictInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            },
        };
        inspectDaemonMock.mockResolvedValue(conflictInspection);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(handleDaemonCliCommand({
            args: ['daemon', 'start-sync'],
        } as never)).rejects.toThrow(/exit:1/);

        expect(startDaemonMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('already owns this relay');
    });

    it('tells start-sync callers to use the matching takeover command for a manual relay runtime', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: 'unknown',
        });
        const conflictInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-manual-conflict',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
            },
        };
        inspectDaemonMock.mockResolvedValue(conflictInspection);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        const output = captureConsoleText();

        try {
            await expect(handleDaemonCliCommand({
                args: ['daemon', 'start-sync'],
            } as never)).rejects.toThrow(/exit:1/);
        } finally {
            output.restore();
        }

        expect(startDaemonMock).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(output.text()).toContain('daemon start-sync --takeover');
        expect(output.text()).not.toContain('daemon start --takeover');
    });

    it('allows a stale manual relay owner to be replaced without requiring takeover', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
        });
        const conflictInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43112,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'manual',
                runtimeId: 'runtime-stale-manual',
            },
        };
        inspectDaemonMock.mockResolvedValue(conflictInspection);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(handleDaemonCliCommand({
                args: ['daemon', 'start-sync'],
            } as never)).rejects.toThrow(/exit:0/);
        } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
        }

        expect(startDaemonMock).toHaveBeenCalledWith({ takeover: false });
    });

    it('passes explicit plugin recovery to the synchronous daemon owner', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);

        try {
            await expect(handleDaemonCliCommand({
                args: ['daemon', 'start-sync', '--plugin-recovery'],
            } as never)).rejects.toThrow(/exit:0/);
        } finally {
            exitSpy.mockRestore();
        }

        expect(startDaemonMock).toHaveBeenCalledWith({
            takeover: false,
            pluginRecovery: true,
        });
    });

    it('does not short-circuit a self-restart replacement when the current daemon is compatible', async () => {
        envScope.patch({
            HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
            HAPPIER_DAEMON_RUNTIME_ID: 'runtime-compatible',
        });
        const compatibleInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: '0.2.8',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'manual',
                runtimeId: 'runtime-compatible',
            },
        };
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? ''}`);
        }) as never);
        vi.resetModules();
        vi.doMock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
            evaluateCurrentDaemonOwner: vi.fn(async () => ({
                kind: 'compatible' as const,
                owner: {
                    status: 'running' as const,
                    state: compatibleInspection.state,
                    currentCliVersion: '0.2.10',
                    currentPublicReleaseChannel: 'stable' as const,
                    versionMatches: true,
                    releaseChannelMatches: true,
                    serviceManaged: false,
                    startupSource: 'manual' as const,
                },
            })),
        }));
        const { handleDaemonCliCommand: handleDaemonCliCommandWithMockedOwnership } = await import('./daemon');

        try {
            await expect(handleDaemonCliCommandWithMockedOwnership({
                args: ['daemon', 'start-sync'],
            } as never)).rejects.toThrow(/exit:0/);
        } finally {
            exitSpy.mockRestore();
        }

        expect(startDaemonMock).toHaveBeenCalledTimes(1);
        expect(startDaemonMock).toHaveBeenCalledWith({ takeover: false });
    });
});
