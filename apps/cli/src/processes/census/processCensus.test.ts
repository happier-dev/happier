import { describe, expect, it, vi } from 'vitest';
import { parseLinuxProcStartTimeMs } from '@happier-dev/cli-common/processInstance';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { createProcessCensusReader, readProcessCensus } from './processCensus';
import { readLinuxProcFile } from './linuxProcfs';
import { procfsFileHandle } from '@/testkit/process/procfsFileHandle';
import { logger } from '@/ui/logger';

// Genuine procfs descriptor boundary; retain actual OS I/O unless a test selects a fixture.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: vi.fn(actual.open) };
});

function stat(pid: number, start: number, state = 'S') {
    const fields = [state, '1', '42', '42', '0', '42', ...Array(5).fill('0'), '12', '8', ...Array(6).fill('0'), String(start), '4096', '3'];
    return `${pid} (name ) with space) ${fields.join(' ')}`;
}

function fixture() {
    const files = new Map<string, string | Buffer>();
    for (const [pid, uid, state] of [[42, '1000', 'S'], [43, '1000', 'Z'], [44, '2000', 'R']] as const) {
        files.set(`/proc/${pid}/stat`, stat(pid, pid * 10, state));
        files.set(`/proc/${pid}/status`, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
        files.set(`/proc/${pid}/cmdline`, `program\0argument with spaces\0`);
        files.set(`/proc/${pid}/cgroup`, '0::/user.slice/happier-session.scope\n');
        files.set(`/proc/${pid}/environ`, 'SECRET=must not escape\0HAPPIER_PROCESS_OWNER=v1.scope.session.id\0HAPPIER_HOME_DIR=/home/user\0');
    }
    const auxv = Buffer.alloc(32);
    auxv.writeBigUInt64LE(6n, 0); // AT_PAGESZ
    auxv.writeBigUInt64LE(4096n, 8);
    files.set('/proc/self/auxv', auxv);
    return {
        files,
        boundary: {
            async readFile(path: string) {
                const value = files.get(path);
                if (value === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
                return value;
            },
            async readdir() { return ['42', '43', '44', '45']; },
            async readlink(path: string) { return path.endsWith('/exe') ? '/usr/bin/program' : '/work'; },
        },
    };
}

describe('process census', () => {
    it('reads process identity, ownership and counters freshly on every observation', async () => {
        const { files, boundary } = fixture();
        const reads: string[] = [];
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: {
            ...boundary, async readFile(path) { reads.push(path); return boundary.readFile(path); },
        } });
        const input = { freshness: 'fresh', scope: 'all' } as const;
        const first = await reader(input);
        if (first.status !== 'ok') throw new Error('Initial census unavailable');
        reads.length = 0;
        const unchanged = await reader(input);
        if (unchanged.status !== 'ok') throw new Error('Unchanged census unavailable');
        expect(unchanged.rows).toEqual(first.rows);
        expect(reads).toContain('/proc/43/stat');
        expect(reads).toContain('/proc/43/status');
        expect(reads).toContain('/proc/43/environ');
        files.set('/proc/43/stat', stat(43, 430, 'Z').replace(' 12 8 ', ' 13 8 '));
        const changed = await reader(input);
        if (changed.status !== 'ok') throw new Error('Changed census unavailable');
        expect(changed.rows.find(row => row.pid === 43)?.cpuTimeUs).toBe(210000);
    });

    it('decodes each Linux stat record once while preserving both birth witnesses', async () => {
        const { files, boundary } = fixture();
        const statText = String(files.get('/proc/43/stat'));
        const counters = statText.slice(statText.lastIndexOf(') ') + 2);
        const split = RegExp.prototype[Symbol.split];
        let statDecodes = 0;
        const instrument = vi.spyOn(RegExp.prototype, Symbol.split).mockImplementation(function (this: RegExp, text, limit) {
            if (text === counters) statDecodes++;
            return split.call(this, text, limit);
        });
        try {
            const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: boundary });
            const snapshot = await reader({ freshness: 'fresh', pids: [43], fields: [] });
            if (snapshot.status !== 'ok') throw new Error('Identity census unavailable');
            expect(snapshot.rows.find(row => row.pid === 43)).toMatchObject({
                name: 'name ) with space',
                start: { native: 'linux-proc:430', startTimeMs: 4300 },
                state: 'zombie',
            });
            expect(statDecodes).toBe(1);
        } finally {
            instrument.mockRestore();
        }
    });

    it('walks children of every Linux thread without enumerating peers and fails closed on unreadable discovery', async () => {
        const { files, boundary } = fixture();
        files.set('/proc/43/stat', stat(43, 430).replace(' S 1 ', ' S 44 '));
        files.set('/proc/44/task/44/children', '');
        files.set('/proc/44/task/440/children', '43');
        files.set('/proc/43/task/43/children', '46');
        files.set('/proc/46/stat', stat(46, 460).replace(' S 1 ', ' S 43 '));
        files.set('/proc/46/status', 'Uid:\t1000\n');
        files.set('/proc/46/task/46/children', '');
        let denied = false;
        let unreadableChildStart = false;
        const directories: string[] = [];
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: {
            ...boundary,
            readdir: async path => {
                directories.push(path);
                if (path === '/proc/44/task') return ['44', '440'];
                if (path === '/proc/43/task') return ['43'];
                if (path === '/proc/46/task') return ['46'];
                throw new Error('must not enumerate the host or reader subtree');
            },
            readFile: async path => {
                if (denied && path.endsWith('/children')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
                if (unreadableChildStart && path === '/proc/43/stat') throw Object.assign(new Error('denied'), { code: 'EACCES' });
                return boundary.readFile(path);
            },
        } });
        const demand = { freshness: 'fresh', scope: 'all', pids: [44], fields: [], includeDescendants: true, includeAncestors: true } as const;
        const snapshot = await reader(demand);
        expect(snapshot.status === 'ok' && snapshot.rows.map(row => row.pid).sort()).toEqual([42, 43, 44, 46]);
        expect(directories).toEqual(['/proc/44/task', '/proc/43/task', '/proc/46/task']);
        unreadableChildStart = true;
        expect(await reader(demand)).toEqual({ status: 'unavailable', reason: 'read_failed' });
        unreadableChildStart = false;
        denied = true;
        expect(await reader(demand)).toEqual({ status: 'unavailable', reason: 'read_failed' });
        denied = false;
        files.delete('/proc/44/task/440/children');
        files.set('/proc/44/task/440/stat', stat(440, 4400));
        // A missing procfs capability is not proof that a live thread has no children.
        expect(await reader(demand)).toEqual({ status: 'unavailable', reason: 'read_failed' });
    });

    it.each(['darwin', 'win32'] as const)('retains native subtree discovery and scoped signal observations on %s', async platform => {
        const calls: string[][] = [];
        const reader = createProcessCensusReader({ platform, selfPid: 42, helperExecutablePath: '/helper',
            execFile: async (_file, args) => {
                calls.push([...args]);
                return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1,
                    rows: [[42, 1], [43, 1], [44, 43], [45, 1]].map(([pid, ppid]) => ({ pid, ppid,
                        start: { startTimeMs: pid }, principal: { kind: platform === 'win32' ? 'sid' : 'uid', value: 'self' },
                        name: 'fixture', memory: null, cpuTimeUs: null })) }) };
            },
        });
        const tree = await reader({ freshness: 'fresh', scope: 'all', pids: [43], fields: [], includeDescendants: true });
        expect(tree.status === 'ok' && tree.rows.map(row => row.pid)).toEqual([42, 43, 44]);
        expect(calls[0]?.some(arg => arg.startsWith('--pids='))).toBe(false);
        await reader({ freshness: 'fresh', scope: 'all', pids: [43], fields: [], includeAncestors: true });
        expect(calls[1]).toContain('--pids=43,42');
        expect(calls[1]).toContain('--include-ancestors=true');
    });

    it.each(['darwin', 'win32'] as const)('preserves native field demand for %s without enriching metrics-only reads', async platform => {
        const calls: string[][] = [];
        const self = { pid: 42, ppid: 1, start: { startTimeMs: 900 }, principal: { kind: 'uid', value: '1000' },
            name: 'self', memory: { bytes: 128, kind: 'rss' }, cpuTimeUs: 10 };
        const reader = createProcessCensusReader({ platform, selfPid: 42, helperExecutablePath: '/helper',
            async execFile(_file, args) {
                calls.push([...args]);
                const identity = args.includes('--identity-only=true');
                const metrics = args.includes('--fields=memory,cpuTimeUs');
                return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1, rows: [{ ...self,
                    ...(identity ? { memory: null, cpuTimeUs: null } : {}),
                    ...(!identity && !metrics ? { argv: ['self'], cwd: '/work', ownerTag: 'v1.scope.session.id' } : {}),
                }] }) };
            },
        });
        const metrics = await reader({ freshness: 'fresh', scope: 'all', pids: [42], fields: ['memory', 'cpuTimeUs'] });
        expect(metrics.status).toBe('ok');
        if (metrics.status !== 'ok') throw new Error('Native metrics census unavailable');
        expect(metrics.rows[0]).toEqual(self);
        expect(calls[0]).toContain('--fields=memory,cpuTimeUs');
        const identity = await reader({ freshness: 'fresh', fields: [] });
        expect(identity.status === 'ok' && identity.rows[0]).toEqual({ ...self, memory: null, cpuTimeUs: null });
        const full = await reader({ freshness: 'fresh' });
        expect(full.status === 'ok' && full.rows[0]).toMatchObject({ argv: ['self'], cwd: '/work', ownerTag: 'v1.scope.session.id' });
        expect(calls[2]?.some(arg => arg.startsWith('--fields=') || arg === '--identity-only=true')).toBe(false);
    });

    it('reads exact filtered identity targets and their fresh protection ancestors without enriching unrelated rows', async () => {
        const { files, boundary } = fixture();
        files.set('/proc/42/stat', stat(42, 420).replace(' S 1 ', ' S 43 '));
        files.set('/proc/43/stat', stat(43, 430).replace(' S 1 ', ' S 44 '));
        const reads: string[] = [];
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: {
            ...boundary, readdir: async () => { throw new Error('exact identity read must not enumerate the machine'); },
            readFile: async path => { reads.push(path); return boundary.readFile(path); },
        } });
        const snapshot = await reader({ freshness: 'fresh', scope: 'all', pids: [42], fields: [], includeAncestors: true });
        expect(snapshot.status).toBe('ok');
        if (snapshot.status !== 'ok') throw new Error('Identity census unavailable');
        expect(snapshot.rows.map(row => row.pid).sort()).toEqual([42, 43, 44]);
        expect(snapshot.rows.find(row => row.pid === 44)?.principal).toEqual({ kind: 'uid', value: '2000' });
        expect(reads.every(path => path.endsWith('/stat') || path.endsWith('/status'))).toBe(true);
    });
    it('reads only requested Linux fields and enriches listener commands through their real ancestors', async () => {
        const { files, boundary } = fixture();
        files.set('/proc/43/stat', stat(43, 430).replace(' S 1 ', ' S 42 '));
        files.set('/proc/46/stat', stat(46, 460));
        files.set('/proc/46/status', 'Uid:\t1000\n');
        const reads: string[] = [];
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: {
            ...boundary, readdir: async () => ['42', '43', '44', '46'],
            readFile: async path => { reads.push(path); return boundary.readFile(path); },
            readlink: async path => { reads.push(path); return boundary.readlink(path); },
        } });
        const snapshot = await reader({ freshness: 'shared', scope: 'all',
            fields: ['argv', 'cwd', 'ownershipEnvironment', 'cgroup'], commandRoots: [43] });
        expect(snapshot.status).toBe('ok');
        if (snapshot.status !== 'ok') throw new Error('Fixture census unavailable');
        expect(snapshot.rows.find(row => row.pid === 42)?.argv).toEqual(['program', 'argument with spaces']);
        expect(snapshot.rows.find(row => row.pid === 43)?.cwd).toBe('/work');
        expect(snapshot.rows.find(row => row.pid === 46)?.argv).toBeUndefined();
        expect(snapshot.rows.find(row => row.pid === 44)?.argv).toBeUndefined();
        expect(reads).not.toContain('/proc/46/cmdline');
        expect(reads.some(path => path.endsWith('/exe'))).toBe(false);
        expect(reads).not.toContain('/proc/self/auxv');
        // Ownership still observes non-listening peers: narrowing it to listeners
        // would lose a proven group member or a retained native root.
        expect(reads).toContain('/proc/46/environ');
        expect(snapshot.rows.every(row => row.memory === null && row.cpuTimeUs === null)).toBe(true);
        expect(snapshot.partial?.some(item => item.missing.includes('memory')) ?? false).toBe(false);
        reads.length = 0;
        await reader({ freshness: 'fresh', fields: [] });
        expect(reads.every(path => path.endsWith('/stat') || path.endsWith('/status'))).toBe(true);
    });

    it('shares only identical field demand and retains only the immutable page-size observation', async () => {
        const { files, boundary } = fixture();
        const reads: string[] = [];
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: {
            ...boundary, readFile: async path => { reads.push(path); return boundary.readFile(path); },
        } });
        const [identity, full] = await Promise.all([
            reader({ freshness: 'shared', pids: [42], fields: [] }),
            reader({ freshness: 'shared', pids: [42] }),
        ]);
        expect(identity.status === 'ok' && identity.rows[0]?.argv).toBeUndefined();
        expect(full.status === 'ok' && full.rows[0]?.argv).toEqual(['program', 'argument with spaces']);
        files.set('/proc/42/cmdline', 'changed-program\0');
        files.set('/proc/42/environ', 'HAPPIER_PROCESS_OWNER=changed-owner\0');
        const next = await reader({ freshness: 'shared', pids: [42] });
        expect(next.status === 'ok' && next.rows[0]).toMatchObject({ argv: ['changed-program'], ownerTag: 'changed-owner' });
        expect(reads.filter(path => path === '/proc/self/auxv')).toHaveLength(1);
    });

    it.skipIf(process.platform !== 'linux')('allocates less procfs read storage than the same-run readFile comparator', async () => {
        let fileReads = 0;
        const originalOpen = filesystem.open;
        const opened = vi.spyOn(filesystem, 'open').mockImplementation((...args) => {
            fileReads++;
            return originalOpen(...args);
        });
        const legacy = createProcessCensusReader({ linuxBoundary: { readFile: async (path, encoding) => {
            fileReads++;
            return encoding ? readFile(path, encoding) : readFile(path);
        }, readdir, readlink } });
        const current = createProcessCensusReader();
        const measure = async (reader: ReturnType<typeof createProcessCensusReader>, fields?: readonly []) => {
            fileReads = 0;
            let bytes = 0;
            const originalSlow = Buffer.allocUnsafeSlow;
            const originalUnsafe = Buffer.allocUnsafe;
            const slow = vi.spyOn(Buffer, 'allocUnsafeSlow').mockImplementation(size => { bytes += size; return originalSlow(size); });
            const unsafe = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation(size => { bytes += size; return originalUnsafe(size); });
            const started = performance.now();
            try {
                const snapshot = await reader({ freshness: 'fresh', pids: [process.pid], fields });
                expect(snapshot.status).toBe('ok');
                return { bytes, fileReads, elapsedMs: performance.now() - started, snapshot };
            } finally { slow.mockRestore(); unsafe.mockRestore(); }
        };
        let before: Awaited<ReturnType<typeof measure>>;
        let after: Awaited<ReturnType<typeof measure>>;
        let identity: Awaited<ReturnType<typeof measure>>;
        try {
            before = await measure(legacy);
            after = await measure(current);
            identity = await measure(current, []);
        } finally { opened.mockRestore(); }
        expect(after.bytes).toBeLessThan(before.bytes);
        expect(after.fileReads).toBe(before.fileReads);
        expect(identity.fileReads).toBeLessThan(after.fileReads);
        expect(identity.bytes).toBeLessThan(after.bytes);
        if (before.snapshot.status !== 'ok' || after.snapshot.status !== 'ok') throw new Error('Live census unavailable');
        expect(after.snapshot.rows[0]?.start).toEqual(before.snapshot.rows[0]?.start);
        expect(after.snapshot.rows[0]?.argv).toEqual(before.snapshot.rows[0]?.argv);
        expect(after.snapshot.rows[0]?.ownerTag).toEqual(before.snapshot.rows[0]?.ownerTag);
        console.info(`census allocation same-run legacy=${before.fileReads}files/${before.bytes}bytes current=${after.fileReads}files/${after.bytes}bytes identity=${identity.fileReads}files/${identity.bytes}bytes legacyMs=${before.elapsedMs.toFixed(1)} currentMs=${after.elapsedMs.toFixed(1)}`);
    });

    it('reads large UTF-8 and binary procfs files to EOF and closes descriptors on a read failure', async () => {
        const text = 'x'.repeat(4095) + '😀' + 'y'.repeat(100_000);
        const bytes = Buffer.from(text);
        let closed = 0;
        let fail = false;
        const opened = vi.spyOn(filesystem, 'open').mockImplementation(async () => {
            const handle = procfsFileHandle(bytes);
            const close = handle.close.bind(handle);
            handle.close = async () => { closed++; await close(); };
            if (fail) handle.read = async () => { throw Object.assign(new Error('procfs read failed'), { code: 'EIO' }); };
            return handle;
        });
        try {
            expect(await readLinuxProcFile('/proc/fixture/cmdline', 'utf8')).toBe(text);
            expect(await readLinuxProcFile('/proc/fixture/auxv')).toEqual(bytes);
            fail = true;
            await expect(readLinuxProcFile('/proc/fixture/status', 'utf8')).rejects.toMatchObject({ code: 'EIO' });
            expect(closed).toBe(3);
        } finally { opened.mockRestore(); }
    });

    it('drops a generation whose status disappears after stat, but retains unreadable live identities', async () => {
        for (const code of ['ENOENT', 'ESRCH', 'EACCES', 'EIO']) {
            const { files, boundary } = fixture();
            files.set('/proc/43/stat', stat(43, 430));
            const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: {
                ...boundary,
                async readFile(path) {
                    if (path === '/proc/43/status') throw Object.assign(new Error('status unavailable'), { code });
                    return boundary.readFile(path);
                },
            } });
            const snapshot = await reader({ freshness: 'fresh', scope: 'all' });
            expect(snapshot.status).toBe('ok');
            if (snapshot.status !== 'ok') throw new Error('Fixture census unavailable');
            const row = snapshot.rows.find(row => row.pid === 43);
            if (code === 'ENOENT' || code === 'ESRCH') {
                expect(row, code).toBeUndefined();
                expect(snapshot.partial?.some(partial => partial.pid === 43) ?? false).toBe(false);
            } else {
                expect(row, code).toMatchObject({ principal: null });
                expect(snapshot.partial).toContainEqual({ pid: 43, missing: ['status'] });
            }
        }
    });
    it('observes a verified legacy Job through the same census and retains members outside a PID filter', async () => {
        const name = 'Local\\happier-svc09-fixture';
        const self = { pid: 42, ppid: 1, start: { startTimeMs: 900 }, principal: { kind: 'sid', value: 'self' }, name: 'self', memory: null, cpuTimeUs: null };
        const reader = createProcessCensusReader({ platform: 'win32', selfPid: 42, helperExecutablePath: '/helper',
            async execFile(_file, args) {
                if (!args.includes(`--job=${name}`)) return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1, rows: [self] }) };
                return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1,
                    rows: [self, { ...self, pid: 43, jobs: [name] }], jobObservations: [{ name, state: 'live', pids: [43] }] }) };
            },
        });
        const snapshot = await reader({ freshness: 'fresh', pids: [], verifiedJobNames: [name] });
        expect(snapshot.status).toBe('ok');
        if (snapshot.status !== 'ok') return;
        expect(snapshot.rows.map(row => row.pid)).toEqual([42, 43]);
        expect(snapshot.jobObservations).toEqual([{ name, state: 'live', pids: [43] }]);
        const missing = createProcessCensusReader({ platform: 'win32', selfPid: 42, helperExecutablePath: '/helper',
            async execFile() { return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1, rows: [self] }) }; },
        });
        expect(await missing({ freshness: 'fresh', verifiedJobNames: [name] })).toEqual({ status: 'unavailable', reason: 'read_failed' });
    });
    it.each(['darwin', 'win32'] as const)('retries the next requested native census after a helper failure on %s', async platform => {
        let now = 1000;
        let failing = true;
        const reader = createProcessCensusReader({ platform, selfPid: 42, helperExecutablePath: '/helper', now: () => now,
            async execFile() {
                if (failing) throw new Error('helper failed');
                return { stdout: JSON.stringify({ v: 1, capturedAtMs: now, logicalCpus: 1, rows: [
                    { pid: 42, ppid: 1, start: { startTimeMs: 900 }, principal: { kind: platform === 'win32' ? 'sid' : 'uid', value: 'self' }, name: 'self', memory: null, cpuTimeUs: null },
                ] }) };
            },
        });
        expect((await reader({ freshness: 'shared' })).status).toBe('unavailable');
        failing = false;
        now = 2000;
        const recovered = await reader({ freshness: 'fresh' });
        expect(recovered.status).toBe('ok');
        expect(recovered.status === 'ok' && recovered.rows[0]?.start).toEqual({ startTimeMs: 900 });
        now = 2001;
        const next = await reader({ freshness: 'shared' });
        expect(next.status === 'ok' && next.capturedAtMs).toBe(2001);
    });
    it('does not share pending observations across distinct verified Job names', async () => {
        let release!: () => void;
        const paused = new Promise<void>(resolve => { release = resolve; });
        const reader = createProcessCensusReader({ platform: 'win32', selfPid: 42, helperExecutablePath: '/helper',
            async execFile(_file, args) {
                const name = args.find(arg => arg.startsWith('--job='))?.slice(6);
                await paused;
                return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1,
                    rows: [{ pid: 42, ppid: 1, start: { startTimeMs: 900 }, principal: { kind: 'sid', value: 'self' }, name: 'self', memory: null, cpuTimeUs: null }],
                    jobObservations: [{ name, state: 'absent' }] }) };
            },
        });
        const first = reader({ freshness: 'shared', verifiedJobNames: ['job-one'] });
        const second = reader({ freshness: 'shared', verifiedJobNames: ['job-two'] });
        release();
        const [one, two] = await Promise.all([first, second]);
        expect(one.status === 'ok' && one.jobObservations).toEqual([{ name: 'job-one', state: 'absent' }]);
        expect(two.status === 'ok' && two.jobObservations).toEqual([{ name: 'job-two', state: 'absent' }]);
    });
    it('reads Linux generations, counters and private fields without exposing another principal', async () => {
        const { files, boundary } = fixture();
        files.delete('/proc/43/environ');
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: boundary });
        const snapshot = await reader({ freshness: 'fresh', scope: 'all' });
        expect(snapshot.status).toBe('ok');
        if (snapshot.status !== 'ok') return;
        expect(snapshot.rows.map(row => row.pid)).toEqual([42, 43, 44]);
        const own = snapshot.rows.find(row => row.pid === 42)!;
        expect(own.start).toEqual({ startTimeMs: parseLinuxProcStartTimeMs(stat(42, 420)), native: 'linux-proc:420' });
        expect(own.memory).toEqual({ bytes: 12288, kind: 'rss' });
        expect(own.cpuTimeUs).toBe(200000);
        expect(own.sessionId).toBe(42);
        expect(own.argv).toEqual(['program', 'argument with spaces']);
        expect(own.ownerTag).toBe('v1.scope.session.id');
        expect(own.ownershipEnvironment).toEqual({ HAPPIER_HOME_DIR: '/home/user' });
        expect(snapshot.rows.find(row => row.pid === 43)?.state).toBe('zombie');
        expect(snapshot.partial).toContainEqual({ pid: 43, missing: ['environ'] });
        const other = snapshot.rows.find(row => row.pid === 44)!;
        expect(other.argv).toBeUndefined();
        expect(other.cwd).toBeUndefined();
        expect(other.ownerTag).toBeUndefined();
        expect(other.executablePath).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toContain('must not escape');
    });

    it('retains self in a filtered snapshot and rejects its absence even when the requested pid exists', async () => {
        const { files, boundary } = fixture();
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: boundary });
        const filtered = await reader({ freshness: 'fresh', pids: [43] });
        expect(filtered.status === 'ok' && filtered.rows.map(row => row.pid).sort((left, right) => left - right)).toEqual([42, 43]);
        files.delete('/proc/42/stat');
        expect(await reader({ freshness: 'fresh', pids: [43] })).toEqual({ status: 'unavailable', reason: 'self_absent' });
    });

    it('single-flights shared reads but fresh reads observe their own generation', async () => {
        const { boundary } = fixture();
        let release!: () => void;
        const paused = new Promise<void>(resolve => { release = resolve; });
        let generation = 0;
        const reader = createProcessCensusReader({ platform: 'linux', selfPid: 42, linuxBoundary: {
            ...boundary,
            async readFile(path: string) {
                if (path === '/proc/42/stat') {
                    const current = ++generation;
                    if (current === 1) await paused;
                    return stat(42, current * 100);
                }
                return boundary.readFile(path);
            },
        } });
        const shared = reader({ freshness: 'shared', pids: [42] });
        const alsoShared = reader({ freshness: 'shared', pids: [42] });
        const fresh = await reader({ freshness: 'fresh', pids: [42] });
        release();
        const [first, second] = await Promise.all([shared, alsoShared]);
        expect(first).toBe(second);
        expect(first.status === 'ok' && first.rows[0]?.start.startTimeMs).toBe(1000);
        expect(fresh.status === 'ok' && fresh.rows[0]?.start.startTimeMs).toBe(2000);
    });

    it.each(['linux', 'darwin', 'win32'] as const)('reports native census executions once per capture rather than once per shared caller on %s', async platform => {
        const { boundary } = fixture();
        let nativeReads = 0;
        // Logging is an output boundary; census decoding and sharing remain real.
        const diagnostics = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        try {
            const reader = createProcessCensusReader({ platform, selfPid: 42, logicalCpus: 1, helperExecutablePath: '/helper', linuxBoundary: {
                ...boundary, readdir: async () => { nativeReads++; return boundary.readdir(); },
            }, execFile: async () => {
                nativeReads++;
                return { stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1, rows: [
                    { pid: 42, ppid: 1, start: { startTimeMs: 900 }, principal: { kind: platform === 'win32' ? 'sid' : 'uid', value: 'self' },
                        name: 'private-name', argv: ['private-command'], cwd: '/private-directory', memory: null, cpuTimeUs: null },
                ] }) };
            } });
            await Promise.all(Array.from({ length: 8 }, () => reader({ freshness: 'shared', scope: 'all', fields: [] })));
            expect(nativeReads).toBe(1);
            const captures = () => diagnostics.mock.calls.filter(([message, data]) => message === '[process-census] Observation phase settled'
                && typeof data === 'object' && data !== null && 'phase' in data && data.phase === 'native_census');
            expect(captures()).toHaveLength(1);
            await Promise.all([reader({ freshness: 'fresh', fields: [] }), reader({ freshness: 'fresh', fields: [] })]);
            expect(nativeReads).toBe(3);
            expect(captures()).toHaveLength(3);
            await reader({ freshness: 'shared', pids: [42], fields: ['memory', 'cpuTimeUs'] });
            expect(nativeReads).toBe(platform === 'linux' ? 3 : 4);
            expect(captures()).toHaveLength(3);
            for (const [, data] of captures()) {
                expect(data).toEqual({ phase: 'native_census', platform, capturedAtMs: expect.any(Number), elapsedMs: expect.any(Number) });
            }
        } finally { diagnostics.mockRestore(); }
    });

    it.each([
        { platform: 'darwin', code: 'ENOENT', safeCode: 'ENOENT' },
        { platform: 'win32', code: 'ENOENT', safeCode: 'ENOENT' },
        { platform: 'win32', code: 1, safeCode: 1 },
        { platform: 'win32', code: 'private-native-error', safeCode: undefined },
    ] as const)('reports native execution failures safely on $platform ($code)', async ({ platform, code, safeCode }) => {
        const diagnostics = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        logger.flushSync();
        const before = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
        let now = 1000;
        let executions = 0;
        // Genuine native execution boundary; all exception text and incidental fields stay private.
        const execFile = async () => { executions++; throw Object.assign(new Error('private-native-error'), {
            code, path: '/private-native-error/helper', stderr: 'private-native-error', spawnargs: ['private-native-error'],
        }); };
        try {
            const captures = () => diagnostics.mock.calls.filter(([message]) => message === '[process-census] Observation phase settled');
            const missing = createProcessCensusReader({ platform, selfPid: 42, helperExecutablePath: null, execFile });
            expect(await missing({ freshness: 'fresh' })).toEqual({ status: 'unavailable', reason: 'helper_missing' });
            expect(executions).toBe(0);
            expect(captures()).toHaveLength(0);
            const failing = createProcessCensusReader({ platform, selfPid: 42, helperExecutablePath: '/helper', execFile, now: () => now });
            expect(await failing({ freshness: 'fresh' })).toEqual({ status: 'unavailable', reason: 'read_failed' });
            expect(executions).toBe(1);
            expect(captures()).toHaveLength(1);
            now = 2000;
            await failing({ freshness: 'fresh' });
            expect(executions).toBe(2);
            expect(captures()).toHaveLength(2);
            now = 60000;
            await failing({ freshness: 'fresh' });
            expect(executions).toBe(3);
            expect(captures()).toHaveLength(3);
            expect(JSON.stringify(captures())).not.toContain('private-native-error');
            logger.flushSync();
            const diagnostic = (existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '').slice(before.length);
            expect(diagnostic).toContain('[process-custody] Native sampling failed');
            expect(diagnostic).toMatch(/"command":\s*"process-census"/);
            if (safeCode !== undefined) expect(diagnostic).toMatch(new RegExp(`"errorCode":\\s*${JSON.stringify(safeCode)}`));
            else expect(diagnostic).not.toContain('errorCode');
            expect(diagnostic).not.toContain('private-native-error');
        } finally { diagnostics.mockRestore(); }
    });

    it.skipIf(process.platform !== 'linux')('matches the unchanged persisted witness for 20 live Linux processes', async () => {
        const started = performance.now();
        let eventLoopDelayMs = 0;
        const ready = new Promise<void>(resolve => setImmediate(() => { eventLoopDelayMs = performance.now() - started; resolve(); }));
        const census = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
        const readMs = performance.now() - started;
        await ready;
        expect(census.status).toBe('ok');
        if (census.status !== 'ok') return;
        const selected = [census.rows.find(row => row.pid === process.pid)!, ...census.rows.filter(row => row.pid !== process.pid)]
            .filter(row => row.principal !== null).slice(0, 20);
        const compared = await Promise.all(selected.map(async row => {
            const stat = await readFile(`/proc/${row.pid}/stat`, 'utf8').catch(() => null);
            if (stat === null) return false; // Exited after the snapshot, not a generation comparison.
            expect(parseLinuxProcStartTimeMs(stat)).toBe(row.start.startTimeMs);
            return true;
        }));
        expect(compared.every(Boolean)).toBe(true);
        expect(compared.length).toBe(20);
        console.info(`census-linux live parity=${compared.length} rows=${census.rows.length} readMs=${readMs.toFixed(1)} eventLoopDelayMs=${eventLoopDelayMs.toFixed(1)}`);
    });
    it.skipIf(process.platform !== 'darwin')('matches the predecessor whole-second witness through the live Darwin census owner', async () => {
        const started = performance.now();
        let eventLoopDelayMs = 0;
        const ready = new Promise<void>(resolve => setImmediate(() => { eventLoopDelayMs = performance.now() - started; resolve(); }));
        const snapshot = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
        const readMs = performance.now() - started;
        await ready;
        expect(snapshot.status).toBe('ok');
        if (snapshot.status !== 'ok') return;
        const self = snapshot.rows.find(row => row.pid === process.pid)!;
        const selected = [self, ...snapshot.rows.filter(row => row.pid !== process.pid)
            .sort((left, right) => left.start.startTimeMs - right.start.startTimeMs)].slice(0, 20);
        expect(selected).toHaveLength(20);
        for (const row of selected) {
            // The old reader's actual persisted derivation, not the migrated identity view.
            const result = await execFileWithDeadline('ps', ['-p', String(row.pid), '-o', 'lstart='], { encoding: 'utf8' });
            expect(Date.parse(String(result.stdout).trim())).toBe(row.start.startTimeMs);
        }
        console.info(`census-darwin live parity=${selected.length} rows=${snapshot.rows.length} readMs=${readMs.toFixed(1)} eventLoopDelayMs=${eventLoopDelayMs.toFixed(1)}`);
    });
});
