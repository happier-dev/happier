import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { installLocalServiceCensusFixture, localServiceProcfsFixture } from './censusFixture.testkit';
import { normalizeLocalServiceScan } from '../scanner';

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
    installLocalServiceCensusFixture([
        { pid: 321, ppid: 300, command: ['node', './node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], cwd: '/repo/web' },
        { pid: 654, ppid: 300, command: ['npm', 'run', 'dev'], cwd: '/repo/native' },
    ]);
});

import { parseLinuxProcNetTcpListeners, readLinuxLocalServiceListeners } from './linux';

const TCP4_FIXTURE = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 12345 1 0000000000000000 100 0 0 10 0',
].join('\n');

/** `/proc/<pid>/cmdline` argv separator. Built explicitly so a following digit cannot be read
 *  as a legacy octal escape. */
const NUL = String.fromCharCode(0);

const TCP6_FIXTURE = [
    '  sl  local_address                         rem_address                         st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501        0 99999 1 0000000000000000 100 0 0 10 0',
].join('\n');

describe('parseLinuxProcNetTcpListeners', () => {
    it('counts established clients by listener endpoint, including wildcard listeners', () => {
        const clients = [
            '\n   1: 0100007F:1435 0200007F:ABCD 01 00000000:00000000 00:00000000 00000000 501 0 88888',
            '   2: 0200007F:1435 0100007F:ABCD 01 00000000:00000000 00:00000000 00000000 501 0 88889',
            '   3: 0100007F:1435 0200007F:ABCD 06 00000000:00000000 00:00000000 00000000 501 0 88890',
            '   4: 0100007F:1436 0200007F:ABCD 01 00000000:00000000 00:00000000 00000000 501 0 88891',
        ].join('\n');
        const listeners = parseLinuxProcNetTcpListeners({ tcp4: TCP4_FIXTURE + clients, tcp6: TCP6_FIXTURE,
            inodeToPid: new Map([['12345', 321], ['99999', 654]]) });
        expect(listeners[0]).toMatchObject({ establishedConnections: 1 });
        expect(listeners[1]).toMatchObject({ establishedConnections: 0 });
        expect(parseLinuxProcNetTcpListeners({ tcp4: TCP4_FIXTURE.replace('0100007F:1435', '00000000:1435') + clients,
            tcp6: TCP6_FIXTURE, inodeToPid: new Map([['12345', 321]]) })[0])
            .toMatchObject({ address: '0.0.0.0', establishedConnections: 2 });
        expect(parseLinuxProcNetTcpListeners({ tcp4: TCP4_FIXTURE, tcp6: '', inodeToPid: new Map([['12345', 321]]) })[0])
            .toMatchObject({ establishedConnections: null });
    });
    it('parses IPv4 and IPv6 listening sockets from procfs fixtures', () => {
        const listeners = parseLinuxProcNetTcpListeners({
            tcp4: TCP4_FIXTURE,
            tcp6: TCP6_FIXTURE,
            inodeToPid: new Map([
                ['12345', 321],
                ['99999', 654],
            ]),
        });

        expect(listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321, establishedConnections: 0 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 654, establishedConnections: 0 },
        ]);
    });
});

type ProcfsFixture = Readonly<{
    files: Map<string, string>;
    directories: Map<string, readonly string[]>;
    links: Map<string, string>;
}>;

function procfsFixture(): ProcfsFixture {
    return {
        files: new Map<string, string>([
            ['/proc/net/tcp', TCP4_FIXTURE],
            ['/proc/net/tcp6', TCP6_FIXTURE],
            ['/proc/stat', 'cpu  1 2 3 4 5 6 7 8 9 10\nbtime 1717171700\n'],
            ['/proc/321/stat', '321 (node) S 300 321 321 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 1 1'],
            ['/proc/321/cmdline', ['node', './node_modules/vite/bin/vite.js', '--host', '127.0.0.1'].join(NUL)],
            ['/proc/321/status', 'Name:\tnode\nUid:\t501\t501\t501\t501\n'],
            ['/proc/654/stat', '654 (node) S 300 654 654 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 23456 1 1'],
            ['/proc/654/cmdline', ['npm', 'run', 'dev'].join(NUL)],
            ['/proc/654/status', 'Name:\tnpm\nUid:\t501\t501\t501\t501\n'],
        ]),
        directories: new Map<string, readonly string[]>([
            // `777` is an unrelated process: the scan must never read its facts.
            ['/proc', ['self', '321', '654', '777', 'not-a-pid']],
            ['/proc/321/fd', ['3']],
            ['/proc/654/fd', ['9']],
            ['/proc/777/fd', ['4']],
        ]),
        links: new Map<string, string>([
            ['/proc/321/fd/3', 'socket:[12345]'],
            ['/proc/321/cwd', '/repo/web'],
            ['/proc/654/fd/9', 'socket:[99999]'],
            ['/proc/654/cwd', '/repo/native'],
            ['/proc/777/fd/4', 'socket:[55555]'],
        ]),
    };
}

function boundaryFor(fixture: ProcfsFixture, readPaths: string[] = []) {
    return {
        procRoot: '/proc',
        readFile: async (path: string) => {
            readPaths.push(path);
            const value = fixture.files.get(String(path));
            if (value === undefined) throw new Error(`unexpected readFile ${path}`);
            return value;
        },
        readdir: async (path: string) => {
            const value = fixture.directories.get(String(path));
            if (!value) throw new Error(`unexpected readdir ${path}`);
            return [...value];
        },
        readlink: async (path: string) => {
            const value = fixture.links.get(String(path));
            if (value === undefined) throw new Error(`unexpected readlink ${path}`);
            return value;
        },
    };
}

describe('readLinuxLocalServiceListeners', () => {
    it('accepts an absent optional IPv6 socket table while retaining IPv4 listeners', async () => {
        const boundary = boundaryFor(procfsFixture());
        const result = await readLinuxLocalServiceListeners({ ...boundary, includeProcessFacts: false,
            readFile: async path => {
                if (path === '/proc/net/tcp6') throw Object.assign(new Error('IPv6 is unavailable'), { code: 'ENOENT' });
                return boundary.readFile(path);
            } });
        expect(result.diagnostics).toEqual([]);
        expect(result.listeners).toEqual(expect.arrayContaining([expect.objectContaining({ port: 5173, pid: 321 })]));
    });

    it('defers process census for listener-only demand without losing its later detailed observation', async () => {
        const opened = vi.spyOn(fs, 'open');
        const result = await readLinuxLocalServiceListeners({ ...boundaryFor(procfsFixture()), includeProcessFacts: false });
        expect(result.listeners).toEqual(expect.arrayContaining([
            expect.objectContaining({ pid: 321, port: 5173 }),
        ]));
        expect(result.processes.size).toBe(0);
        expect(opened).not.toHaveBeenCalled();
        const processes = await result.readProcessFacts?.();
        expect(processes?.get(321)).toMatchObject({ cwd: '/repo/web', processOwnership: 'self' });
    });
    it('counts busy-host connections with less CPU than rescanning clients per listener, preserving scan calls and bytes', async () => {
        const header = TCP4_FIXTURE.split('\n')[0]!;
        const lines = Array.from({ length: 256 }, (_, index) =>
            `${index}: 0100007F:${(10_000 + index).toString(16)} 00000000:0000 0A 0 0 0 501 0 ${100_000 + index}`);
        lines.push(...Array.from({ length: 32_768 }, (_, index) =>
            `${index + 256}: 0100007F:${(10_000 + index % 256).toString(16)} 0200007F:ABCD ${index % 4 === 0 ? '01' : '06'} 0 0 0 501 0 ${200_000 + index}`));
        const tcp4 = [header, ...lines].join('\n');
        const tcp6 = TCP6_FIXTURE.split('\n')[0]!;
        const counters = { reads: 0, bytes: 0 };
        const boundary = {
            readFile: async (path: string) => {
                const value = path.endsWith('/tcp6') ? tcp6 : tcp4;
                counters.reads++;
                counters.bytes += Buffer.byteLength(value);
                return value;
            },
            readdir: async () => [] as string[],
            readlink: async () => { throw new Error('No socket owners in this parser workload'); },
        };
        // Same input and OS reads as the incumbent scan, retaining its per-listener filter.
        // This comparator belongs only to the benchmark; production has one Linux owner.
        const incumbent = async () => {
            const [four, six] = await Promise.all([boundary.readFile('/proc/net/tcp'), boundary.readFile('/proc/net/tcp6'), boundary.readdir()]);
            const rows = [four, six].flatMap(text => text.split('\n').slice(1).map(line => {
                const columns = line.trim().split(/\s+/u);
                const [host, port] = columns[1]!.split(':');
                const bytes = host!.match(/../gu)!;
                return { address: bytes.reverse().map(byte => Number.parseInt(byte, 16)).join('.'),
                    port: Number.parseInt(port!, 16), state: columns[3]! };
            }));
            return rows.filter(row => row.state === '0A').map(row => ({
                address: row.address, port: row.port, protocol: 'tcp' as const,
                establishedConnections: rows.filter(client => client.state === '01' && client.port === row.port
                    && (row.address === '0.0.0.0' || row.address === '::' || client.address === row.address)).length,
            }));
        };
        const current = async () => (await readLinuxLocalServiceListeners(boundary)).listeners;
        expect(await current()).toEqual(await incumbent());
        const measure = async (operation: typeof current) => {
            const cpu: number[] = [];
            counters.reads = 0; counters.bytes = 0;
            for (let run = 0; run < 5; run++) {
                const before = process.cpuUsage();
                await operation();
                const elapsed = process.cpuUsage(before);
                cpu.push(elapsed.user + elapsed.system);
            }
            return { cpuMicros: cpu.sort((a, b) => a - b)[2]!, readsPerCycle: counters.reads / 5, bytesPerCycle: counters.bytes / 5 };
        };
        const previous = await measure(incumbent);
        const optimized = await measure(current);
        expect(optimized.readsPerCycle).toBe(previous.readsPerCycle);
        expect(optimized.bytesPerCycle).toBe(previous.bytesPerCycle);
        expect(optimized.cpuMicros).toBeLessThan(previous.cpuMicros * 0.65);
    });
    it('enriches socket owners and ancestors from the canonical census instead of rereading socket-boundary process files', async () => {
        const fixture = localServiceProcfsFixture([
            { pid: 321, ppid: 300, command: ['node', 'vite'], cwd: '/repo/web' },
            { pid: 654, ppid: 300, command: ['npm', 'run', 'dev'] },
            { pid: 300, command: ['shell'] },
        ]);
        vi.mocked(fs.readFile).mockImplementation(async (path) => fixture.readFile(String(path)));
        vi.mocked(fs.readdir).mockImplementation(async (path) => fixture.readdir(String(path)) as never);
        vi.mocked(fs.readlink).mockImplementation(async (path) => fixture.readlink(String(path)));
        const sockets = procfsFixture();
        for (const path of [...sockets.files.keys()]) {
            if (!path.startsWith('/proc/net/')) sockets.files.delete(path);
        }
        const result = await readLinuxLocalServiceListeners(boundaryFor(sockets));
        expect(result.processes.get(321)).toMatchObject({ command: 'node vite', cwd: '/repo/web', processOwnership: 'self' });
        expect(result.processes.get(300)).toMatchObject({ command: 'shell' });
    });
    it('reads procfs sockets and process facts without shelling out', async () => {
        const result = await readLinuxLocalServiceListeners(boundaryFor(procfsFixture()));

        expect(result.diagnostics).toEqual([]);
        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321, establishedConnections: 0 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 654, establishedConnections: 0 },
        ]);
        expect(result.processes.get(321)).toMatchObject({
            pid: 321,
            ppid: 300,
            processStartTimeMs: 123_450,
            command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1',
            cwd: '/repo/web',
            processOwnership: 'self',
        });
        expect(result.processes.get(654)).toMatchObject({
            command: 'npm run dev',
            cwd: '/repo/native',
            processOwnership: 'self',
        });
    });

    it('reads process facts only for listener pids, not for every pid on the machine', async () => {
        const readPaths: string[] = [];
        await readLinuxLocalServiceListeners(boundaryFor(procfsFixture(), readPaths));

        expect(readPaths.some((path) => path.startsWith('/proc/777/'))).toBe(false);
    });

    it('marks a listener owned by another OS user as not the daemon\'s to control', async () => {
        const fixture = procfsFixture();
        installLocalServiceCensusFixture([{ pid: 321, uid: '70' }, { pid: 654 }]);

        const result = await readLinuxLocalServiceListeners(boundaryFor(fixture));

        expect(result.processes.get(321)?.processOwnership).toBe('other');
        expect(result.processes.get(654)?.processOwnership).toBe('self');
    });

    it('reports inaccessible socket owner PIDs without denying unrelated listener measurements', async () => {
        for (const inaccessiblePath of ['/proc/654/fd', '/proc/654/fd/9']) {
            const boundary = boundaryFor(procfsFixture());
            const denied = () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); };
            const result = await readLinuxLocalServiceListeners({
                ...boundary,
                readdir: path => path === inaccessiblePath ? denied() : boundary.readdir(path),
                readlink: path => path === inaccessiblePath ? denied() : boundary.readlink(path),
            });

            // The canonical ownership normalizer, not this OS collector, scopes the missing owner.
            expect(result).toMatchObject({ socketOwnerReadFailures: [654] });
            expect(result.listeners).toEqual([
                { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321, establishedConnections: 0 },
                { address: '::1', port: 8081, protocol: 'tcp', establishedConnections: 0 },
            ]);
        }
        const boundary = boundaryFor(procfsFixture());
        const complete = await readLinuxLocalServiceListeners({ ...boundary,
            readdir: async path => { if (path === '/proc/777/fd') throw new Error('Permission denied'); return boundary.readdir(path); },
        });
        // Once every kernel listening inode is attributed, inaccessible unrelated FDs cannot hide another listener.
        expect(complete).toMatchObject({ socketOwnerReadFailures: [] });
        expect(complete.listeners.every(listener => listener.establishedConnections === 0)).toBe(true);
    });

    it('finishes listener attribution beyond two seconds when no caller deadline is supplied', async () => {
        const fixture = procfsFixture();
        fixture.directories.set('/proc', ['321', ...Array.from({ length: 31 }, (_, index) => String(700 + index)), '654']);
        const boundary = boundaryFor(fixture);
        let elapsedMs = 0;
        const result = await readLinuxLocalServiceListeners({
            ...boundary,
            now: () => elapsedMs,
            readdir: async path => {
                if (path.endsWith('/fd')) elapsedMs += 100;
                return await boundary.readdir(path);
            },
        });

        expect(result.diagnostics).toEqual([]);
        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321, establishedConnections: 0 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 654, establishedConnections: 0 },
        ]);
        expect(result.processes.get(654)).toMatchObject({ cwd: '/repo/native' });
        const inventory = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: elapsedMs,
            previous: null,
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [{ id: 'accepted-a', path: '/repo/native' }],
        });
        expect(inventory.entries.find(entry => entry.port === 8081)?.provenance?.workspace)
            .toMatchObject({ id: 'accepted-a', path: '/repo/native' });
    });

    it('returns what it resolved plus a warning when the /proc walk exceeds its deadline', async () => {
        const fixture = procfsFixture();
        fixture.directories.set('/proc', ['321', ...Array.from({ length: 31 }, (_, index) => String(700 + index)), '654']);
        // One listener is resolved in the first chunk, but the second is beyond the deadline.
        let ticks = 0;
        const result = await readLinuxLocalServiceListeners({
            ...boundaryFor(fixture),
            now: () => {
                ticks += 1;
                return ticks <= 2 ? 0 : 10_000;
            },
            deadlineMs: 1_000,
        });

        expect(result.diagnostics).toEqual([{
            code: 'linux_procfs_scan_deadline_exceeded',
            severity: 'warning',
            message: 'Linux /proc scan exceeded its deadline; listener attribution may be incomplete.',
        }]);
        // A partial listener attribution cannot establish no visitors for the whole service.
        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321, establishedConnections: null },
            { address: '::1', port: 8081, protocol: 'tcp', establishedConnections: null },
        ]);
    });
});
