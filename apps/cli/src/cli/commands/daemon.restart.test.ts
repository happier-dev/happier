import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const { stopDaemonMock, spawnDetachedMock, waitRunningMock } = vi.hoisted(() => ({
    stopDaemonMock: vi.fn(),
    spawnDetachedMock: vi.fn(async () => ({ unref: () => {} })),
    waitRunningMock: vi.fn(async () => true),
}));

vi.mock('@/daemon/controlClient', () => ({
    checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => false),
    listDaemonSessions: vi.fn(async () => []),
    stopDaemon: stopDaemonMock,
    stopDaemonSession: vi.fn(async () => false),
}));

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
    afterEach(() => {
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
});
