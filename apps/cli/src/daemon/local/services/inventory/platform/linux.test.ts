import { describe, expect, it } from 'vitest';

import { parseLinuxProcNetTcpListeners, readLinuxLocalServiceListeners, readLinuxProcessFacts } from './linux';

describe('parseLinuxProcNetTcpListeners', () => {
    it('parses IPv4 and IPv6 listening sockets from procfs fixtures', () => {
        const listeners = parseLinuxProcNetTcpListeners({
            tcp4: [
                '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
                '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 12345 1 0000000000000000 100 0 0 10 0',
            ].join('\n'),
            tcp6: [
                '  sl  local_address                         rem_address                         st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
                '   0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501        0 99999 1 0000000000000000 100 0 0 10 0',
            ].join('\n'),
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

describe('readLinuxLocalServiceListeners', () => {
    it('reads procfs sockets and process facts without shelling out', async () => {
        const files = new Map<string, string>([
            ['/proc/net/tcp', [
                '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
                '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 12345 1 0000000000000000 100 0 0 10 0',
            ].join('\n')],
            ['/proc/net/tcp6', [
                '  sl  local_address                         rem_address                         st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
                '   0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501        0 99999 1 0000000000000000 100 0 0 10 0',
            ].join('\n')],
            ['/proc/stat', 'cpu  1 2 3 4 5 6 7 8 9 10\nbtime 1717171700\n'],
            ['/proc/321/stat', '321 (node) S 300 321 321 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 1 1'],
            ['/proc/321/cmdline', 'node\u0000./node_modules/vite/bin/vite.js\u0000--host\u0000127.0.0.1'],
            ['/proc/654/stat', '654 (node) S 300 654 654 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 23456 1 1'],
            ['/proc/654/cmdline', 'npm\u0000run\u0000dev'],
        ]);
        const directories = new Map<string, readonly string[]>([
            ['/proc', ['self', '321', '654', 'not-a-pid']],
            ['/proc/321/fd', ['3']],
            ['/proc/654/fd', ['9']],
        ]);
        const links = new Map<string, string>([
            ['/proc/321/fd/3', 'socket:[12345]'],
            ['/proc/321/cwd', '/repo/web'],
            ['/proc/321/exe', '/usr/bin/node'],
            ['/proc/654/fd/9', 'socket:[99999]'],
            ['/proc/654/cwd', '/repo/native'],
            ['/proc/654/exe', '/usr/bin/npm'],
        ]);

        const result = await readLinuxLocalServiceListeners({
            procRoot: '/proc',
            readFile: async (path) => {
                const value = files.get(String(path));
                if (value === undefined) throw new Error(`unexpected readFile ${path}`);
                return value;
            },
            readdir: async (path) => {
                const value = directories.get(String(path));
                if (!value) throw new Error(`unexpected readdir ${path}`);
                return [...value];
            },
            readlink: async (path) => {
                const value = links.get(String(path));
                if (value === undefined) throw new Error(`unexpected readlink ${path}`);
                return value;
            },
        });

        expect(result.diagnostics).toEqual([]);
        expect(result.listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 654 },
        ]);
        expect([...result.processes.entries()]).toEqual([
            [321, { pid: 321, ppid: 300, processStartTimeMs: 1_717_171_823_450, command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1', executablePath: '/usr/bin/node', cwd: '/repo/web' }],
            [654, { pid: 654, ppid: 300, processStartTimeMs: 1_717_171_934_560, command: 'npm run dev', executablePath: '/usr/bin/npm', cwd: '/repo/native' }],
        ]);
    });
});

describe('readLinuxProcessFacts', () => {
    it('reads only the requested PID and the boot-time owner', async () => {
        const readPaths: string[] = [];
        const processes = await readLinuxProcessFacts({
            readFile: async (path) => {
                readPaths.push(path);
                if (path === '/proc/stat') return 'btime 1717171700\n';
                if (path === '/proc/321/stat') {
                    return '321 (node) S 300 321 321 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 1 1';
                }
                if (path === '/proc/321/cmdline') return 'node\u0000happier\u0000--resume\u0000abc';
                throw new Error(`unexpected read ${path}`);
            },
            readdir: async () => {
                throw new Error('direct PID inspection must not enumerate procfs');
            },
            readlink: async (path) => {
                if (path === '/proc/321/cwd') return '/repo';
                if (path === '/proc/321/exe') return '/opt/happier/bin/happier';
                throw new Error(`unexpected link ${path}`);
            },
        }, [321]);

        expect(processes.get(321)).toEqual({
            pid: 321,
            ppid: 300,
            processStartTimeMs: 1_717_171_823_450,
            command: 'node happier --resume abc',
            executablePath: '/opt/happier/bin/happier',
            cwd: '/repo',
        });
        expect(readPaths).toEqual(['/proc/stat', '/proc/321/stat', '/proc/321/cmdline']);
    });
});
