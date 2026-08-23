import { describe, expect, it, vi } from 'vitest';

import type { LocalServiceProcessFact } from '../provenance';
import { normalizeLocalServiceScan } from '../scanner';
import { createTerminalProcessRegistry } from '../terminalRegistry';
import { parseDarwinLsofTcpListenOutput, readDarwinLocalServiceListeners, readDarwinProcessFacts } from './darwin';

describe('parseDarwinLsofTcpListenOutput', () => {
    it('parses lsof field output into listener facts', () => {
        expect(parseDarwinLsofTcpListenOutput([
            'p123',
            'cnode',
            'nTCP 127.0.0.1:5173 (LISTEN)',
            'p456',
            'cnode',
            'nTCP *:8080 (LISTEN)',
        ].join('\n'))).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 },
            { address: '0.0.0.0', port: 8080, protocol: 'tcp', pid: 456 },
        ]);
    });

    it('parses raw Darwin lsof field names emitted by -F output', () => {
        expect(parseDarwinLsofTcpListenOutput([
            'p32910',
            'cPython',
            'f3',
            'n127.0.0.1:54322',
        ].join('\n'))).toEqual([
            { address: '127.0.0.1', port: 54322, protocol: 'tcp', pid: 32910 },
        ]);
    });

    it('reads listeners through the lsof system boundary', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: [
                        'p123',
                        'nTCP 127.0.0.1:5173 (LISTEN)',
                    ].join('\n'),
                };
            }
            return { stdout: '' };
        });

        await expect(readDarwinLocalServiceListeners({ execFile })).resolves.toEqual({
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 }],
            processes: new Map([[123, { pid: 123, command: 'unknown' }]]),
            diagnostics: [],
        });
        expect(execFile).toHaveBeenCalledWith('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
    });

    it('fails closed without leaking command output when Darwin lsof is unavailable', async () => {
        const execFile = vi.fn(async () => {
            throw new Error('TOKEN raw-secret command output');
        });

        const result = await readDarwinLocalServiceListeners({ execFile });

        expect(result.listeners).toEqual([]);
        expect(result.processes).toEqual(new Map());
        expect(result.diagnostics).toEqual([{
            code: 'darwin_lsof_scan_failed',
            severity: 'warning',
            message: 'Darwin local-service listener scan failed.',
        }]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('raw-secret');
    });

    it('enriches listener PIDs with process command and cwd facts through Darwin system-tool boundaries', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: [
                        'p123',
                        'cnode',
                        'nTCP 127.0.0.1:5173 (LISTEN)',
                    ].join('\n'),
                };
            }
            if (command === 'ps') {
                return {
                    stdout: '  123    99   501 npm run dev -- --token raw-secret\n',
                };
            }
            if (command === 'lsof' && args.includes('cwd')) {
                return {
                    stdout: [
                        'p123',
                        'n/Users/lee/repo/app',
                    ].join('\n'),
                };
            }
            throw new Error(`unexpected boundary call ${command} ${args.join(' ')}`);
        });

        const result = await readDarwinLocalServiceListeners({ execFile, daemonUserId: '501' });
        const processes = (result as { processes?: ReadonlyMap<number, LocalServiceProcessFact> }).processes;
        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 2_000,
            previous: null,
            listeners: result.listeners,
            processes: processes ?? new Map(),
            workspaces: [{ path: '/Users/lee/repo' }],
        });

        expect(processes?.get(123)).toMatchObject({
            pid: 123,
            ppid: 99,
            cwd: '/Users/lee/repo/app',
            processOwnership: 'self',
        });
        expect(snapshot.entries[0]).toMatchObject({
            workspaceAssociationConfidence: 'high',
            provenance: {
                process: {
                    pid: 123,
                    cwd: '/Users/lee/repo/app',
                    redacted: true,
                },
                workspace: {
                    path: '/Users/lee/repo',
                    association: 'cwd_containment',
                },
            },
        });
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
    });

    it('carries Darwin process start time into process facts when ps supplies lstart', async () => {
        const startedAt = Date.parse('Mon Jun 30 12:34:56 2025');
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: [
                        'p123',
                        'cnode',
                        'nTCP 127.0.0.1:5173 (LISTEN)',
                    ].join('\n'),
                };
            }
            if (command === 'ps') {
                return {
                    stdout: '  123    99   501 Mon Jun 30 12:34:56 2025 npm run dev\n',
                };
            }
            if (command === 'lsof' && args.includes('cwd')) {
                return { stdout: '' };
            }
            throw new Error(`unexpected boundary call ${command} ${args.join(' ')}`);
        });

        const result = await readDarwinLocalServiceListeners({ execFile, daemonUserId: '501' });

        expect(result.processes.get(123)?.processStartTimeMs).toBe(startedAt);
        expect(execFile).toHaveBeenCalledWith('ps', ['-o', 'pid=,ppid=,uid=,lstart=,command=', '-p', '123'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
    });

    it('marks a listener owned by another OS user as not the daemon\'s to control', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: ['p123', 'cpostgres', 'nTCP 127.0.0.1:5432 (LISTEN)'].join('\n'),
                };
            }
            if (command === 'ps') {
                return { stdout: '  123     1     0 Mon Jun 30 12:34:56 2025 /usr/sbin/systemd-resolved\n' };
            }
            return { stdout: '' };
        });

        const result = await readDarwinLocalServiceListeners({ execFile, daemonUserId: '501' });

        expect(result.processes.get(123)?.processOwnership).toBe('other');
    });

    it('recovers the listener list when lsof exits non-zero but still printed it', async () => {
        // `lsof` exits non-zero whenever any single file is inaccessible; discarding that stdout
        // turned a degraded scan into an authoritative "no services are running".
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                throw Object.assign(new Error('lsof: WARNING: raw-secret'), {
                    stdout: ['p123', 'cnode', 'nTCP 127.0.0.1:5173 (LISTEN)'].join('\n'),
                });
            }
            if (command === 'ps') {
                return { stdout: '  123    99   501 npm run dev\n' };
            }
            return { stdout: '' };
        });

        const result = await readDarwinLocalServiceListeners({ execFile, daemonUserId: '501' });

        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 },
        ]);
        expect(result.diagnostics).toEqual([{
            code: 'darwin_lsof_scan_partial',
            severity: 'warning',
            message: 'Darwin local-service listener scan was incomplete; recovered partial output.',
        }]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('raw-secret');
    });

    it('collects listener ancestor facts so terminal registry attribution works by lineage on Darwin', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: [
                        'p400',
                        'cnode',
                        'nTCP 127.0.0.1:5173 (LISTEN)',
                    ].join('\n'),
                };
            }
            if (command === 'ps') {
                const pidArg = args[args.indexOf('-p') + 1] ?? '';
                const pids = new Set(pidArg.split(','));
                const rows: string[] = [];
                if (pids.has('400')) rows.push('  400   300   501 node /repo/web/node_modules/vite/bin/vite.js');
                if (pids.has('300')) rows.push('  300     1   501 npm run dev');
                return { stdout: rows.join('\n') };
            }
            if (command === 'lsof' && args.includes('cwd')) {
                const pidArg = args[args.indexOf('-p') + 1] ?? '';
                const pids = new Set(pidArg.split(','));
                const rows: string[] = [];
                if (pids.has('400')) rows.push('p400', 'n/tmp/elsewhere');
                if (pids.has('300')) rows.push('p300', 'n/Users/lee/repo/web');
                return { stdout: rows.join('\n') };
            }
            throw new Error(`unexpected boundary call ${command} ${args.join(' ')}`);
        });

        const result = await readDarwinLocalServiceListeners({ execFile });
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 'term-a',
            workspacePath: '/Users/lee/repo/web',
            pids: [300],
            sessionId: 'session-a',
            terminalId: 'terminal-a',
        });

        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-darwin',
            now: 2_000,
            previous: null,
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [],
            terminalRegistry: registry,
        });

        expect(result.processes.get(300)).toMatchObject({
            pid: 300,
            command: 'npm run dev',
        });
        expect(snapshot.entries[0]).toMatchObject({
            workspaceAssociationConfidence: 'high',
            provenance: {
                session: { id: 'session-a' },
                workspace: {
                    path: '/Users/lee/repo/web',
                    association: 'process_tree',
                },
            },
        });
    });

    it('keeps listener facts and reports a sanitized diagnostic when Darwin process facts fail', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: [
                        'p123',
                        'cnode',
                        'nTCP 127.0.0.1:5173 (LISTEN)',
                    ].join('\n'),
                };
            }
            if (command === 'ps') {
                throw new Error('TOKEN raw-secret command output');
            }
            if (command === 'lsof' && args.includes('cwd')) {
                return { stdout: '' };
            }
            throw new Error(`unexpected boundary call ${command} ${args.join(' ')}`);
        });

        const result = await readDarwinLocalServiceListeners({ execFile });

        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 },
        ]);
        expect(result.processes.get(123)).toMatchObject({
            pid: 123,
            command: 'node',
        });
        expect(result.diagnostics).toEqual([{
            code: 'darwin_process_fact_scan_failed',
            severity: 'warning',
            message: 'Darwin process fact scan failed.',
        }]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('raw-secret');
    });

    it('reports a sanitized diagnostic when Darwin cwd facts fail', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: [
                        'p123',
                        'cnode',
                        'nTCP 127.0.0.1:5173 (LISTEN)',
                    ].join('\n'),
                };
            }
            if (command === 'ps') {
                return {
                    stdout: '  123    99   501 npm run dev\n',
                };
            }
            if (command === 'lsof' && args.includes('cwd')) {
                throw new Error('TOKEN raw-secret cwd output');
            }
            throw new Error(`unexpected boundary call ${command} ${args.join(' ')}`);
        });

        const result = await readDarwinLocalServiceListeners({ execFile });

        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 },
        ]);
        expect(result.processes.get(123)).toMatchObject({
            pid: 123,
            ppid: 99,
            command: 'npm run dev',
        });
        expect(result.diagnostics).toEqual([{
            code: 'darwin_cwd_fact_scan_failed',
            severity: 'warning',
            message: 'Darwin cwd fact scan failed.',
        }]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('raw-secret');
    });

    it('uses partial cwd facts when Darwin lsof returns stdout with a nonzero exit', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'lsof' && args.includes('-iTCP')) {
                return {
                    stdout: [
                        'p123',
                        'cnode',
                        'nTCP 127.0.0.1:5173 (LISTEN)',
                    ].join('\n'),
                };
            }
            if (command === 'ps') {
                return {
                    stdout: '  123    99   501 npm run dev\n',
                };
            }
            if (command === 'lsof' && args.includes('cwd')) {
                throw Object.assign(new Error('TOKEN raw-secret cwd output'), {
                    stdout: [
                        'p123',
                        'n/Users/lee/repo/app',
                    ].join('\n'),
                });
            }
            throw new Error(`unexpected boundary call ${command} ${args.join(' ')}`);
        });

        const result = await readDarwinLocalServiceListeners({ execFile });

        expect(result.processes.get(123)).toMatchObject({
            pid: 123,
            ppid: 99,
            command: 'npm run dev',
            cwd: '/Users/lee/repo/app',
        });
        expect(result.diagnostics).toEqual([]);
        expect(JSON.stringify(result)).not.toContain('raw-secret');
    });
});

describe('readDarwinProcessFacts', () => {
    it('reads canonical identity facts, including the authoritative executable path, for only the requested PID', async () => {
        const execFile = vi.fn(async (command: string, args: readonly string[]) => {
            if (command === 'ps') {
                return {
                    stdout: '  123    99 Mon Jun 30 12:34:56 2025 happier --resume abc\n',
                };
            }
            if (command === 'lsof' && args.includes('txt')) {
                return {
                    stdout: [
                        'p123',
                        'ftxt',
                        'n/Applications/Happier.app/Contents/MacOS/happier',
                        'ftxt',
                        'n/usr/lib/dyld',
                    ].join('\n'),
                };
            }
            throw new Error(`unexpected boundary call ${command} ${args.join(' ')}`);
        });

        const processes = await readDarwinProcessFacts({ execFile, pids: [123] });

        expect(processes.get(123)).toEqual({
            pid: 123,
            ppid: 99,
            processStartTimeMs: Date.parse('Mon Jun 30 12:34:56 2025'),
            command: 'happier --resume abc',
            executablePath: '/Applications/Happier.app/Contents/MacOS/happier',
        });
        expect(execFile).toHaveBeenCalledWith(
            'ps',
            ['-o', 'pid=,ppid=,lstart=,command=', '-p', '123'],
            { timeout: 2_000, maxBuffer: 1024 * 1024 },
        );
        expect(execFile).toHaveBeenCalledWith(
            'lsof',
            ['-nP', '-a', '-d', 'txt', '-p', '123', '-F', 'pfn'],
            { timeout: 2_000, maxBuffer: 1024 * 1024 },
        );
    });
});
