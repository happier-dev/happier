import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
    execFileSync: execFileSyncMock,
}));

describe('resolveOpenCodeManagedServerTrackedPid', () => {
    afterEach(() => {
        execFileSyncMock.mockReset();
    });

    it('returns the listening child pid for Windows cmd.exe wrapper launches', async () => {
        execFileSyncMock.mockImplementation((command: string) => {
            if (command === 'netstat') {
                return [
                    '  TCP    127.0.0.1:43111    0.0.0.0:0    LISTENING    48123',
                    '  TCP    127.0.0.1:9999     0.0.0.0:0    LISTENING    99999',
                ].join('\n');
            }
            return JSON.stringify([{ ProcessId: 48123, ParentProcessId: 43111 }]);
        });

        const { resolveOpenCodeManagedServerTrackedPid } = await import('./resolveOpenCodeManagedServerTrackedPid');
        await expect(resolveOpenCodeManagedServerTrackedPid({
            spawnPid: 43111,
            baseUrl: 'http://127.0.0.1:43111',
            invocationCommand: 'C:\\Windows\\System32\\cmd.exe',
        })).resolves.toBe(48123);

        expect(execFileSyncMock).toHaveBeenCalledWith(
            'netstat',
            ['-ano', '-p', 'tcp'],
            expect.objectContaining({
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }),
        );
        expect(execFileSyncMock).toHaveBeenCalledWith(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                expect.stringContaining('Get-CimInstance Win32_Process'),
            ],
            expect.objectContaining({
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }),
        );
    });

    it('returns the spawned pid when the managed server launch is not wrapped by cmd.exe', async () => {
        const { resolveOpenCodeManagedServerTrackedPid } = await import('./resolveOpenCodeManagedServerTrackedPid');
        await expect(resolveOpenCodeManagedServerTrackedPid({
            spawnPid: 43111,
            baseUrl: 'http://127.0.0.1:43111',
            invocationCommand: 'C:\\tools\\opencode.exe',
        })).resolves.toBe(43111);

        expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('matches the exact listening port instead of substring-matching longer ports', async () => {
        execFileSyncMock.mockImplementation((command: string) => {
            if (command === 'netstat') {
                return [
                    '  TCP    127.0.0.1:43110    0.0.0.0:0    LISTENING    99999',
                    '  TCP    127.0.0.1:4311     0.0.0.0:0    LISTENING    48123',
                ].join('\n');
            }
            return JSON.stringify([
                { ProcessId: 48123, ParentProcessId: 9000 },
                { ProcessId: 9000, ParentProcessId: 4311 },
            ]);
        });

        const { resolveOpenCodeManagedServerTrackedPid } = await import('./resolveOpenCodeManagedServerTrackedPid');
        await expect(resolveOpenCodeManagedServerTrackedPid({
            spawnPid: 4311,
            baseUrl: 'http://127.0.0.1:4311',
            invocationCommand: 'C:\\Windows\\System32\\cmd.exe',
        })).resolves.toBe(48123);
    });

    it('keeps the spawned pid when the listener pid is not in the spawned process tree', async () => {
        execFileSyncMock.mockImplementation((command: string) => {
            if (command === 'netstat') {
                return '  TCP    127.0.0.1:43111    0.0.0.0:0    LISTENING    48123';
            }
            return JSON.stringify([
                { ProcessId: 48123, ParentProcessId: 99999 },
                { ProcessId: 99999, ParentProcessId: 4 },
            ]);
        });

        const { resolveOpenCodeManagedServerTrackedPid } = await import('./resolveOpenCodeManagedServerTrackedPid');
        await expect(resolveOpenCodeManagedServerTrackedPid({
            spawnPid: 43111,
            baseUrl: 'http://127.0.0.1:43111',
            invocationCommand: 'C:\\Windows\\System32\\cmd.exe',
        })).resolves.toBe(43111);
    });
});
