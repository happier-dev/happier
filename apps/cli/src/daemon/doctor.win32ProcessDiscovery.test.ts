import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const psListMock = vi.fn();
const execFileSyncMock = vi.fn();
// Each queued entry is the stdout (or an Error) for the next Win32_Process query.
const windowsQueryResults: Array<string | Error | { stdout: string; delayMs: number }> = [];
const execFileMock = vi.fn(
    (_file: string, _args: readonly string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string) => void) => {
        const next = windowsQueryResults.length > 0 ? windowsQueryResults.shift()! : '';
        // Model execFile's completion and timeout at the child-process boundary.
        const delayMs = typeof next === 'object' && !(next instanceof Error) ? next.delayMs : 0;
        const stdout = typeof next === 'string' ? next : next instanceof Error ? '' : next.stdout;
        const timedOut = Boolean(options.timeout && options.timeout < delayMs);
        setTimeout(
            () => timedOut ? callback(new Error('process query timed out'), '')
                : next instanceof Error ? callback(next, '') : callback(null, stdout),
            timedOut ? options.timeout : delayMs,
        );
        return {};
    },
);

vi.mock('ps-list', () => ({
    default: psListMock,
}));

vi.mock('node:child_process', () => ({
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
}));

describe('doctor win32 process discovery', () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

    beforeEach(() => {
        vi.resetModules();
        psListMock.mockReset();
        execFileSyncMock.mockReset();
        execFileMock.mockClear();
        windowsQueryResults.length = 0;
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
        }
    });

    afterEach(() => {
        vi.useRealTimers();
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    it('enriches generic MainThread candidates with Win32_Process command lines during startup discovery', async () => {
        psListMock.mockResolvedValue([
            { pid: 17692, ppid: 1, name: 'happier.exe' },
            { pid: 26316, ppid: 17692, name: 'MainThread' },
            { pid: 99999, ppid: 1, name: 'notepad.exe' },
        ]);
        windowsQueryResults.push(
            JSON.stringify([
                {
                    ProcessId: 17692,
                    Name: 'happier.exe',
                    CommandLine: '"C:\\hq\\windetachedfix-015\\happier-v0.2.4-windows-x64\\happier.exe" daemon start-sync',
                },
                {
                    ProcessId: 26316,
                    Name: 'MainThread',
                    CommandLine:
                        '"C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe" "C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs" opencode --happy-starting-mode remote --started-by daemon',
                },
            ]),
        );

        const { findAllHappyProcesses } = await import('./doctor');

        await expect(findAllHappyProcesses()).resolves.toEqual([
            {
                pid: 17692,
                command: '"C:\\hq\\windetachedfix-015\\happier-v0.2.4-windows-x64\\happier.exe" daemon start-sync',
                type: 'daemon',
            },
            {
                pid: 26316,
                command:
                    '"C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe" "C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs" opencode --happy-starting-mode remote --started-by daemon',
                type: 'daemon-spawned-session',
            },
        ]);
    });

    it('falls back to a broader Win32_Process snapshot when startup discovery still classifies zero Happy processes', async () => {
        psListMock.mockResolvedValue([
            { pid: 26316, ppid: 17692, name: 'MainThread' },
        ]);
        windowsQueryResults.push(
            '',
                JSON.stringify([
                    {
                        ProcessId: 17692,
                        Name: 'happier.exe',
                        CommandLine: '"C:\\hq\\windetachedfix-017\\happier-v0.2.4-windows-x64\\happier.exe" daemon start-sync',
                    },
                    {
                        ProcessId: 26316,
                        Name: 'happier.exe',
                        CommandLine:
                            '"C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe" "C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs" opencode --happy-starting-mode remote --started-by daemon',
                    },
                ]),
            );

        const { findAllHappyProcesses } = await import('./doctor');

        await expect(findAllHappyProcesses()).resolves.toEqual([
            {
                pid: 17692,
                command: '"C:\\hq\\windetachedfix-017\\happier-v0.2.4-windows-x64\\happier.exe" daemon start-sync',
                type: 'daemon',
            },
            {
                pid: 26316,
                command:
                    '"C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe" "C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs" opencode --happy-starting-mode remote --started-by daemon',
                type: 'daemon-spawned-session',
            },
        ]);
    });

    it('enriches single-pid inspection with Win32_Process command lines for PID safety', async () => {
        windowsQueryResults.push(
            JSON.stringify({
                ProcessId: 26316,
                Name: 'MainThread',
                CommandLine:
                    '"C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe" "C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs" opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
            }),
        );

        const { findHappyProcessByPid } = await import('./doctor');

        await expect(findHappyProcessByPid(26316)).resolves.toEqual({
            pid: 26316,
            command:
                '"C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe" "C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs" opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
            type: 'daemon-spawned-session',
        });
    });

    it.each(['pid', 'filtered', 'all'] as const)(
        'keeps the event loop responsive and accepts a slow successful %s query',
        async (query) => {
            vi.useFakeTimers();
            const command = String.raw`"C:\happier\happier.exe" "C:\happier\package-dist\index.mjs" claude --started-by daemon`;
            psListMock.mockResolvedValue(query === 'filtered' ? [{ pid: 26316, name: 'MainThread' }] : []);
            windowsQueryResults.push({
                stdout: JSON.stringify({ ProcessId: 26316, Name: 'MainThread', CommandLine: command }),
                // Valid work past the PR's former arbitrary 60-second cutoff.
                delayMs: 65_000,
            });
            const { readProcessInfoByPid, findAllHappyProcesses } = await import('./doctor');
            const pending = query === 'pid' ? readProcessInfoByPid(26316) : findAllHappyProcesses();
            await vi.advanceTimersByTimeAsync(0);
            let completed = false;
            void pending.then(() => { completed = true; });
            let heartbeat = false;
            setTimeout(() => { heartbeat = true; }, 1);

            await vi.advanceTimersByTimeAsync(61_000);
            expect(heartbeat).toBe(true);
            expect(completed).toBe(false);
            await vi.advanceTimersByTimeAsync(4_000);

            if (query === 'pid') {
                await expect(pending).resolves.toMatchObject({ pid: 26316, cmd: command });
            } else {
                await expect(pending).resolves.toEqual([
                    { pid: 26316, command, type: 'daemon-spawned-session' },
                ]);
            }
            expect(execFileSyncMock).not.toHaveBeenCalled();
        },
    );

    it.each(['pid', 'filtered', 'all'] as const)(
        'reports failed %s queries without process information and permits recovery',
        async (query) => {
            psListMock.mockResolvedValue(query === 'filtered' ? [{ pid: 26316, name: 'MainThread' }] : []);
            windowsQueryResults.push(new Error('process query failed'));
            const { readProcessInfoByPid, findAllHappyProcesses } = await import('./doctor');
            const { logger } = await import('@/ui/logger');
            logger.flushSync();
            const previousLog = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
            const pending = query === 'pid' ? readProcessInfoByPid(26316) : findAllHappyProcesses();
            await expect(pending).resolves.toEqual(query === 'pid' ? null : []);
            logger.flushSync();
            const log = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
            expect(log.slice(previousLog.length)).toContain('Windows process query failed');

            const command = String.raw`"C:\happier\happier.exe" "C:\happier\package-dist\index.mjs" claude --started-by daemon`;
            windowsQueryResults.push(JSON.stringify({ ProcessId: 26316, Name: 'MainThread', CommandLine: command }));
            if (query === 'pid') {
                await expect(readProcessInfoByPid(26316)).resolves.toMatchObject({ pid: 26316, cmd: command });
            } else {
                await expect(findAllHappyProcesses()).resolves.toEqual([
                    { pid: 26316, command, type: 'daemon-spawned-session' },
                ]);
            }
        },
    );
});
