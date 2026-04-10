import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonRunningInspection } from '@/daemon/controlClient';

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
    afterEach(() => {
        inspectDaemonMock.mockReset();
        inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' }));
        startDaemonMock.mockReset();
        vi.restoreAllMocks();
    });

    it('fails closed when a different relay owner already owns the relay', async () => {
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
        const conflictInspection: DaemonRunningInspection = {
            status: 'running',
            state: {
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
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
});
