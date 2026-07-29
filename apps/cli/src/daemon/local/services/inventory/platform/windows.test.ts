import { describe, expect, it, vi } from 'vitest';

import { normalizeLocalServiceScan } from '../scanner';
import { createTerminalProcessRegistry } from '../terminalRegistry';
import {
    parseWindowsNetstatTcpListeners,
    parseWindowsProcessFactsJson,
    readWindowsLocalServiceListeners,
    readWindowsProcessFacts,
} from './windows';

describe('parseWindowsNetstatTcpListeners', () => {
    it('parses only TCP listening sockets from netstat output', () => {
        const listeners = parseWindowsNetstatTcpListeners([
            '  Proto  Local Address          Foreign Address        State           PID',
            '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234',
            '  TCP    [::1]:8081             [::]:0                 LISTENING       4321',
            '  TCP    0.0.0.0:3000           0.0.0.0:0              ESTABLISHED     9999',
            '  UDP    127.0.0.1:1900         *:*                                    7777',
            '  TCP    192.168.1.10:5174      0.0.0.0:0              LISTENING       5000',
        ].join('\r\n'));

        expect(listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 1234 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 4321 },
            { address: '192.168.1.10', port: 5174, protocol: 'tcp', pid: 5000 },
        ]);
    });
});

describe('readWindowsProcessFacts', () => {
    it('uses a direct CIM PID filter without enumerating processes or listeners', async () => {
        const execFile = vi.fn(async (_command: string, _args: readonly string[]) => ({
            stdout: JSON.stringify({
                ProcessId: 1234,
                ParentProcessId: 100,
                CreationDate: '20250630123456.123000+000',
                CommandLine: 'happier --resume abc',
                ExecutablePath: 'C:\\Program Files\\Happier\\happier.exe',
            }),
        }));

        const processes = await readWindowsProcessFacts({ execFile, pids: [1234] });

        expect(processes.get(1234)).toEqual({
            pid: 1234,
            ppid: 100,
            processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56, 123),
            command: 'happier --resume abc',
            executablePath: 'C:\\Program Files\\Happier\\happier.exe',
        });
        const args = execFile.mock.calls[0]?.[1] ?? [];
        expect(execFile.mock.calls[0]?.[0]).toBe('powershell.exe');
        expect(args[3]).toContain('Get-CimInstance Win32_Process -Filter "ProcessId = 1234"');
        expect(args[3]).not.toContain('Get-CimInstance Win32_Process |');
    });

});

describe('parseWindowsProcessFactsJson', () => {
    it('parses PowerShell CIM process facts and ignores malformed rows', () => {
        const processes = parseWindowsProcessFactsJson(JSON.stringify([
            {
                ProcessId: 1234,
                ParentProcessId: 100,
                CreationDate: '20250630123456.000000+000',
                CommandLine: 'npm run dev -- --token raw-secret',
                ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
            },
            {
                ProcessId: 4321,
                ParentProcessId: 101,
                CommandLine: null,
                ExecutablePath: 'C:\\Python311\\python.exe',
            },
            {
                ProcessId: 0,
                ParentProcessId: 1,
                CommandLine: 'System Idle Process',
            },
        ]));

        expect([...processes.entries()]).toEqual([
            [1234, {
                pid: 1234,
                ppid: 100,
                processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56),
                command: 'npm run dev -- --token raw-secret',
                executablePath: 'C:\\Program Files\\nodejs\\node.exe',
            }],
            [4321, {
                pid: 4321,
                ppid: 101,
                command: 'C:\\Python311\\python.exe',
                executablePath: 'C:\\Python311\\python.exe',
            }],
        ]);
    });
});

describe('readWindowsLocalServiceListeners', () => {
    it('reads netstat listeners and process facts through Windows system-tool boundaries', async () => {
        const execFile = vi.fn(async (command: string) => {
            if (command === 'netstat.exe') {
                return {
                    stdout: [
                        '  Proto  Local Address          Foreign Address        State           PID',
                        '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234',
                    ].join('\r\n'),
                };
            }
            if (command === 'powershell.exe') {
                return {
                    stdout: JSON.stringify([{
                        ProcessId: 1234,
                        ParentProcessId: 100,
                        CreationDate: '20250630123456.000000+000',
                        CommandLine: 'npm run dev -- --token raw-secret',
                        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
                    }]),
                };
            }
            throw new Error(`unexpected command ${command}`);
        });

        const result = await readWindowsLocalServiceListeners({ execFile });
        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-win',
            now: 2_000,
            previous: null,
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [],
        });

        expect(result.diagnostics).toEqual([]);
        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 1234 },
        ]);
        expect(result.processes.get(1234)).toMatchObject({
            pid: 1234,
            ppid: 100,
            processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56),
        });
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-win:tcp:loopback:127.0.0.1:5173:pid-1234:start-1751286896000',
            state: 'listening',
            confidence: 'high',
        });
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
        expect(execFile).toHaveBeenCalledWith('netstat.exe', ['-ano', '-p', 'tcp'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
        const execFileCalls = execFile.mock.calls as unknown as Array<readonly [string, readonly string[]]>;
        const powershellCall = execFileCalls.find((call) => call[0] === 'powershell.exe');
        const powershellScript = powershellCall?.[1]?.[3];
        expect(powershellCall?.[1]).toEqual([
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            expect.stringContaining('Get-CimInstance Win32_Process -Filter "ProcessId = 1234"'),
        ]);
        expect(powershellScript).toContain('CreationDate');
        expect(powershellScript).not.toContain('Get-CimInstance Win32_Process | Where-Object');
        expect(powershellScript).not.toContain('$HappierLocalServicePids');
    });

    it('collects listener ancestor facts so terminal registry attribution works by lineage on Windows', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'netstat.exe') {
                return {
                    stdout: [
                        '  Proto  Local Address          Foreign Address        State           PID',
                        '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234',
                    ].join('\r\n'),
                };
            }
            if (command === 'powershell.exe') {
                const script = args[3] ?? '';
                const rows: Array<{
                    ProcessId: number;
                    ParentProcessId: number;
                    CommandLine: string;
                    ExecutablePath?: string;
                }> = [];
                if (script.includes('1234')) {
                    rows.push({
                        ProcessId: 1234,
                        ParentProcessId: 100,
                        CommandLine: 'node C:\\repo\\web\\node_modules\\vite\\bin\\vite.js',
                        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
                    });
                }
                if (script.includes('100')) {
                    rows.push({
                        ProcessId: 100,
                        ParentProcessId: 1,
                        CommandLine: 'npm run dev',
                        ExecutablePath: 'C:\\Program Files\\nodejs\\npm.cmd',
                    });
                }
                return { stdout: JSON.stringify(rows) };
            }
            throw new Error(`unexpected command ${command}`);
        });

        const result = await readWindowsLocalServiceListeners({ execFile });
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 'term-win',
            workspacePath: 'C:\\repo\\web',
            pids: [100],
            sessionId: 'session-win',
            terminalId: 'terminal-win',
        });

        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-win',
            now: 2_000,
            previous: null,
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [],
            terminalRegistry: registry,
        });

        expect(result.processes.get(100)).toMatchObject({
            pid: 100,
            command: 'npm run dev',
        });
        expect(snapshot.entries[0]).toMatchObject({
            workspaceAssociationConfidence: 'high',
            provenance: {
                session: { id: 'session-win' },
                workspace: {
                    path: 'C:\\repo\\web',
                    association: 'process_tree',
                },
            },
        });
    });

    it('fails closed without leaking command output when netstat is unavailable', async () => {
        const execFile = vi.fn(async () => {
            throw new Error('TOKEN raw-secret command output');
        });

        const result = await readWindowsLocalServiceListeners({ execFile });

        expect(result.listeners).toEqual([]);
        expect(result.processes).toEqual(new Map());
        expect(result.diagnostics).toEqual([{
            code: 'windows_netstat_scan_failed',
            severity: 'warning',
            message: 'Windows local-service listener scan failed.',
        }]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('raw-secret');
    });

    it('keeps listener facts and reports a sanitized diagnostic when process facts are malformed', async () => {
        const execFile = vi.fn(async (command: string) => {
            if (command === 'netstat.exe') {
                return {
                    stdout: [
                        '  Proto  Local Address          Foreign Address        State           PID',
                        '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234',
                    ].join('\r\n'),
                };
            }
            if (command === 'powershell.exe') {
                return { stdout: 'TOKEN raw-secret not json' };
            }
            throw new Error(`unexpected command ${command}`);
        });

        const result = await readWindowsLocalServiceListeners({ execFile });

        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 1234 },
        ]);
        expect(result.processes).toEqual(new Map());
        expect(result.diagnostics).toEqual([{
            code: 'windows_process_fact_scan_failed',
            severity: 'warning',
            message: 'Windows process fact scan failed.',
        }]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('raw-secret');
    });
});
