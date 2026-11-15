import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { installLocalServiceCensusFixture } from './censusFixture.testkit';
import { parseWindowsNetstatTcpListeners, readWindowsLocalServiceListeners } from './windows';

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});
beforeEach(() => installLocalServiceCensusFixture([
    { pid: 1234, ppid: 99, command: ['node', 'vite'] }, { pid: 99, command: ['shell'] },
]));

describe('parseWindowsNetstatTcpListeners', () => {
    it('counts endpoint clients even when accepted sockets move to workers and fails closed on localized states', () => {
        const listening = 'TCP 0.0.0.0:5173 0.0.0.0:0 LISTENING 1234';
        expect(parseWindowsNetstatTcpListeners(listening + '\nTCP 127.0.0.1:5173 127.0.0.1:55000 ESTABLISHED 4321')[0])
            .toMatchObject({ establishedConnections: 1 });
        expect(parseWindowsNetstatTcpListeners(listening + '\nTCP 127.0.0.1:5173 127.0.0.1:55000 HERGESTELLT 4321')[0])
            .toMatchObject({ establishedConnections: null });
    });
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
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 1234, establishedConnections: 0 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 4321, establishedConnections: 0 },
            { address: '192.168.1.10', port: 5174, protocol: 'tcp', pid: 5000, establishedConnections: 0 },
        ]);
    });

    it('still resolves listeners when the State column is localized', () => {
        // A listening TCP socket always reports the wildcard foreign address with port 0, which
        // is locale-independent; matching only the literal `LISTENING` would blank the entire
        // inventory on a non-English host.
        const listeners = parseWindowsNetstatTcpListeners([
            '  Proto  Lokale Adresse         Remoteadresse          Status          PID',
            '  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         1234',
            '  TCP    [::1]:8081             [::]:0                 ABHÖREN         4321',
        ].join('\r\n'));

        expect(listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 1234, establishedConnections: null },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 4321, establishedConnections: null },
        ]);
    });

    it('does not mistake a localized connected socket for a listener', () => {
        const listeners = parseWindowsNetstatTcpListeners([
            '  Proto  Lokale Adresse         Remoteadresse          Status          PID',
            '  TCP    127.0.0.1:5173         93.184.216.34:443      HERGESTELLT     1234',
        ].join('\r\n'));

        expect(listeners).toEqual([]);
    });
});



describe('Windows local services census projection', () => {
    it('retains complete listener output beyond the former scan time and output ceilings', async () => {
        const result = await readWindowsLocalServiceListeners({
            // Replace only the unavailable OS command; retain the real process/output boundary.
            execFile: async (_command, _args, options) => execFileWithDeadline(process.execPath, ['-e',
                "const sockets = Array.from({ length: 25_000 }, (_, i) => 'TCP 127.0.0.1:5174 127.0.0.1:' + (i + 10_000) + ' ESTABLISHED 1234\\n').join(''); setTimeout(() => process.stdout.write(sockets + 'TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 1234'), 2100)",
            ], options),
            includeProcessFacts: false,
        });
        expect(result.listeners).toEqual([expect.objectContaining({ pid: 1234, port: 5173 })]);
        expect(result.diagnostics).toEqual([]);
    });
    it('retains partial listeners while refusing a false zero client count on command failure', async () => {
        const result = await readWindowsLocalServiceListeners({
            execFile: async () => { throw Object.assign(new Error('private secret'), {
                stdout: Buffer.from('TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 1234'),
            }); },
            includeProcessFacts: false,
        });
        expect(result.listeners).toEqual([expect.objectContaining({ pid: 1234, port: 5173, establishedConnections: null })]);
        expect(result.diagnostics.map(item => item.code)).toEqual(['windows_netstat_scan_partial']);
        expect(JSON.stringify(result.diagnostics)).not.toContain('private secret');
    });
    it('defers process census for listener-only demand without losing its later detailed observation', async () => {
        const opened = vi.spyOn(fs, 'open');
        const result = await readWindowsLocalServiceListeners({ execFile: async () => ({
            stdout: 'TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 1234',
        }), includeProcessFacts: false });
        expect(result.listeners).toEqual([expect.objectContaining({ pid: 1234, port: 5173 })]);
        expect(result.processes.size).toBe(0);
        expect(opened).not.toHaveBeenCalled();
        expect((await result.readProcessFacts?.())?.get(1234)).toMatchObject({ command: 'node vite' });
    });
    it('enriches socket pids and their ancestors without a second process inventory', async () => {
        const execFile = async (command: string) => {
            if (command !== 'netstat.exe') throw new Error('Only socket discovery may spawn');
            return { stdout: 'TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 1234' };
        };
        const result = await readWindowsLocalServiceListeners({ execFile });
        expect(result.diagnostics).toEqual([]);
        expect(result.processes.get(1234)).toMatchObject({ command: 'node vite', processOwnership: 'self' });
        expect(result.processes.get(99)).toMatchObject({ command: 'shell' });
    });
    it('retains listeners but reports an unavailable census instead of an empty successful process scan', async () => {
        vi.mocked(fs.readdir).mockRejectedValue(new Error('unavailable'));
        const result = await readWindowsLocalServiceListeners({ execFile: async () => ({
            stdout: 'TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 1234',
        }) });
        expect(result.listeners).toHaveLength(1);
        expect(result.processes.size).toBe(0);
        expect(result.diagnostics.map(item => item.code)).toEqual(['windows_process_fact_scan_failed']);
    });
    it('returns no process facts for an empty successful socket scan', async () => {
        const result = await readWindowsLocalServiceListeners({ execFile: async () => ({ stdout: '' }) });
        expect(result).toEqual({ listeners: [], processes: new Map(), diagnostics: [] });
    });
    it('reports failed socket discovery', async () => {
        const result = await readWindowsLocalServiceListeners({ execFile: async () => { throw new Error('private secret'); } });
        expect(result.diagnostics.map(item => item.code)).toEqual(['windows_netstat_scan_failed']);
        expect(JSON.stringify(result.diagnostics)).not.toContain('private secret');
    });
});
