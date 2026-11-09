import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { installLocalServiceCensusFixture, localServiceProcfsFixture } from './inventory/platform/censusFixture.testkit';
import { createLocalServicesDaemonRuntime } from './runtime';
import { createLocalServiceEndpointEnricher } from './inventory/endpoint';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFile: execFileMock,
    };
});
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
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
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.resetModules();
    });

    it.each([
        ['/proc/net/tcp', 'EACCES'],
        ['/proc/net/tcp6', 'EIO'],
        ['both', 'EACCES'],
    ])('retains prior inventory when Linux socket table %s fails with %s, but accepts a valid empty scan', async (failedTable, code) => {
        const restorePlatform = mockProcessPlatform('linux');
        const processes = [{ pid: 321, command: ['node', 'vite'], cwd: '/repo/web' }];
        installLocalServiceCensusFixture(processes);
        const census = localServiceProcfsFixture(processes);
        const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
        const tcp = `${header}\n0: 0100007F:1435 00000000:0000 0A 0 0 0 501 0 12345`;
        let scan: 'listening' | 'failed' | 'empty' = 'listening';
        vi.mocked(fs.readFile).mockImplementation(async path => {
            const name = String(path);
            if (name === '/proc/net/tcp' || name === '/proc/net/tcp6') {
                if (scan === 'failed' && (failedTable === 'both' || failedTable === name)) {
                    throw Object.assign(new Error('Socket table unavailable'), { code });
                }
                return name.endsWith('/tcp') && scan !== 'empty' ? tcp : header;
            }
            return census.readFile(name);
        });
        vi.mocked(fs.readdir).mockImplementation(async path => (String(path) === '/proc' ? ['321'] : ['3']) as never);
        vi.mocked(fs.readlink).mockImplementation(async path => String(path).includes('/fd/') ? 'socket:[12345]' : census.readlink(String(path)));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-linux', startLoop: false,
            inventoryEnabled: () => true, workspaceFacts: () => [],
            endpointEnricher: createLocalServiceEndpointEnricher({ now: Date.now, probe: async () => true }) });
        try {
            const prior = await runtime.refreshInventoryNow();
            expect(prior.entries).toHaveLength(1);
            expect(prior.entries[0]).toMatchObject({ port: 5173, state: 'listening' });
            scan = 'failed';
            const failed = await runtime.refreshInventoryNow();
            expect(failed).toMatchObject({ refreshState: 'error', entries: prior.entries,
                diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'linux_procfs_scan_failed' })]) });
            scan = 'empty';
            const empty = await runtime.refreshInventoryNow();
            expect(empty.refreshState).toBe('idle');
            expect(empty.diagnostics).toEqual([]);
            expect(empty.entries.every(entry => entry.state !== 'listening')).toBe(true);
        } finally {
            await runtime.stop();
            restorePlatform();
        }
    });

    it('opens no listener owners for passive summaries and fully attributes an actual inventory reader', async () => {
        vi.useFakeTimers();
        const restorePlatform = mockProcessPlatform('linux');
        const processes = [
            { pid: 100, command: ['happier', 'daemon'] },
            { pid: 321, command: ['node', 'vite'], cwd: '/repo/web' },
        ];
        installLocalServiceCensusFixture(processes);
        const census = localServiceProcfsFixture(processes);
        const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
        const tcp = [header,
            '0: 0100007F:1435 00000000:0000 0A 0 0 0 501 0 12345',
            '1: 0100007F:1F91 00000000:0000 0A 0 0 0 501 0 99999',
        ].join('\n');
        vi.mocked(fs.readFile).mockImplementation(async path => String(path) === '/proc/net/tcp6' ? header
            : String(path) === '/proc/net/tcp' ? tcp : census.readFile(String(path)));
        const openedFdOwners: string[] = [];
        vi.mocked(fs.readdir).mockImplementation(async path => {
            const name = String(path);
            if (name === '/proc') return ['100', '321', '777', String(process.pid)] as never;
            openedFdOwners.push(name);
            return ['3'] as never;
        });
        vi.mocked(fs.readlink).mockImplementation(async path => {
            const name = String(path);
            if (name === '/proc/100/fd/3') {
                return 'socket:[99999]';
            }
            if (name === '/proc/321/fd/3') return 'socket:[12345]';
            return name.includes('/fd/') ? '/dev/null' : census.readlink(name);
        });
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', inventoryEnabled: () => true, internalProcessPids: () => [100],
            workspaceFacts: () => [], refreshIntervalMs: 1_000,
            endpointEnricher: createLocalServiceEndpointEnricher({ now: Date.now, probe: async () => true }),
        });
        const unsubscribe = runtime.subscribeSummary(() => {});
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            expect(runtime.getSummary()).toEqual({ v: 1, state: 'unknown' });
            expect(openedFdOwners).toEqual([]);
            expect(runtime.inventoryRegistry.getSnapshot().generatedAt).toBe(0);
            const snapshot = await runtime.inventoryRoutes.getSnapshot();
            expect(snapshot.entries.find(entry => entry.port === 5173)?.provenance?.process)
                .toMatchObject({ pid: 321, cwd: '/repo/web' });
            expect(snapshot.entries.find(entry => entry.port === 8081)).toBeUndefined();
            expect(openedFdOwners).toContain('/proc/321/fd');
            expect(runtime.getSummary()).toEqual({ v: 1, state: 'ready', runningCount: 1 });
            unsubscribe();
            openedFdOwners.length = 0;
            await vi.advanceTimersByTimeAsync(3_000);
            expect(openedFdOwners).toEqual([]);
        } finally {
            unsubscribe();
            await runtime.stop();
            restorePlatform();
        }
    });

    it('uses the Windows platform scanner for win32 default inventory refreshes', async () => {
        // The Windows socket adapter consumes the one census rather than its retired
        // PowerShell seed walker; procfs is the genuine process-table boundary fixture.
        installLocalServiceCensusFixture([{ pid: 1234, ppid: 100, command: ['npm', 'run', 'dev'] }, { pid: 100 }]);
        const restorePlatform = mockProcessPlatform('win32');
        execFileMock.mockImplementation((
            command: string,
            _args: readonly string[],
            _options: Readonly<{ maxBuffer: number }>,
            callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
            // The real execFile boundary returns a child before asynchronously delivering output
            // and close; the deadline adapter waits for both the callback and that close event.
            const child = new ChildProcess();
            const complete = (error: Error | null, stdout: string) => {
                queueMicrotask(() => {
                    Object.defineProperty(child, 'exitCode', { configurable: true, value: error ? 1 : 0 });
                    child.emit('exit', child.exitCode, null);
                    callback(error, stdout, '');
                    child.emit('close', child.exitCode, null);
                });
                return child;
            };
            if (command === 'netstat.exe') {
                return complete(null, [
                    '  Proto  Local Address          Foreign Address        State           PID',
                    '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234',
                ].join('\r\n'));
            }
            return complete(new Error(`unexpected command ${command}`), '');
        });

        try {
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
                id: 'machine-win:tcp:loopback:127.0.0.1:5173:pid-1234:start-123450',
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
            // No `timeout` is handed to Node: its timeout kill destroys the child's stdout from the
            // timers phase and still reports success, so a scan cut short by a stalled event loop
            // would arrive as an authoritative empty listing. The scan boundary owns the deadline.
            expect(execFileMock).toHaveBeenCalledWith('netstat.exe', ['-ano', '-p', 'tcp'], expect.objectContaining({
                maxBuffer: 1024 * 1024,
            }), expect.any(Function));
            expect(execFileMock.mock.calls[0]?.[2]).not.toHaveProperty('timeout');
        } finally {
            restorePlatform();
        }
    });
});
