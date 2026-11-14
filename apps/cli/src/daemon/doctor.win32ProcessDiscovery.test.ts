import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.fn();
const execFileSyncMock = vi.fn();
// Each queued entry is the stdout (or an Error) for the next Win32_Process query.
const windowsQueryResults: Array<string | Error> = [];
const execFileMock = vi.fn(
    (_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        const next = windowsQueryResults.length > 0 ? windowsQueryResults.shift()! : '';
        // Complete asynchronously, like a real child process.
        setTimeout(() => (next instanceof Error ? callback(next, '') : callback(null, next)), 0);
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

    it('queries Win32_Process asynchronously so the daemon event loop is never blocked', async () => {
        psListMock.mockResolvedValue([
            { pid: 17692, ppid: 1, name: 'happier.exe' },
            { pid: 26316, ppid: 17692, name: 'MainThread' },
        ]);
        windowsQueryResults.push(
            JSON.stringify({
                ProcessId: 26316,
                Name: 'MainThread',
                CommandLine: '"C:\happier\happier.exe" claude --happy-starting-mode remote --started-by daemon',
            }),
        );

        const { findAllHappyProcesses, findHappyProcessByPid } = await import('./doctor');
        await findAllHappyProcesses();
        await findHappyProcessByPid(26316);

        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(execFileMock).toHaveBeenCalled();
        for (const [file, args, options] of execFileMock.mock.calls) {
            expect(file).toBe('powershell.exe');
            expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']));
            expect(options).toEqual(expect.objectContaining({ windowsHide: true, timeout: expect.any(Number) }));
        }
    });

    it('treats a failed or timed-out Win32_Process query as no process info', async () => {
        windowsQueryResults.push(Object.assign(new Error('Command failed: powershell.exe (timed out)'), { killed: true }));

        const { findHappyProcessByPid } = await import('./doctor');

        await expect(findHappyProcessByPid(26316)).resolves.toBeNull();
    });
});
