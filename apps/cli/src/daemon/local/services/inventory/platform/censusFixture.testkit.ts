import * as fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { afterEach, vi } from 'vitest';
import { procfsFileHandle } from '@/testkit/process/procfsFileHandle';

const actualOpen = fs.open;

// Pin the genuine OS adapter before the production census singleton is imported by the test.
vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux', configurable: true } }));
afterEach(() => vi.unstubAllGlobals());

/** OS procfs fixture consumed by the real census, not a substitute census implementation. */
export function localServiceProcfsFixture(rows: readonly Readonly<{
    pid: number;
    ppid?: number;
    uid?: string;
    command?: readonly string[];
    cwd?: string;
    cgroup?: string;
}>[]) {
    const processes = new Map(rows.map((row) => [row.pid, row]));
    if (!processes.has(process.pid)) processes.set(process.pid, { pid: process.pid, uid: String(process.getuid?.() ?? 501) });
    return {
        readdir: async (path: string) => {
            if (path === '/proc') return [...processes.keys()].map(String);
            const tasks = /^\/proc\/(\d+)\/task$/u.exec(path);
            if (tasks) {
                if (!processes.has(Number(tasks[1]))) throw Object.assign(new Error(`Absent process ${path}`), { code: 'ENOENT' });
                return [tasks[1]!];
            }
            throw new Error(`Unexpected directory ${path}`);
        },
        readFile: async (path: string) => {
            if (path === '/proc/self/auxv') return Buffer.alloc(0);
            // This fixture models one thread per process, including the kernel's child discovery interface.
            const match = /^\/proc\/(\d+)\/(?:task\/\d+\/)?(\w+)$/u.exec(path);
            const row = match ? processes.get(Number(match[1])) : undefined;
            if (!row) throw Object.assign(new Error(`Absent process ${path}`), { code: 'ENOENT' });
            switch (match?.[2]) {
                case 'stat': return `${row.pid} (node) S ${row.ppid ?? 1} ${row.pid} ${row.pid} 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 12345 4096 1`;
                case 'status': return `Name:\tnode\nUid:\t${row.uid ?? String(process.getuid?.() ?? 501)}\t0\t0\t0\n`;
                case 'cmdline': return (row.command ?? ['node']).join('\0');
                case 'environ': return '';
                case 'cgroup': return row.cgroup ?? '0::/user.slice';
                case 'children': return [...processes.values()].filter(child => child.ppid === row.pid).map(child => child.pid).join(' ');
                default: throw new Error(`Unexpected file ${path}`);
            }
        },
        readlink: async (path: string) => {
            const match = /^\/proc\/(\d+)\/(cwd|exe)$/u.exec(path);
            const row = match ? processes.get(Number(match[1])) : undefined;
            if (!row) throw Object.assign(new Error(`Absent process ${path}`), { code: 'ENOENT' });
            if (match?.[2] === 'exe') return '/usr/bin/node';
            if (row.cwd) return row.cwd;
            throw new Error(`Unavailable cwd ${path}`);
        },
    };
}

export function installLocalServiceCensusFixture(rows: Parameters<typeof localServiceProcfsFixture>[0]) {
    // These process-table fixtures model Linux; the socket adapter under test remains platform-specific.
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux', configurable: true } }));
    const fixture = localServiceProcfsFixture(rows);
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => String(path).startsWith('/proc/')
        ? procfsFileHandle(await fs.readFile(path)) : actualOpen(path, flags, mode));
    // fs has overloads for buffers and directory entries; this fixture supplies UTF-8 process files.
    vi.mocked(fs.readFile).mockImplementation((async (path: PathLike) => fixture.readFile(String(path))) as never);
    vi.mocked(fs.readdir).mockImplementation((async (path: PathLike) => fixture.readdir(String(path))) as never);
    vi.mocked(fs.readlink).mockImplementation(async (path) => fixture.readlink(String(path)));
}
