import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFile: execFileMock,
    };
});

function mockProcessPlatform(platform: NodeJS.Platform): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
    return () => {
        if (descriptor) {
            Object.defineProperty(process, 'platform', descriptor);
        }
    };
}

describe('createLocalServicesDaemonRuntime platform scanner dispatch', () => {
    afterEach(() => {
        execFileMock.mockReset();
        vi.resetModules();
    });

    it('uses the Windows platform scanner for win32 default inventory refreshes', async () => {
        const restorePlatform = mockProcessPlatform('win32');
        execFileMock.mockImplementation((
            command: string,
            _args: readonly string[],
            _options: Readonly<{ timeout: number; maxBuffer: number }>,
            callback: (error: Error | null, result: Readonly<{ stdout: string }>) => void,
        ) => {
            if (command === 'netstat.exe') {
                callback(null, {
                    stdout: [
                        '  Proto  Local Address          Foreign Address        State           PID',
                        '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234',
                    ].join('\r\n'),
                });
                return;
            }
            if (command === 'powershell.exe') {
                callback(null, {
                    stdout: JSON.stringify([{
                        ProcessId: 1234,
                        ParentProcessId: 100,
                        CommandLine: 'npm run dev',
                        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
                    }]),
                });
                return;
            }
            callback(new Error(`unexpected command ${command}`), { stdout: '' });
        });

        try {
            const { createLocalServicesDaemonRuntime } = await import('./runtime');
            const runtime = createLocalServicesDaemonRuntime({
                machineId: 'machine-win',
                inventoryEnabled: () => true,
                workspaceFacts: () => [],
                now: () => 2_000,
                startLoop: false,
            });

            const snapshot = await runtime.refreshInventoryNow();

            expect(snapshot.diagnostics).toEqual([]);
            expect(snapshot.entries[0]).toMatchObject({
                id: 'machine-win:tcp:loopback:127.0.0.1:5173:pid-1234:start-unknown',
                state: 'listening',
                provenance: {
                    process: {
                        pid: 1234,
                        ppid: 100,
                        command: 'npm run dev',
                        redacted: true,
                    },
                },
            });
            expect(execFileMock).toHaveBeenCalledWith('netstat.exe', ['-ano', '-p', 'tcp'], {
                timeout: 2_000,
                maxBuffer: 1024 * 1024,
            }, expect.any(Function));
        } finally {
            restorePlatform();
        }
    });
});
