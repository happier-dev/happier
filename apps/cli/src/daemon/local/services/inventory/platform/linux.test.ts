import { describe, expect, it } from 'vitest';

import { parseLinuxProcNetTcpListeners, readLinuxLocalServiceListeners, readLinuxProcessFacts } from './linux';

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
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 654 },
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
        daemonUserId: '501',
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
    it('reads procfs sockets and process facts without shelling out', async () => {
        const result = await readLinuxLocalServiceListeners(boundaryFor(procfsFixture()));

        expect(result.diagnostics).toEqual([]);
        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 654 },
        ]);
        expect(result.processes.get(321)).toEqual({
            pid: 321,
            ppid: 300,
            processStartTimeMs: 1_717_171_823_450,
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
        fixture.files.set('/proc/321/status', 'Name:\tpostgres\nUid:\t70\t70\t70\t70\n');

        const result = await readLinuxLocalServiceListeners(boundaryFor(fixture));

        expect(result.processes.get(321)?.processOwnership).toBe('other');
        expect(result.processes.get(654)?.processOwnership).toBe('self');
    });

    it('returns what it resolved plus a warning when the /proc walk exceeds its deadline', async () => {
        const fixture = procfsFixture();
        // Every pid beyond the first chunk boundary is unreachable once the clock trips.
        let ticks = 0;
        const result = await readLinuxLocalServiceListeners({
            ...boundaryFor(fixture),
            now: () => {
                ticks += 1;
                return ticks === 1 ? 0 : 10_000;
            },
            deadlineMs: 1_000,
        });

        expect(result.diagnostics).toEqual([{
            code: 'linux_procfs_scan_deadline_exceeded',
            severity: 'warning',
            message: 'Linux /proc scan exceeded its deadline; listener attribution may be incomplete.',
        }]);
        // The listener rows survive; they simply carry no pid attribution.
        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp' },
            { address: '::1', port: 8081, protocol: 'tcp' },
        ]);
    });
});

describe('readLinuxProcessFacts', () => {
    it('reads only the requested PID, its owner uid, and the boot-time owner', async () => {
        const readPaths: string[] = [];
        const processes = await readLinuxProcessFacts({
            daemonUserId: '501',
            readFile: async (path) => {
                readPaths.push(path);
                if (path === '/proc/stat') return 'btime 1717171700\n';
                if (path === '/proc/321/stat') {
                    return '321 (node) S 300 321 321 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 1 1';
                }
                if (path === '/proc/321/cmdline') return ['node', 'happier', '--resume', 'abc'].join(NUL);
                if (path === '/proc/321/status') return 'Uid:\t501\t501\t501\t501\n';
                throw new Error(`unexpected read ${path}`);
            },
            readdir: async () => {
                throw new Error('direct PID inspection must not enumerate procfs');
            },
            readlink: async (path) => {
                if (path === '/proc/321/cwd') return '/repo';
                throw new Error(`unexpected link ${path}`);
            },
        }, [321]);

        expect(processes.get(321)).toEqual({
            pid: 321,
            ppid: 300,
            processStartTimeMs: 1_717_171_823_450,
            command: 'node happier --resume abc',
            cwd: '/repo',
            processOwnership: 'self',
        });
        expect(readPaths).toEqual([
            '/proc/stat',
            '/proc/321/stat',
            '/proc/321/cmdline',
            '/proc/321/status',
        ]);
    });
});
