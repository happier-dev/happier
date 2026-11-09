import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { createHappierTempDir, removeHappierTempDir } from '@happier-dev/cli-common/tempDirs';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

import { measureNativeDisk, startNativeDiskScan, type NativeDiskScanRecord } from './nativeDiskMeasure';

const execute = promisify(execFile);
let disposeNative: (() => Promise<void>) | undefined;
let scratch: string;

// POSIX du independently reports allocated bytes; Windows allocation is covered by the Go NTFS fixtures.
describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('staged native disk helper on a real tree', () => {
    beforeAll(async () => {
        // Darwin's temp root may be reached through /var -> /private/var.
        // The helper intentionally refuses symlink ancestors; fixtures use its physical path.
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-disk-live-')));
        disposeNative = await createProcessCustodyFixture();
    });

    afterAll(async () => {
        await disposeNative?.();
        if (scratch) await rm(scratch, { recursive: true, force: true });
    });

    it('matches du allocation, counts hard links once and keeps per-path frees conservative', async () => {
        const a = join(scratch, 'a');
        const b = join(scratch, 'b');
        await mkdir(a);
        await mkdir(b);
        const shared = join(a, 'shared');
        await writeFile(shared, Buffer.alloc(32 * 1024, 42));
        await link(shared, join(b, 'shared'));
        await symlink(a, join(a, 'loop'));
        const sparse = await open(join(a, 'sparse'), 'w');
        await sparse.truncate(16 * 1024 * 1024);
        await sparse.close();

        const { stdout } = await execute('du', process.platform === 'linux'
            ? ['-s', '--block-size=1', a, b]
            : ['-sk', a, b]);
        const duBytes = stdout.trim().split('\n').reduce((sum, row) => sum + Number(row.split(/\s/u)[0]), 0)
            * (process.platform === 'darwin' ? 1024 : 1);
        const allocation = (await lstat(shared)).blocks * 512;
        const measured = await measureNativeDisk({ paths: [b, a] });
        expect(measured.totalAllocatedBytes).toBe(duBytes);
        expect(measured.perPath.map((row) => row.path)).toEqual([a, b]);
        // The union can free the cross-root inode; neither root can free it alone.
        expect(measured.totalExclusiveBytes).toBe(duBytes);
        expect(measured.perPath.reduce((sum, row) => sum + row.exclusiveBytes, 0)).toBe(duBytes - allocation);
        expect(measured.perPath.find((row) => row.path === a)?.sharedBytes).toBe(allocation);
        expect(measured.perPath.find((row) => row.path === b)?.sharedBytes).toBe(0);
        expect(measured.perPath.every((row) => !row.atLeast)).toBe(true);
        const both = await measureNativeDisk({ paths: [scratch] });
        // All links inside one selected path can go together; their bytes are exclusive.
        expect(both.totalExclusiveBytes).toBe(both.totalAllocatedBytes);
    });

    it('measures the canonical default temporary directory without symlink-ancestor uncertainty', async () => {
        const directory = createHappierTempDir({ purpose: 'disk-default-temp' });
        try {
            await writeFile(join(directory, 'data'), Buffer.alloc(8192, 7));
            const measured = await measureNativeDisk({ paths: [directory] });
            expect(measured.perPath[0]?.atLeast).toBe(false);
            const { stdout } = await execute('du', process.platform === 'linux'
                ? ['-s', '--block-size=1', directory] : ['-sk', directory]);
            const duBytes = Number(stdout.trim().split(/\s/u)[0]) * (process.platform === 'darwin' ? 1024 : 1);
            expect(measured.totalAllocatedBytes).toBe(duBytes);
        } finally {
            removeHappierTempDir(directory);
        }
    });

    it('streams breadth-first directory records and completes with independent allocated-byte truth', async () => {
        const root = join(scratch, 'scan');
        await mkdir(join(root, 'child'), { recursive: true });
        await writeFile(join(root, 'child', 'data'), Buffer.alloc(8192, 7));
        await symlink(root, join(root, 'loop'));
        const records: NativeDiskScanRecord[] = [];
        const scan = startNativeDiskScan({ root, keepMinBytes: 16384 }, { onRecord: (record) => records.push(record) });
        const summary = await scan.done;
        expect(summary.termination).toBe('completed');
        const { stdout } = await execute('du', process.platform === 'linux'
            ? ['-s', '--block-size=1', root] : ['-sk', root]);
        const duBytes = Number(stdout.trim().split(/\s/u)[0]) * (process.platform === 'darwin' ? 1024 : 1);
        expect(summary.allocatedBytes).toBe(duBytes);
        expect(records.filter((record): record is Extract<NativeDiskScanRecord, { type: 'dir-start' }> => record.type === 'dir-start').map((record) => record.id))
            .toEqual([root, join(root, 'child')]);
        const child = records.find((record) => record.type === 'dir' && record.complete && record.id === join(root, 'child'));
        expect(child).toMatchObject({ streamed: true, children: [], files: [], folded: { items: 1, allocatedBytes: 8192 } });
        const data = join(root, 'child', 'data');
        const entries = records.filter((record) => record.type === 'dir-entry' && record.node.id === data);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((record) => record.type === 'dir-entry' && !record.visible && record.node.allocatedBytes === 8192)).toBe(true);
        expect(records.some((record) => record.type === 'fact' && record.fact.pathId === data && record.fact.allocatedBytes === 8192)).toBe(true);
    });

    it('cancels the actual helper after streaming begins and waits for process close', async () => {
        const executable = resolveProcessCustodySupportExecutable(); expect(executable).toBeTruthy();
        const spool = createHappierTempDir({ purpose: 'disk-cancel-latency' });
        const child = spawn(executable!, ['disk-scan'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const lines = createInterface({ input: child.stdout });
        let killAt = 0;
        lines.on('line', line => {
            const record: unknown = JSON.parse(line);
            if (!killAt && typeof record === 'object' && record !== null && 'type' in record && record.type === 'dir-start') {
                killAt = performance.now(); child.kill('SIGKILL');
            }
        });
        const rawExit = new Promise<number>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', () => resolve(performance.now()));
        });
        child.stdin.write(JSON.stringify({ root: scratch, scratchDirectory: spool }) + '\n');
        try {
            const exitedAt = await rawExit;
            expect(killAt).toBeGreaterThan(0);
            console.log(JSON.stringify({ qa: 'raw-helper-cancel-to-exit', elapsedMs: exitedAt - killAt }));
        } finally { lines.close(); child.kill('SIGKILL'); removeHappierTempDir(spool); }
        const controller = new AbortController();
        let adapterKillAt = 0;
        const scan = startNativeDiskScan({ root: scratch }, {
            signal: controller.signal,
            onRecord: (record) => { if (record.type === 'dir-start') { adapterKillAt = performance.now(); controller.abort(); } },
        });
        await expect(scan.done).rejects.toMatchObject({ name: 'AbortError' });
        console.log(JSON.stringify({ qa: 'adapter-cancel-through-close-and-spool-cleanup', elapsedMs: performance.now() - adapterKillAt }));
    });

    it('consumes prior-directory hints while measuring changed files afresh', async () => {
        const root = join(scratch, 'prior-scan');
        await mkdir(root);
        const data = join(root, 'data');
        await writeFile(data, Buffer.alloc(8192, 7));
        const previousIndexPath = join(scratch, 'previous.ndjson');
        await writeFile(previousIndexPath, `${JSON.stringify({ v: 1, type: 'prior-dir', id: root, allocatedBytes: 1 })}\n`);
        await writeFile(data, Buffer.alloc(16384, 9));
        const records: NativeDiskScanRecord[] = [];
        const scan = startNativeDiskScan({ root, previousIndexPath }, { onRecord: (record) => records.push(record) });
        const summary = await scan.done;
        const { stdout } = await execute('du', process.platform === 'linux'
            ? ['-s', '--block-size=1', root] : ['-sk', root]);
        expect(summary.termination).toBe('completed');
        expect(summary.allocatedBytes).toBe(Number(stdout.trim().split(/\s/u)[0]) * (process.platform === 'darwin' ? 1024 : 1));
        const allocation = (await lstat(data)).blocks * 512;
        expect(records.some((record) => record.type === 'dir-entry' && record.node.id === data && record.node.allocatedBytes === allocation)).toBe(true);
    });

    it('exposes an invalid native prior-index error without a competing caller preflight', async () => {
        const scan = startNativeDiskScan({ root: scratch, previousIndexPath: join(scratch, 'previous-index') }, {
            onRecord: () => undefined,
        });
        await expect(scan.done).rejects.toMatchObject({
            code: 'native_disk_invalid_previous_index', exitCode: 5,
        });
    });
});
