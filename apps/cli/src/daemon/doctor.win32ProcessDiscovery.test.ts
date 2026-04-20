import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('ps-list', () => ({
    default: psListMock,
}));

vi.mock('node:child_process', () => ({
    execFileSync: execFileSyncMock,
}));

describe('doctor win32 process discovery', () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

    beforeEach(() => {
        vi.resetModules();
        psListMock.mockReset();
        execFileSyncMock.mockReset();
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
        execFileSyncMock.mockReturnValue(
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
        execFileSyncMock
            .mockReturnValueOnce('')
            .mockReturnValueOnce(
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
        execFileSyncMock.mockReturnValue(
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
});
