import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { installLocalServiceCensusFixture } from './censusFixture.testkit';
import { normalizeLocalServiceScan } from '../scanner';
import { parseDarwinLsofTcpListenOutput, readDarwinLocalServiceListeners } from './darwin';

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});
beforeEach(() => installLocalServiceCensusFixture([
    { pid: 123, ppid: 99, command: ['npm', 'run', 'dev', '--token', 'raw-secret'], cwd: '/Users/lee/repo/app' },
    { pid: 99, command: ['shell'] },
]));
const listenOutput = 'p123\ncnode\nf3\nn127.0.0.1:5173\n';

describe('Darwin local services', () => {
    it('retains complete listener output beyond the former scan time and output ceilings', async () => {
        const result = await readDarwinLocalServiceListeners({
            // Replace only the unavailable OS command; retain the real process/output boundary.
            execFile: async (_command, _args, options) => execFileWithDeadline(process.execPath, ['-e',
                `const sockets = Array.from({ length: 25_000 }, (_, i) => 'f' + (i + 4) + '\\nn127.0.0.1:5174->127.0.0.1:' + (i + 10_000) + '\\nTST=ESTABLISHED\\n').join('');
                setTimeout(() => process.stdout.write('p123\\ncnode\\n' + sockets + ${JSON.stringify(listenOutput)}), 2100)`,
            ], options),
            includeProcessFacts: false,
        });
        expect(result.listeners).toEqual([expect.objectContaining({ pid: 123, port: 5173 })]);
        expect(result.diagnostics).toEqual([]);
    });
    it('defers process census for listener-only demand without losing its later detailed observation', async () => {
        const opened = vi.spyOn(fs, 'open');
        const result = await readDarwinLocalServiceListeners({ execFile: async () => ({ stdout: listenOutput }), includeProcessFacts: false });
        expect(result.listeners).toEqual([expect.objectContaining({ pid: 123, port: 5173 })]);
        expect(result.processes.size).toBe(0);
        expect(opened).not.toHaveBeenCalled();
        expect((await result.readProcessFacts?.())?.get(123)).toMatchObject({ cwd: '/Users/lee/repo/app' });
    });
    it('measures listener clients from the same lsof scan and refuses partial zero evidence', async () => {
        // An accepted socket may move to a worker while its listener remains in the parent.
        const output = 'p123\nf3\nn*:5173\nTST=LISTEN\nf5\nn*:8080\nTST=LISTEN\np456\nf4\nn127.0.0.1:5173->127.0.0.1:55000\nTST=ESTABLISHED\n';
        const result = await readDarwinLocalServiceListeners({ execFile: async () => ({ stdout: output }) });
        expect(result.listeners).toEqual(expect.arrayContaining([
            expect.objectContaining({ port: 5173, establishedConnections: 1 }),
            expect.objectContaining({ port: 8080, establishedConnections: 0 }),
        ]));
        const partial = await readDarwinLocalServiceListeners({ execFile: async () => {
            throw Object.assign(new Error('partial'), { stdout: output });
        } });
        expect(partial.listeners.every(listener => listener.establishedConnections === null)).toBe(true);
    });
    it('rejects zero visitors when socket states are unknown and does not present bound sockets as listeners', async () => {
        const output = 'p123\nf3\nn*:5173\nTST=LISTEN\nf4\nn127.0.0.1:5173->127.0.0.1:55000\nTST=UNKNOWN\nf5\nn*:8080\nTST=CLOSED\n';
        const result = await readDarwinLocalServiceListeners({ execFile: async () => ({ stdout: output }) });
        expect(result.listeners).toEqual([expect.objectContaining({ port: 5173, establishedConnections: null })]);
    });
    it('parses raw and prefixed lsof socket fields including wildcard addresses', () => {
        expect(parseDarwinLsofTcpListenOutput(listenOutput + 'p456\nnTCP *:8080 (LISTEN)')).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 },
            { address: '0.0.0.0', port: 8080, protocol: 'tcp', pid: 456 },
        ]);
    });
    it('uses census process facts and cwd for workspace provenance and redaction', async () => {
        const execFile = async (command: string, args: readonly string[]) => {
            if (command !== 'lsof' || !args.includes('-iTCP')) throw new Error('Only socket discovery may spawn');
            return { stdout: listenOutput };
        };
        const result = await readDarwinLocalServiceListeners({ execFile });
        expect(result.diagnostics).toEqual([]);
        expect(result.processes.get(99)).toMatchObject({ command: 'shell' });
        const snapshot = normalizeLocalServiceScan({ machineId: 'a', now: 2000, previous: null,
            ...result, workspaces: [{ path: '/Users/lee/repo' }] });
        expect(snapshot.entries[0]?.provenance?.workspace?.association).toBe('cwd_containment');
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
        expect(result.processes.get(123)).toMatchObject({ processOwnership: 'self', cwd: '/Users/lee/repo/app' });
    });
    it('keeps partial socket output and a warning when lsof exits nonzero', async () => {
        const result = await readDarwinLocalServiceListeners({ execFile: async () => {
            throw Object.assign(new Error('private secret'), { stdout: listenOutput });
        } });
        expect(result.listeners).toHaveLength(1);
        expect(result.processes.has(123)).toBe(true);
        expect(result.diagnostics.map(item => item.code)).toEqual(['darwin_lsof_scan_partial']);
        expect(JSON.stringify(result.diagnostics)).not.toContain('private secret');
    });
    it('reports missing socket discovery without leaking command output', async () => {
        const result = await readDarwinLocalServiceListeners({ execFile: async () => { throw new Error('private secret'); } });
        expect(result.listeners).toEqual([]);
        expect(result.diagnostics.map(item => item.code)).toEqual(['darwin_lsof_scan_failed']);
        expect(JSON.stringify(result.diagnostics)).not.toContain('private secret');
    });
    it('does not use lsof command guesses when the census cannot verify process facts', async () => {
        vi.mocked(fs.readdir).mockRejectedValue(new Error('procfs unavailable'));
        const result = await readDarwinLocalServiceListeners({ execFile: async () => ({ stdout: listenOutput }) });
        expect(result.listeners).toHaveLength(1);
        expect(result.processes.size).toBe(0);
        expect(result.diagnostics.map(item => item.code)).toEqual(['darwin_process_fact_scan_failed']);
    });
});
