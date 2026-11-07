import { EventEmitter } from 'node:events';
import { access, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';

import { measureNativeDisk, startNativeDiskScan } from './nativeDiskMeasure';
import { createStorageScanIndex } from '../scan/scanIndex';
import { createStorageScanRunner } from '../scan/scanRunner';
import { MachineStorageScanGetResultV1Schema } from '@happier-dev/protocol/storage/storageV1';

// The OS process boundary is simulated; executable resolution and the parser stay real.
const processBoundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(), spawn: processBoundary.spawn,
}));

class HelperProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly kill = vi.fn(() => true);
    close(code = 0) { this.emit('close', code, null); }
}

const result = {
    v: 1,
    perPath: [{ path: '/測定', allocatedBytes: 4096, exclusiveBytes: 0, sharedBytes: 4096,
        sharedExtentsUnmeasured: false, items: 1, atLeast: false, lastChangedAtMs: 1 }],
    totalAllocatedBytes: 4096, totalExclusiveBytes: 0,
};
let scratch: string;
let helper: HelperProcess;
const originalExecutable = Object.getOwnPropertyDescriptor(process, 'execPath')!;

beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'happier-disk-parser-'));
    const tools = join(scratch, 'tools', 'unpacked');
    await mkdir(tools, { recursive: true });
    await writeFile(join(tools, process.platform === 'win32' ? 'happier-process-custody.exe' : 'happier-process-custody'), '');
    Object.defineProperty(process, 'execPath', { ...originalExecutable, value: join(scratch, 'happier') });
    helper = new HelperProcess();
    processBoundary.spawn.mockReset().mockReturnValue(helper);
});

afterEach(async () => {
    Object.defineProperty(process, 'execPath', originalExecutable);
    await rm(scratch, { recursive: true, force: true });
});

describe('native disk measurement process boundary', () => {
    it.each([
        { reason: 'read_only_filesystem', excludedRoot: true },
        { reason: 'pseudo_or_cloud_filesystem', excludedRoot: true },
        { reason: 'read_only_filesystem', excludedRoot: false },
    ])('retains an ineligible root reason $reason through the scan lifecycle (root=$excludedRoot)', async ({ reason, excludedRoot }) => {
        const index = createStorageScanIndex({ activeServerDir: scratch });
        const runner = createStorageScanRunner({ index,
            readEnabled: () => true, readVolumes: () => [{ id: 'volume', mountPath: scratch, usedBytes: 0 }],
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize();
            const state = await runner.start({ target: { folderPath: scratch } });
            await vi.waitFor(() => expect(processBoundary.spawn).toHaveBeenCalledOnce());
            helper.stdout.write(JSON.stringify({ v: 1, type: 'summary', termination: 'completed', unreadable: [],
                unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, skipped: [{ path: excludedRoot ? scratch : join(scratch, 'excluded-child'), reason }],
                backendByDirCounts: {}, allocatedBytes: 0, items: 0 }) + '\n');
            helper.close();
            await runner.wait(state.scanId);
            const result = MachineStorageScanGetResultV1Schema.parse(await runner.get({ scanId: state.scanId }));
            if (!excludedRoot) {
                expect(result.state?.status).toBe('complete');
                expect(result.state?.unreadable.examples).toEqual([]);
                return;
            }
            expect(result.state?.status).toBe('failed');
            expect(result.state?.unreadable.examples).toContainEqual({ path: scratch, reason });
            expect(result.coverage).toContainEqual({ path: scratch, scannedAt: expect.any(Number), complete: false });
            expect(result.nodes).toEqual([]);
        } finally { await runner.dispose(); }
    });
    it.each([undefined, 0, 3])('persists observed APFS local snapshot count %s through the production runner and strict reader', async count => {
        const index = createStorageScanIndex({ activeServerDir: scratch });
        const runner = createStorageScanRunner({ index,
            readEnabled: () => true, readVolumes: () => [{ id: 'apfs', mountPath: scratch, usedBytes: 0, apfsContainerId: 'container' }],
            fullDiskAccess: () => ({ state: 'unknown', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize();
            const state = await runner.start({ target: { volumeId: 'apfs' } });
            await vi.waitFor(() => expect(processBoundary.spawn).toHaveBeenCalledOnce());
            helper.stdout.write(JSON.stringify({ v: 1, type: 'summary', termination: 'completed', unreadable: [],
                unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, skipped: [],
                backendByDirCounts: {}, allocatedBytes: 0, items: 0, apfsLocalSnapshotCount: count }) + '\n');
            helper.close();
            await runner.wait(state.scanId);
            const result = MachineStorageScanGetResultV1Schema.parse(await runner.get({ scanId: state.scanId }));
            expect(result.state).toMatchObject({ status: 'complete' });
            expect(result.state?.apfsLocalSnapshotCount).toBe(count);
            expect(result.nodes.some(node => node.kind === 'hidden-space')).toBe(false);
            index.close();
            const reopened = createStorageScanIndex({ activeServerDir: scratch });
            try {
                await reopened.initialize([{ id: 'apfs', mountPath: scratch, usedBytes: 0 }], true);
                expect(MachineStorageScanGetResultV1Schema.parse(reopened.readView({ scanId: state.scanId })).state?.apfsLocalSnapshotCount)
                    .toBe(count);
            } finally { reopened.close(); }
        } finally { await runner.dispose(); }
    });

    it('returns distinct native union totals from the same helper result', async () => {
        const measured = measureNativeDisk({ paths: ['/測定'], unions: [{ id: 'safe', paths: ['/測定'], excludeIncomplete: true }] });
        const output = { ...result, unions: [{ id: 'safe', totalAllocatedBytes: 4096, totalExclusiveBytes: 0, atLeast: false }] };
        helper.stdout.write(JSON.stringify(output) + '\n'); helper.close();
        await expect(measured).resolves.toEqual(output);
    });
    it('parses streamed directory entries and facts without requiring a whole-directory array', async () => {
        const records: unknown[] = [];
        const scan = startNativeDiskScan({ root: '/fixture' }, { onRecord: record => records.push(record) });
        const metadata = { v: 1, id: '/fixture', name: 'fixture', allocatedBytes: 4096, logicalBytes: 0,
            ownLogicalBytes: 0, items: 1, mtimeMs: 0, flags: { atLeast: false }, children: [], files: [],
            allocationFacts: [], streamed: true, folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 },
            ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false, enumerated: false };
        const expected = [
            { ...metadata, type: 'dir-start', relistOnly: false },
            { v: 1, type: 'dir-entry', parent: '/fixture', visible: true, retained: false, replaceFacts: true,
                node: { id: '/fixture/zero', name: 'zero', kind: 'file', allocatedBytes: 0, logicalBytes: 0,
                    items: 1, mtimeMs: 0, flags: { atLeast: false } } },
            { v: 1, type: 'fact', owner: '/fixture/zero', fact: { key: 'physical', allocatedBytes: 0,
                pathId: '/fixture/zero', mtimeMs: 0, ageIncluded: true } },
            { ...metadata, type: 'dir', complete: true, enumerated: true },
            { v: 1, type: 'frontier-start' },
            { v: 1, type: 'frontier-item', path: '/fixture/pending' },
        ];
        for (const record of expected) helper.stdout.write(JSON.stringify(record) + '\n');
        const summary = { v: 1, type: 'summary', termination: 'completed', unreadable: [],
            unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, skipped: [],
            backendByDirCounts: {}, allocatedBytes: 4096, items: 2, streamedFrontier: true, pendingFrontier: [] };
        helper.stdout.write(JSON.stringify(summary) + '\n'); helper.close();
        await expect(scan.done).resolves.toEqual(summary);
        expect(records).toEqual([...expected, summary]);
    });

    it.each(['success', 'cancel', 'consumer-failure'] as const)('owns scan spools until actual helper close: %s', async mode => {
        const scan = startNativeDiskScan({ root: '/fixture' }, { onRecord: () => {
            if (mode === 'consumer-failure') throw new Error('index write failed');
        } });
        const request: unknown = JSON.parse(helper.stdin.read().toString());
        expect(request).toMatchObject({ root: '/fixture', scratchDirectory: expect.any(String) });
        if (!request || typeof request !== 'object' || !('scratchDirectory' in request)
            || typeof request.scratchDirectory !== 'string') throw new Error('Missing owned scan scratch');
        const directory = request.scratchDirectory;
        const marker = getHappierTempDirOwnerPath(directory);
        expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ purpose: 'storage-scan', pid: process.pid });
        if (process.platform !== 'win32') expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        await writeFile(join(directory, 'frontier'), 'owned native spool');
        if (mode === 'cancel') scan.cancel();
        if (mode === 'consumer-failure') helper.stdout.write('{"v":1,"type":"progress","sizedBytes":0,"items":0}\n');
        if (mode === 'success') helper.stdout.write(JSON.stringify({ v: 1, type: 'summary', termination: 'completed',
            unreadable: [], unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, skipped: [],
            backendByDirCounts: {}, allocatedBytes: 0, items: 0 }) + '\n');
        const observed = scan.done.then(() => null, (error: unknown) => error);
        await access(directory); await access(marker);
        helper.close();
        const error = await observed;
        if (mode === 'success') expect(error).toBeNull();
        else expect(error).toMatchObject(mode === 'cancel' ? { name: 'AbortError' } : { code: 'native_disk_consumer_failed' });
        await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses ambiguous streamed aggregates carrying unconsumed file metadata', async () => {
        const scan = startNativeDiskScan({ root: '/fixture' }, { onRecord: () => undefined });
        helper.stdout.write(JSON.stringify({ v: 1, type: 'dir', streamed: true, id: '/fixture', name: 'fixture',
            allocatedBytes: 4096, logicalBytes: 0, items: 2, mtimeMs: 0, flags: { atLeast: false }, children: [],
            files: [{ id: '/fixture/data', name: 'data', kind: 'file', allocatedBytes: 4096, logicalBytes: 0,
                items: 1, mtimeMs: 0, flags: { atLeast: false } }],
            folded: { items: 1, allocatedBytes: 4096, logicalBytes: 0 },
            ageGroupBytes: { unknown: 4096, months3: 0, months6: 0, months12: 0 }, complete: true }) + '\n');
        helper.stdout.write(JSON.stringify({ v: 1, type: 'summary', termination: 'completed', unreadable: [],
            unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, skipped: [],
            backendByDirCounts: {}, allocatedBytes: 4096, items: 2 }) + '\n');
        helper.close();
        await expect(scan.done).rejects.toMatchObject({ code: 'invalid_native_disk_output' });
    });

    it('retires the helper and its spools when the immediate SQLite batch commit fails', async () => {
        const scan = startNativeDiskScan({ root: '/fixture' }, { onRecord: () => undefined,
            onRecordBatch: consume => { consume(); throw new Error('SQLite commit failed'); } });
        helper.stdout.write('{"v":1,"type":"progress","sizedBytes":0,"items":0}\n');
        helper.stdout.write(JSON.stringify({ v: 1, type: 'summary', termination: 'completed', unreadable: [],
            unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, skipped: [],
            backendByDirCounts: {}, allocatedBytes: 0, items: 0 }) + '\n');
        helper.close();
        await expect(scan.done).rejects.toMatchObject({ code: 'native_disk_consumer_failed' });
        expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('parses a fragmented UTF-8 result and waits for successful process retirement', async () => {
        const measured = measureNativeDisk({ paths: ['/測定'] });
        const bytes = Buffer.from(JSON.stringify(result) + '\n');
        const split = bytes.indexOf(Buffer.from('測')) + 1;
        helper.stdout.write(bytes.subarray(0, split));
        helper.stdout.write(bytes.subarray(split));
        helper.close();
        await expect(measured).resolves.toEqual(result);
        expect(processBoundary.spawn.mock.calls[0]?.slice(0, 2)).toEqual([
            join(scratch, 'tools', 'unpacked', process.platform === 'win32' ? 'happier-process-custody.exe' : 'happier-process-custody'),
            ['disk-measure'],
        ]);
        expect(helper.stdin.read().toString()).toBe('{"paths":["/測定"]}\n');
    });

    it('cancels the helper immediately and rejects only after it has exited', async () => {
        const controller = new AbortController();
        const measured = measureNativeDisk({ paths: ['/fixture'] }, { signal: controller.signal });
        let settled = false;
        const observed = measured.catch((error: unknown) => { settled = true; throw error; });
        controller.abort();
        expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
        await Promise.resolve();
        expect(settled).toBe(false);
        helper.close();
        await expect(observed).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects truncation, duplicate results and invalid byte counts', async () => {
        for (const output of [
            JSON.stringify(result).slice(0, -2),
            JSON.stringify(result) + '\n' + JSON.stringify(result) + '\n',
            JSON.stringify({ ...result, totalAllocatedBytes: -1 }) + '\n',
            ...[0, -1, 1767441600000.5, Number.MAX_SAFE_INTEGER + 1].map((lastChangedAtMs) =>
                JSON.stringify({ ...result, perPath: result.perPath.map((path) => ({ ...path, lastChangedAtMs })) }) + '\n'),
        ]) {
            helper = new HelperProcess();
            processBoundary.spawn.mockReturnValue(helper);
            const measured = measureNativeDisk({ paths: ['/fixture'] });
            helper.stdout.write(output);
            helper.close();
            await expect(measured).rejects.toMatchObject({ code: 'invalid_native_disk_output' });
        }
    });

    it('does not accept a valid result from a failed helper', async () => {
        const measured = measureNativeDisk({ paths: ['/fixture'] });
        helper.stdout.write(JSON.stringify(result) + '\n');
        helper.stderr.write('native metadata failure');
        helper.close(5);
        await expect(measured).rejects.toMatchObject({ code: 'native_disk_failed', exitCode: 5 });
    });

    it('preserves the native typed invalid-index error and rejects malformed diagnostic shapes', async () => {
        for (const extraFields of [false, true]) {
            helper = new HelperProcess();
            processBoundary.spawn.mockReturnValue(helper);
            const scan = startNativeDiskScan({ root: '/fixture', previousIndexPath: '/fixture/index' }, {
                onRecord: () => undefined,
            });
            helper.stderr.write(JSON.stringify({ v: 1, code: 'native_disk_invalid_previous_index',
                message: 'invalid projection', ...(extraFields ? { unknown: true } : {}) }) + '\n');
            helper.close(5);
            await expect(scan.done).rejects.toMatchObject(extraFields
                ? { code: 'native_disk_failed', exitCode: 5 }
                : { code: 'native_disk_invalid_previous_index', exitCode: 5 });
        }
    });

    it('does not spawn when the request was already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(measureNativeDisk({ paths: ['/fixture'] }, { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(processBoundary.spawn).not.toHaveBeenCalled();
    });

    it('reports unavailable when the canonical staged helper is absent', async () => {
        await rm(join(scratch, 'tools', 'unpacked', process.platform === 'win32' ? 'happier-process-custody.exe' : 'happier-process-custody'));
        await expect(measureNativeDisk({ paths: ['/fixture'] })).rejects.toMatchObject({ code: 'native_disk_unavailable' });
        expect(processBoundary.spawn).not.toHaveBeenCalled();
    });

    it('streams finished folders, sends skip and requires a final scan summary', async () => {
        const records: unknown[] = [];
        const scan = startNativeDiskScan({ root: '/fixture' }, { onRecord: (record) => records.push(record) });
        const permission = { v: 1, type: 'permission', fullDiskAccess: { state: 'unknown',
            binary: { name: 'happier-process-custody', path: '/tools/happier-process-custody' }, waitingForConsent: true } };
        helper.stdout.write(JSON.stringify(permission) + '\n');
        const dir = { v: 1, type: 'dir', id: '/fixture', name: 'fixture', allocatedBytes: 4096,
            directChildIds: ['/fixture/cached'], retainedSubtrees: ['/fixture/cached'],
            ownLogicalBytes: 0,
            allocationFacts: [{ key: '1:inode', allocatedBytes: 4096, pathId: '/fixture', mtimeMs: 0, ageIncluded: false }],
            logicalBytes: 0, items: 1, mtimeMs: 0, flags: { atLeast: true }, children: [], files: [],
            folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 },
            ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false, enumerated: true };
        const summary = { v: 1, type: 'summary', termination: 'interrupted', pendingFrontier: ['/fixture/pending'], unreadable: [],
            unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, skipped: [],
            backendByDirCounts: { linux: 1 }, allocatedBytes: 4096, items: 1 };
        helper.stdout.write(JSON.stringify(dir) + '\n');
        expect(records).toEqual([permission, dir]);
        const heartbeat = { v: 1, type: 'progress', sizedBytes: 4096, items: 1, currentPath: '/fixture/slow', stuckSinceMs: 100 };
        helper.stdout.write(JSON.stringify(heartbeat) + '\n');
        expect(records).toEqual([permission, dir, heartbeat]);
        const request: unknown = JSON.parse(helper.stdin.read().toString());
        const skipped = new Promise<unknown>(resolve => helper.stdin.once('data', chunk => resolve(JSON.parse(chunk.toString()) as unknown)));
        scan.skip('/fixture/slow');
        expect(request).toEqual({ root: '/fixture', scratchDirectory: expect.any(String) });
        await expect(skipped).resolves.toEqual({ type: 'skip', path: '/fixture/slow' });
        helper.stdout.write(JSON.stringify(summary) + '\n');
        helper.close();
        await expect(scan.done).resolves.toEqual(summary);
    });

    it('rejects a scan ending without a summary and kills after a consumer failure', async () => {
        const scan = startNativeDiskScan({ root: '/fixture' }, { onRecord: () => undefined });
        helper.close();
        await expect(scan.done).rejects.toMatchObject({ code: 'invalid_native_disk_output' });

        helper = new HelperProcess();
        processBoundary.spawn.mockReturnValue(helper);
        const failing = startNativeDiskScan({ root: '/fixture' }, { onRecord: () => { throw new Error('index write failed'); } });
        helper.stdout.write('{"v":1,"type":"progress","sizedBytes":4096,"items":1}\n');
        expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
        helper.close();
        await expect(failing.done).rejects.toMatchObject({ code: 'native_disk_consumer_failed' });
    });

    it('rejects trailing junk after a result even without a final newline', async () => {
        const measured = measureNativeDisk({ paths: ['/fixture'] });
        helper.stdout.write(JSON.stringify(result) + '\ntruncated junk');
        helper.close();
        await expect(measured).rejects.toMatchObject({ code: 'invalid_native_disk_output' });
    });
});
