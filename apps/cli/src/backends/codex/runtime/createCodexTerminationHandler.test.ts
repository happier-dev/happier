import { describe, expect, it, vi } from 'vitest';

import { createCodexTerminationHandler } from './createCodexTerminationHandler';

describe('createCodexTerminationHandler', () => {
    it('archives the session, performs cleanup, and stops caffeinate for terminal terminations', async () => {
        const sequence: string[] = [];
        let shouldExit = false;

        const handleAbort = vi.fn(async () => {
            sequence.push('abort');
        });
        const archiveSession = vi.fn(async (archiveReason: string | null) => {
            sequence.push(`archive:${archiveReason ?? 'null'}`);
        });
        const cleanupRunResources = vi.fn(async () => {
            sequence.push('cleanup');
        });
        const stopCaffeinate = vi.fn(() => {
            sequence.push('stop');
        });
        const setShouldExit = vi.fn((value: boolean) => {
            shouldExit = value;
            sequence.push(`exit:${value}`);
        });

        const handleTerminate = createCodexTerminationHandler({
            startedBy: 'terminal',
            setShouldExit,
            handleAbort,
            archiveSession,
            cleanupRunResources,
            stopCaffeinate,
            logDebug: vi.fn(),
        });

        await handleTerminate(
            { kind: 'signal', signal: 'SIGTERM' },
            { exitCode: 0, archive: true, archiveReason: 'Signal SIGTERM' },
        );

        expect(shouldExit).toBe(true);
        expect(sequence).toEqual([
            'exit:true',
            'abort',
            'archive:Signal SIGTERM',
            'cleanup',
            'stop',
        ]);
        expect(archiveSession).toHaveBeenCalledWith('Signal SIGTERM');
        expect(cleanupRunResources).toHaveBeenCalledTimes(1);
        expect(stopCaffeinate).toHaveBeenCalledTimes(1);
    });

    it('skips archiving for daemon terminations but still aborts and cleans up', async () => {
        const sequence: string[] = [];
        let shouldExit = false;

        const handleAbort = vi.fn(async () => {
            sequence.push('abort');
        });
        const archiveSession = vi.fn(async (archiveReason: string | null) => {
            sequence.push(`archive:${archiveReason ?? 'null'}`);
        });
        const cleanupRunResources = vi.fn(async () => {
            sequence.push('cleanup');
        });
        const stopCaffeinate = vi.fn(() => {
            sequence.push('stop');
        });
        const setShouldExit = vi.fn((value: boolean) => {
            shouldExit = value;
            sequence.push(`exit:${value}`);
        });

        const handleTerminate = createCodexTerminationHandler({
            startedBy: 'daemon',
            setShouldExit,
            handleAbort,
            archiveSession,
            cleanupRunResources,
            stopCaffeinate,
            logDebug: vi.fn(),
        });

        await handleTerminate(
            { kind: 'signal', signal: 'SIGTERM' },
            { exitCode: 0, archive: true, archiveReason: 'Signal SIGTERM' },
        );

        expect(shouldExit).toBe(true);
        expect(sequence).toEqual([
            'exit:true',
            'abort',
            'cleanup',
            'stop',
        ]);
        expect(archiveSession).not.toHaveBeenCalled();
        expect(cleanupRunResources).toHaveBeenCalledTimes(1);
        expect(stopCaffeinate).toHaveBeenCalledTimes(1);
    });
});
