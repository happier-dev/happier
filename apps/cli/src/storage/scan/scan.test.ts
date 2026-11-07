import * as fsPromises from 'node:fs/promises';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { getHappierTempDirOwnerPath, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { STORAGE_CHART_MAX_DRAWABLE_NODES, MachineStorageScanGetResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createStorageScanIndex } from './scanIndex';
import { createStorageScanRunner } from './scanRunner';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { measureNativeDisk, startNativeDiskScan, type NativeDiskScanRecord } from '../measure/nativeDiskMeasure';
import { readStorageScanHints } from '../suggestions/recognizers';

// Only the OS open boundary is interceptable; every default filesystem operation remains real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: vi.fn(actual.open) };
});
let disposeNative: (() => Promise<void>) | undefined;
let scratch: string;
describe('resident streamed disk index', () => {
    it.skipIf(process.platform === 'win32')('excludes boot EFI partitions from volume and folder scan admission', async () => {
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'system-partitions') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'root', mountPath: '/', usedBytes: 1 },
            { id: 'efi', mountPath: '/boot/efi', usedBytes: 1 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: '' } }) });
        try {
            await runner.initialize();
            await expect(runner.start({ target: { volumeId: 'efi' } })).rejects.toMatchObject({ code: 'storage_system_partition' });
            await expect(runner.start({ target: { folderPath: '/boot/efi/EFI' } })).rejects.toMatchObject({ code: 'storage_system_partition' });
        } finally { await runner.dispose(); }
    });
    beforeAll(async () => {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-scan-test-')));
        disposeNative = await createProcessCustodyFixture();
    });
    afterAll(async () => { await disposeNative?.(); if (scratch) await rm(scratch, { recursive: true, force: true }); });
    it('clears recovered stuck and current-path facts from the next native progress snapshot', async () => {
        const root = join(scratch, 'progress-root');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'progress-state') });
        await index.initialize([], true);
        const state = await index.begin({ volumeId: 'progress', root, target: { folderPath: root }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        try {
            index.ingest('progress', { v: 1, type: 'progress', sizedBytes: 0, items: 1, currentPath: root, stuckSinceMs: 1000 });
            expect(index.state(state.scanId)?.progress.stuckSinceMs).toBe(1000);
            index.ingest('progress', { v: 1, type: 'progress', sizedBytes: 4096, items: 2, currentPath: join(root, 'active') });
            expect(index.state(state.scanId)?.progress).toEqual({ sizedBytes: 4096, items: 2, currentPath: join(root, 'active') });
            index.ingest('progress', { v: 1, type: 'progress', sizedBytes: 8192, items: 3 });
            expect(index.state(state.scanId)?.progress).toEqual({ sizedBytes: 8192, items: 3 });
        } finally { index.close(); }
    });
    it('keeps folder estimates unknown and whole-volume progress relative to volume usage', async () => {
        const volume = join(scratch, 'progress-volume'); const folder = join(volume, 'folder');
        await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'data'), Buffer.alloc(8192));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'progress-volume-state') });
        let usedBytes = 2_000_000;
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'progress-volume', mountPath: volume, usedBytes }],
            readEnabled: () => true, fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize();
            const folderScan = await runner.start({ target: { folderPath: folder } });
            expect(folderScan.progress).not.toHaveProperty('usedBytes');
            await runner.wait(folderScan.scanId);
            expect(MachineStorageScanGetResultV1Schema.parse(await runner.get()).state?.progress).not.toHaveProperty('usedBytes');
            const volumeScan = await runner.start({ target: { volumeId: 'progress-volume' } });
            expect(volumeScan.progress.usedBytes).toBe(2_000_000);
            await runner.wait(volumeScan.scanId);
            expect(MachineStorageScanGetResultV1Schema.parse(await runner.get()).state?.progress.usedBytes).toBe(2_000_000);
            usedBytes = 0;
            const emptyVolumeScan = await runner.start({ target: { volumeId: 'progress-volume' } });
            expect(emptyVolumeScan.progress.usedBytes).toBe(0);
            await runner.wait(emptyVolumeScan.scanId);
            expect(MachineStorageScanGetResultV1Schema.parse(await runner.get()).state?.progress.usedBytes).toBe(0);
        } finally { await runner.dispose(); }
    });
    it('adds each resumed native invocation to retained target progress without counting old work twice', async () => {
        const root = join(scratch, 'resume-progress'); await mkdir(root);
        await writeFile(join(root, 'data'), Buffer.alloc(8192));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'resume-progress-state') });
        const admission = { volumeId: 'resume-progress', root, target: { folderPath: root }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } } as const;
        try {
            await index.initialize([], true); await index.begin(admission);
            const native = startNativeDiskScan({ root }, { onRecord: record => index.ingest(admission.volumeId, record) });
            await native.done; index.finish(admission.volumeId, 'cancelled');
            const kept = index.state()!.progress;
            await index.begin({ ...admission, resume: true });
            index.ingest(admission.volumeId, { v: 1, type: 'progress', sizedBytes: 0, items: 0, currentPath: root });
            expect(index.state()!.progress).toEqual({ ...kept, currentPath: root });
            index.ingest(admission.volumeId, { v: 1, type: 'progress', sizedBytes: 4096, items: 2, currentPath: root });
            expect(index.state()!.progress).toEqual({ ...kept, sizedBytes: kept.sizedBytes + 4096, items: kept.items + 2, currentPath: root });
            // Latest-wins is an invocation snapshot, not another increment.
            index.ingest(admission.volumeId, { v: 1, type: 'progress', sizedBytes: 4096, items: 2 });
            expect(index.state()!.progress).toEqual({ ...kept, sizedBytes: kept.sizedBytes + 4096, items: kept.items + 2 });
        } finally { index.close(); }
    });
    it.each([
        { childComplete: true, replaceChild: false },
        { childComplete: false, replaceChild: false },
        { childComplete: true, replaceChild: true },
    ])('retains measured descendants when a resumed parent enumeration is cancelled again (complete: $childComplete, replaced: $replaceChild)', async ({ childComplete, replaceChild }) => {
        const fixture = `partial-parent-resume-${childComplete}-${replaceChild}`;
        const root = join(scratch, fixture); const child = join(root, 'measured');
        await mkdir(child, { recursive: true }); await writeFile(join(child, 'data'), Buffer.alloc(8192));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, `${fixture}-state`) });
        const admission = { volumeId: 'partial-parent-resume', root, target: { folderPath: root }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } } as const;
        try {
            await index.initialize([], true); await index.begin(admission);
            // Model the interrupted state observed live: child facts reached the
            // index before the parent's enumeration proof. Use real producer
            // records for all entry, coverage and physical-identity shapes.
            const first = startNativeDiskScan({ root, keepMinBytes: 0 }, { onRecord: record => {
                if (record.type.startsWith('frontier') || record.type === 'dir' && (record.id === root || !childComplete && record.id === child)) return;
                index.ingest(admission.volumeId, record);
            } });
            await first.done; index.finish(admission.volumeId, 'cancelled');
            const kept = index.state()!.progress.sizedBytes;
            const completedChild = index.readNode(child)!;
            expect(completedChild.complete).toBe(childComplete);
            expect(kept).toBe((await measureNativeDisk({ paths: [root] })).totalAllocatedBytes);
            expect(index.frontier(admission.volumeId)).toContain(root);
            if (replaceChild) {
                await rename(child, join(scratch, `${fixture}-retired`));
                await mkdir(child); await writeFile(join(child, 'replacement'), Buffer.alloc(4096));
            }
            await index.begin({ ...admission, resume: true });
            const prior = await index.writePriorProjection(admission.volumeId, { resume: true });
            let cut = false; let sawChild = false;
            try {
                const resumed = startNativeDiskScan({ root, resumeFrom: [], previousIndexPath: prior!.path, keepMinBytes: 0 }, { onRecord: record => {
                    if (cut) return;
                    index.ingest(admission.volumeId, record);
                    // An abrupt transport/process stop may land immediately after
                    // rediscovering the same child, before another child fact arrives.
                    if (record.type === 'dir-entry' && record.node.id === child) { sawChild = true; cut = true; }
                } });
                await resumed.done;
            } finally { await prior?.dispose(); }
            expect(sawChild).toBe(true);
            index.finish(admission.volumeId, 'cancelled');
            const page = MachineStorageScanGetResultV1Schema.parse(index.readView({ view: { tab: 'folders', depth: 1 } }));
            expect(page.root!.size.allocatedBytes).toBe(page.state!.progress.sizedBytes);
            if (replaceChild) expect(index.readNode(join(child, 'data'))).toBeNull();
            else {
                expect(page.state!.progress.sizedBytes).toBe(kept);
                expect(page.nodes.find(node => node.nodeId === child)).toEqual(completedChild.node);
                expect(index.readNode(child)?.scannedAt).toBe(completedChild.scannedAt);
            }
            await index.begin({ ...admission, resume: true });
            const finalPrior = await index.writePriorProjection(admission.volumeId, { resume: true });
            try {
                const final = startNativeDiskScan({ root, resumeFrom: [], previousIndexPath: finalPrior!.path, keepMinBytes: 0 }, {
                    onRecord: record => index.ingest(admission.volumeId, record),
                });
                index.finish(admission.volumeId, await final.done);
            } finally { await finalPrior?.dispose(); }
            expect(index.state()!.progress.sizedBytes).toBe((await measureNativeDisk({ paths: [root] })).totalAllocatedBytes);
            expect(index.readNode(root)?.complete).toBe(true);
            if (childComplete && !replaceChild) expect(index.readNode(child)?.scannedAt).toBe(completedChild.scannedAt);
        } finally { index.close(); }
    });
    it('keeps finished folders visible after abrupt cancellation, reopens them, and resumes only unfinished folders', async () => {
        const volume = join(scratch, 'cancel-volume'); const root = join(volume, 'selected'); const finished = join(root, 'finished');
        await mkdir(finished, { recursive: true }); await writeFile(join(finished, 'data'), Buffer.alloc(8192));
        // Enough streamed metadata to cross stdout chunks; the priority folder
        // completes while the rest is still being delivered by the real helper.
        for (let directory = 0; directory < 128; directory++) {
            const path = join(root, `pending-${directory}`); await mkdir(path);
            for (let file = 0; file < 16; file++) await writeFile(join(path, `file-${file}`), 'data');
        }
        const activeServerDir = join(scratch, 'cancel-state');
        const volumes = [{ id: 'cancel', mountPath: volume, usedBytes: 0 }];
        const index = createStorageScanIndex({ activeServerDir });
        let cancelling: Promise<unknown> | undefined; let requested = false; let requestedAt = 0; let finishedAt = 0; let finishMs = 0;
        const runner = createStorageScanRunner({ index: { ...index, finish(volumeId, summary) {
            const started = performance.now(); index.finish(volumeId, summary); finishMs += performance.now() - started;
        } }, readVolumes: () => volumes, readEnabled: () => true,
            readScanHints: () => ({ priorityHints: [finished] }),
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }),
            onChange: () => {
                if (requested || !index.readNode(root)?.materialized || !index.readNode(finished)?.complete) return;
                requested = true;
                // Cancel between committed stdout batches, as a real RPC does.
                // Cancelling from inside a batch would intentionally roll it back.
                queueMicrotask(() => { requestedAt = performance.now(); cancelling = runner.cancel(index.state()!.scanId).then(result => {
                    finishedAt = performance.now(); return result;
                }); });
            } });
        let reopenedRunner: ReturnType<typeof createStorageScanRunner> | undefined;
        try {
            await runner.initialize(); const first = await runner.start({ target: { folderPath: root } }); await runner.wait(first.scanId); await cancelling;
            expect(requested).toBe(true);
            console.log(JSON.stringify({ qa: 'scan-cancel-phases', cancelToSettledMs: finishedAt - requestedAt, indexFinishMs: finishMs }));
            const page = MachineStorageScanGetResultV1Schema.parse(await runner.get({ scanId: first.scanId, view: { tab: 'folders', depth: 1 } }));
            const retained = index.readNode(finished)!;
            expect(page.state?.status).toBe('cancelled');
            expect(page.nodes.find(node => node.nodeId === finished)).toMatchObject({ size: { allocatedBytes: retained.node.size.allocatedBytes, atLeast: false } });
            expect(retained).toMatchObject({ complete: true });
            expect(retained.node.size.allocatedBytes).toBe((await measureNativeDisk({ paths: [finished] })).totalAllocatedBytes);
            expect(page.root?.flags.atLeast).toBe(true);
            expect(page.state?.progress.sizedBytes).toBe(page.root?.size.allocatedBytes);
            expect(page.state?.progress.items).toBe(page.root?.items);
            expect(index.frontier('cancel')).not.toContain(root); expect(index.frontier('cancel')).not.toContain(finished);
            await runner.dispose();
            const reopened = createStorageScanIndex({ activeServerDir });
            const resumedProgress: { sizedBytes: number; items: number }[] = [];
            reopenedRunner = createStorageScanRunner({ index: reopened, readVolumes: () => volumes, readEnabled: () => true,
                onChange: () => { const progress = reopened.state()?.progress; if (progress) resumedProgress.push({ sizedBytes: progress.sizedBytes, items: progress.items }); },
                fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
            await reopenedRunner.initialize();
            const restored = MachineStorageScanGetResultV1Schema.parse(await reopenedRunner.get({ scanId: first.scanId, view: { tab: 'folders', depth: 1 } }));
            expect(restored.nodes.find(node => node.nodeId === finished)).toEqual(page.nodes.find(node => node.nodeId === finished));
            const resumed = await reopenedRunner.start({ target: first.target, resume: true }); await reopenedRunner.wait(resumed.scanId);
            expect(resumed.scanId).toBe(first.scanId); expect(reopened.state()?.status).toBe('complete');
            expect(resumedProgress.length).toBeGreaterThan(0);
            for (const progress of resumedProgress) {
                expect(progress.sizedBytes).toBeGreaterThanOrEqual(restored.state!.progress.sizedBytes);
                expect(progress.items).toBeGreaterThanOrEqual(restored.state!.progress.items);
            }
            expect(reopened.readNode(finished)?.scannedAt).toBe(retained.scannedAt);
            expect(reopened.readNode(root)?.node.size.allocatedBytes).toBe((await measureNativeDisk({ paths: [root] })).totalAllocatedBytes);
            expect(reopened.readNode(root)).toMatchObject({ complete: true, node: { flags: { atLeast: false } } });
        } finally { await runner.dispose(); await reopenedRunner?.dispose(); }
    });
    it('stops writing a resume projection when its scan is cancelled before helper admission', async () => {
        const root = join(scratch, 'cancel-prior'); await mkdir(root);
        await writeFile(join(root, 'retained'), Buffer.alloc(8192));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'cancel-prior-state') });
        const volumes = [{ id: 'cancel-prior', mountPath: root, usedBytes: 0 }];
        const runner = createStorageScanRunner({ index, readVolumes: () => volumes, readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        let release!: () => void; const heldWrite = new Promise<void>(resolve => { release = resolve; });
        let reached!: () => void; const writing = new Promise<void>(resolve => { reached = resolve; });
        const originalOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
        let cancelled = false; let writesAfterCancel = 0; let ownedDirectory: string | undefined;
        await runner.initialize();
        const first = await runner.start({ target: { folderPath: root } }); await runner.wait(first.scanId);
        // A stopped invocation can retain a fully measured tree. A completed
        // invocation would instead admit a fresh replacement on the next start.
        index.finish('cancel-prior', 'cancelled');
        const retained = index.state(first.scanId)!.progress.sizedBytes;
        // Hold one genuine OS write; SQLite, projection iteration and the runner remain real.
        const boundary = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            if (typeof args[0] !== 'string' || basename(args[0]) !== 'prior.ndjson') return handle;
            ownedDirectory = dirname(args[0]); const write = handle.write.bind(handle); let firstWrite = true;
            vi.spyOn(handle, 'write').mockImplementation(async (...writeArgs: Parameters<typeof handle.write>) => {
                if (cancelled) writesAfterCancel += 1;
                const result = await write(...writeArgs);
                if (firstWrite) { firstWrite = false; reached(); await heldWrite; }
                return result;
            });
            return handle;
        });
        try {
            const resumed = await runner.start({ target: first.target, resume: true }); await writing;
            expect(runner.activeNativePid(resumed.scanId)).toBeUndefined();
            const stopping = runner.cancel(resumed.scanId); cancelled = true; release();
            expect(await stopping).toMatchObject({ status: 'cancelled', progress: { sizedBytes: retained } });
            // Continuing the remaining on-disk projection is the reproduced cancellation delay.
            expect(writesAfterCancel).toBe(0);
            expect(ownedDirectory).toBeDefined();
            await expect(stat(ownedDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(getHappierTempDirOwnerPath(ownedDirectory!))).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { release(); boundary.mockRestore(); await runner.dispose(); }
    });
    it.each(['open', 'close'] as const)('removes prior-projection scratch and ownership after a filesystem %s failure', async phase => {
        const root = join(scratch, `projection-${phase}`); const volumeId = `projection-${phase}`;
        const index = createStorageScanIndex({ activeServerDir: join(scratch, `projection-${phase}-state`) });
        await index.initialize([], true); await index.begin({ volumeId, root, target: { folderPath: root }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        const failure = Object.assign(new Error(`Filesystem ${phase} failed`), { code: 'EIO' }); let ownedDirectory: string | undefined;
        const originalOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
        // Fault only the OS file operation; the temporary-directory owner and SQLite path stay real.
        const boundary = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
            if (typeof args[0] !== 'string' || basename(args[0]) !== 'prior.ndjson') return originalOpen(...args);
            ownedDirectory = dirname(args[0]); if (phase === 'open') throw failure;
            const handle = await originalOpen(...args); const originalClose = handle.close.bind(handle);
            vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await originalClose(); throw failure; }); return handle;
        });
        try {
            await expect(index.writePriorProjection(volumeId, { resume: true })).rejects.toBe(failure);
            boundary.mockRestore(); expect(ownedDirectory).toBeDefined();
            await expect(stat(ownedDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(getHappierTempDirOwnerPath(ownedDirectory!))).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { boundary.mockRestore(); index.close(); if (ownedDirectory) await removeHappierTempDirAsync(ownedDirectory); }
    });
    it('reopens the real SQLite index after an interrupted seen/retained column migration', async () => {
        const root = join(scratch, 'partial-columns'); const activeServerDir = join(scratch, 'partial-columns-state');
        await mkdir(root); const leaf = join(root, 'kept-facts'); await writeFile(leaf, 'x');
        const alias = join(root, 'alias'); if (process.platform !== 'win32') await symlink(leaf, alias);
        const volumes = [{ id: 'partial-columns', mountPath: root, usedBytes: 0 }]; const index = createStorageScanIndex({ activeServerDir });
        await index.initialize(volumes, true); await index.begin({ volumeId: volumes[0].id, root, target: { volumeId: volumes[0].id }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        const native = startNativeDiskScan({ root, keepMinBytes: 0 }, { onRecord: record => index.ingest(volumes[0].id, record) });
        await native.done; const originalLeaf = index.readNode(leaf)!; index.close();
        const directory = join(activeServerDir, 'storage', 'scans'); const file = (await readdir(directory)).find(name => name.endsWith('.sqlite'))!;
        const database = openProtectedSqliteDatabaseSync(join(directory, file));
        // The former two autocommitted ALTERs could be interrupted after seen was added.
        database.exec(`CREATE TABLE old_nodes AS SELECT id,parent,name,kind,allocated,changed,items,visible,data,seen FROM nodes;
            CREATE TABLE old_files AS SELECT * FROM files;
            CREATE TABLE old_observations AS SELECT owner,path,key,allocated,sort,mtime FROM observations;
            DROP VIEW files; DROP VIEW nodes; DROP VIEW observations;
            ALTER TABLE old_nodes RENAME TO nodes; ALTER TABLE old_files RENAME TO files; ALTER TABLE old_observations RENAME TO observations;
            DROP TABLE entries; DROP TABLE paths; DROP TABLE allocation_observations;`); database.close();
        const reopened = createStorageScanIndex({ activeServerDir });
        try { await reopened.initialize(volumes, true); expect(reopened.state()?.status).toBe('interrupted');
            expect(reopened.readNode(leaf)).toEqual(originalLeaf);
            if (process.platform !== 'win32') expect(reopened.readNode(alias)).not.toBeNull();
            expect(reopened.readView({ view: { tab: 'large', depth: 1, minBytes: 0, pageSize: 10 } }).nodes.map(node => node.nodeId)).toEqual([leaf]);
            expect((await reopened.stats(volumes[0].id)).fileRows).toBe(1);
            reopened.ingest(volumes[0].id, { v: 1, type: 'fact', owner: root, fact: { key: 'directory-self', pathId: root, allocatedBytes: 0, mtimeMs: 2000, ageIncluded: false } }); }
        finally { reopened.close(); }
    });
    it('checks a queued Skip path without loading a ten-times-wider persisted frontier into the writer heap', async () => {
        const root = join(scratch, 'wide-skip'); const activeServerDir = join(scratch, 'wide-skip-state'); await mkdir(root);
        const index = createStorageScanIndex({ activeServerDir }); const volumes = [{ id: 'wide-skip', mountPath: root, usedBytes: 0 }];
        await index.initialize(volumes, true);
        const runner = createStorageScanRunner({ index, readVolumes: () => volumes, readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        let release!: () => void; const heldAuthority = new Promise<void>(resolve => { release = resolve; });
        let reached!: () => void; const authorityReached = new Promise<void>(resolve => { reached = resolve; }); let admitted = false;
        // Hold the genuine before-effect authority boundary after index admission and prior projection.
        const state = await runner.start({ target: { volumeId: volumes[0].id } }, { beforeEffect: async () => {
            if (!admitted) { admitted = true; return; } reached(); await heldAuthority;
        } });
        await authorityReached;
        const directory = join(activeServerDir, 'storage', 'scans'); const file = (await readdir(directory)).find(name => name.endsWith('.sqlite'))!;
        const database = openProtectedSqliteDatabaseSync(join(directory, file));
        // Full collection before each sample removes unrelated test allocations; no index method is intercepted.
        setFlagsFromString('--expose_gc'); const collect: () => void = runInNewContext('gc'); setFlagsFromString('--no-expose_gc');
        const sample = (rows: number): number => {
            database.exec('DELETE FROM frontier');
            database.prepare('WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<?) INSERT INTO frontier(path) SELECT ? || n || ? FROM counter')
                .run(rows, join(root, 'queued-'), '-'.repeat(512));
            collect(); const before = process.memoryUsage().heapUsed;
            expect(() => runner.skip(state.scanId, join(root, 'queued-1'))).toThrow(expect.objectContaining({ code: 'invalid_skip_path' }));
            return Math.max(0, process.memoryUsage().heapUsed - before);
        };
        try {
            const narrowRows = 1000; const wideRows = narrowRows * 10;
            const narrowHeapBytes = sample(narrowRows); const wideHeapBytes = sample(wideRows);
            console.log(JSON.stringify({ qa: 'queued-skip-frontier-heap', narrowRows, wideRows, narrowHeapBytes, wideHeapBytes }));
            // A point membership read must not allocate even one extra copy of the ten-times-wider path corpus.
            expect(wideHeapBytes - narrowHeapBytes).toBeLessThan((wideRows - narrowRows) * 512);
            runner.skip(state.scanId, join(root, 'queued-1') + '-'.repeat(512));
            expect(index.skippedPaths(volumes[0].id)).toContain(join(root, 'queued-1') + '-'.repeat(512));
        } finally { database.close(); const cancelled = runner.cancel(state.scanId); release(); await cancelled; await runner.dispose(); }
    });
    it('persists bounded entry/fact streams without losing raw files, package facts, or facts on final rewrites', async () => {
        const root = join(scratch, 'stream-root'); const index = createStorageScanIndex({ activeServerDir: join(scratch, 'stream-state') });
        await index.initialize([], true);
        await index.begin({ volumeId: 'stream', root, target: { folderPath: root }, usedBytes: 100000,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        const directory: Omit<Extract<NativeDiskScanRecord, { type: 'dir-start' }>, 'type' | 'relistOnly'> = { v: 1, id: root, name: 'stream-root', allocatedBytes: 0, logicalBytes: 0, ownLogicalBytes: 0,
            items: 1, mtimeMs: 2000, flags: { atLeast: false }, children: [], files: [], allocationFacts: [],
            folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 }, ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false, enumerated: false, streamed: true };
        index.ingest('stream', { ...directory, type: 'dir-start', relistOnly: false });
        const file = { id: join(root, 'tiny'), name: 'tiny', kind: 'file', allocatedBytes: 0, logicalBytes: 12, items: 1,
            mtimeMs: 2000, flags: { atLeast: false } } as const;
        const packageNode = { ...file, id: join(root, 'Atomic.app'), name: 'Atomic.app', kind: 'package', logicalBytes: 30, items: 3 } as const;
        for (const node of [file, packageNode]) index.ingest('stream', { v: 1, type: 'dir-entry', parent: root, node, visible: false, retained: false, replaceFacts: true });
        const fact = (owner: string, key: string, pathId: string, allocatedBytes: number): Extract<NativeDiskScanRecord, { type: 'fact' }> =>
            ({ v: 1, type: 'fact', owner, fact: { key, pathId, allocatedBytes, mtimeMs: 2000, ageIncluded: true } });
        index.ingest('stream', fact(file.id, 'file-key', file.id, 4096));
        index.ingest('stream', fact(packageNode.id, 'package-first', join(packageNode.id, 'inner-a'), 8192));
        index.ingest('stream', fact(packageNode.id, 'package-second', join(packageNode.id, 'inner-b'), 16384));
        // A lexical/fold rewrite updates presentation, not the already streamed physical facts.
        index.ingest('stream', { v: 1, type: 'dir-entry', parent: root, node: packageNode, visible: true, retained: false, replaceFacts: false });
        const final: NativeDiskScanRecord = { ...directory, type: 'dir', complete: true, enumerated: true, allocatedBytes: 28672,
            folded: { items: 1, allocatedBytes: 4096, logicalBytes: 12 } };
        index.ingest('stream', final); index.ingest('stream', final); index.finish('stream', 'complete');
        expect(index.readView({ view: { tab: 'large', depth: 1, minBytes: 0 } }).nodes).toMatchObject([{ name: 'tiny', size: { allocatedBytes: 4096 } }]);
        expect(index.readNode(packageNode.id)?.node.size.allocatedBytes).toBe(24576);
        expect(index.readNode(root)?.node).toMatchObject({ size: { allocatedBytes: 28672 }, logicalBytes: 42, items: 5 });
        expect(index.readNode(join(packageNode.id, 'inner-a'))).toBeNull();
        expect(index.readView({ view: { tab: 'folders', depth: 1 } }).nodes.map(node => node.name).sort()).toEqual(['Atomic.app', 'Small items']);
        expect((await index.stats('stream')).observationRows).toBe(3);
        index.close();
    });
    it('commits synchronous transport batches atomically and retains the frontier when streaming replacement is interrupted', async () => {
        const root = join(scratch, 'batch-root'); const index = createStorageScanIndex({ activeServerDir: join(scratch, 'batch-state') });
        await index.initialize([], true); await index.begin({ volumeId: 'batch', root, target: { folderPath: root }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        const entry: Extract<NativeDiskScanRecord, { type: 'dir-entry' }> = { v: 1, type: 'dir-entry', parent: root,
            node: { id: join(root, 'partial'), name: 'partial', kind: 'file', allocatedBytes: 0, logicalBytes: 0, items: 1, mtimeMs: 2000, flags: { atLeast: false } },
            visible: true, retained: false, replaceFacts: true };
        const failure = new Error('Transport record rejected');
        expect(() => index.withIngestBatch('batch', () => { index.ingest('batch', entry); throw failure; })).toThrow(failure);
        expect(index.readNode(entry.node.id)).toBeNull();
        index.withIngestBatch('batch', () => index.ingest('batch', entry)); expect(index.readNode(entry.node.id)).not.toBeNull();
        index.ingest('batch', { v: 1, type: 'frontier-start' }); index.ingest('batch', { v: 1, type: 'frontier-item', path: join(root, 'pending') });
        index.finish('batch', 'interrupted'); expect(index.frontier('batch')).toEqual([root]);
        index.ingest('batch', { v: 1, type: 'frontier-start' }); index.ingest('batch', { v: 1, type: 'frontier-item', path: join(root, 'pending') });
        index.finish('batch', { v: 1, type: 'summary', termination: 'interrupted', unreadable: [], unreadableCounts: { permission: 0, os_private: 0, timeout: 0, io: 0 },
            skipped: [], backendByDirCounts: {}, allocatedBytes: 0, items: 0, streamedFrontier: true, pendingFrontier: [] });
        expect(index.frontier('batch')).toEqual([join(root, 'pending')]); expect(index.hasRunnableFrontier('batch')).toBe(true);
        const projection = (await index.writePriorProjection('batch', { resume: true }))!;
        expect(await readFile(projection.path, 'utf8')).toContain(JSON.stringify({ v: 1, type: 'prior-frontier', id: join(root, 'pending') })); await projection.dispose();
        index.recordSkip('batch', join(root, 'pending')); expect(index.hasRunnableFrontier('batch')).toBe(false);
        const skippedProjection = (await index.writePriorProjection('batch', { resume: true }))!;
        expect(await readFile(skippedProjection.path, 'utf8')).not.toContain('prior-frontier'); await skippedProjection.dispose(); index.close();
    });
    it('uses streamed enumeration proof to prune stale relist entries without renewing retained subtree coverage', async () => {
        const root = join(scratch, 'stream-relist'); const child = join(root, 'cached'); const nested = join(child, 'nested'); const gone = join(root, 'gone');
        let time = 10000; const index = createStorageScanIndex({ activeServerDir: join(scratch, 'stream-relist-state'), nowMs: () => time });
        await index.initialize([], true);
        const admission = { volumeId: 'stream-relist', root, target: { folderPath: root }, usedBytes: 100000,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } } as const;
        const directory = (id: string, parent?: string): Omit<Extract<NativeDiskScanRecord, { type: 'dir-start' }>, 'type' | 'relistOnly'> => ({ v: 1, id, ...(parent ? { parent } : {}), name: id === root ? 'root' : 'cached',
            allocatedBytes: 0, logicalBytes: 0, ownLogicalBytes: 0, items: 1, mtimeMs: 2000, flags: { atLeast: false }, children: [], files: [], allocationFacts: [],
            folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 }, ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false, enumerated: false, streamed: true });
        const node = (id: string, kind: 'folder' | 'file') => ({ id, name: id === child ? 'cached' : id === gone ? 'gone' : 'nested', kind,
            allocatedBytes: 4096, logicalBytes: 12, items: 1, mtimeMs: 2000, flags: { atLeast: false } });
        const entry = (parent: string, id: string, kind: 'folder' | 'file', retained = false): Extract<NativeDiskScanRecord, { type: 'dir-entry' }> =>
            ({ v: 1, type: 'dir-entry', parent, node: node(id, kind), visible: true, retained, replaceFacts: !retained });
        await index.begin(admission); index.ingest('stream-relist', { ...directory(root), type: 'dir-start', relistOnly: false });
        index.ingest('stream-relist', entry(root, child, 'folder')); index.ingest('stream-relist', entry(root, gone, 'file'));
        index.ingest('stream-relist', { ...directory(child, root), type: 'dir-start', relistOnly: false }); index.ingest('stream-relist', entry(child, nested, 'file'));
        index.ingest('stream-relist', { v: 1, type: 'fact', owner: nested, fact: { key: 'nested-key', pathId: nested, allocatedBytes: 4096, mtimeMs: 2000, ageIncluded: true } });
        index.ingest('stream-relist', { ...directory(child, root), type: 'dir', complete: true, enumerated: true });
        index.ingest('stream-relist', { ...directory(root), type: 'dir', complete: true, enumerated: true }); index.finish('stream-relist', 'complete');
        const prior = index.readNode(child)!; time = 20000;
        await index.begin({ ...admission, relistOnly: true }); index.ingest('stream-relist', { ...directory(root), type: 'dir-start', relistOnly: true });
        index.ingest('stream-relist', entry(root, child, 'folder', true));
        index.ingest('stream-relist', { ...directory(root), type: 'dir', flags: { atLeast: true } });
        expect(index.readNode(gone)).not.toBeNull(); // Incomplete enumeration is not absence proof.
        index.ingest('stream-relist', { ...directory(root), type: 'dir', enumerated: true, flags: { atLeast: true } }); index.finish('stream-relist', 'complete');
        expect(index.readNode(gone)).toBeNull(); expect(index.readNode(nested)?.node.size.allocatedBytes).toBe(4096);
        expect(index.readNode(child)).toMatchObject({ scannedAt: prior.scannedAt, complete: true });
        const view = index.readView({ view: { tab: 'folders', depth: 1 } });
        expect(view.nodes.find(value => value.nodeId === child)?.deltaSincePrevious).toBeUndefined();
        expect(view.coverage.find(value => value.path === root)?.complete).toBe(false);
        time = 30000; await index.begin({ ...admission, relistOnly: true });
        index.ingest('stream-relist', { ...directory(root), type: 'dir-start', relistOnly: true });
        index.ingest('stream-relist', entry(root, child, 'folder')); // Fresh nonretained identity cannot inherit the old nested tree.
        expect(index.readNode(nested)).toBeNull(); expect(index.readNode(child)?.complete).toBe(false);
        index.ingest('stream-relist', { v: 1, type: 'fact', owner: child, fact: { key: 'new-directory-self', pathId: child, allocatedBytes: 4096, mtimeMs: 2000, ageIncluded: false } });
        const refreshedEntry: Extract<NativeDiskScanRecord, { type: 'dir-entry' }> = { ...entry(root, child, 'folder'), replaceFacts: false };
        index.ingest('stream-relist', refreshedEntry);
        index.ingest('stream-relist', { ...directory(root), type: 'dir', enumerated: true, flags: { atLeast: true } }); index.finish('stream-relist', 'complete');
        expect(index.readNode(child)?.node.size.allocatedBytes).toBe(4096);
        index.close();
    });
    it('indexes one containing volume, preserves tiny file facts below chart fold, and filters unknown age', async () => {
        const volume = join(scratch, 'volume'); const folder = join(volume, 'project'); await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'tiny-old'), Buffer.alloc(8192)); await writeFile(join(folder, 'epoch'), Buffer.alloc(8192));
        const tinyAllocated = (await measureNativeDisk({ paths: [join(folder, 'tiny-old')] })).totalAllocatedBytes;
        await writeFile(join(folder, 'big'), Buffer.alloc(tinyAllocated * (STORAGE_CHART_MAX_DRAWABLE_NODES + 1)));
        await utimes(join(folder, 'tiny-old'), 1_000_000, 1_000_000); await utimes(join(folder, 'epoch'), 0, 0);
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'v1', mountPath: volume, usedBytes: 2_000_000 }],
            readEnabled: () => true, fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const state = await runner.start({ target: { folderPath: folder } }); await runner.wait(state.scanId);
        const large = await runner.get({ view: { tab: 'large', depth: 1, minBytes: 0, pageSize: 10 } });
        expect(large.nodes.map(node => node.name).sort()).toEqual(['big', 'epoch', 'tiny-old']);
        expect(MachineStorageScanGetResultV1Schema.parse(large).state?.status).toBe('complete');
        expect(large.coverage).toContainEqual({ path: folder, scannedAt: expect.any(Number), complete: true });
        expect(large.coverage.some(value => value.path === volume && value.complete)).toBe(false);
        const chart = await runner.get({ view: { tab: 'folders', depth: 1, pageSize: 10 } });
        expect(chart.nodes.filter(node => node.kind === 'file').map(node => node.name)).toEqual(['big']);
        expect(chart.nodes.find(node => node.kind === 'small-items')?.items).toBe(2);
        expect((await runner.get({ view: { tab: 'old', depth: 1, olderThanDays: 1, pageSize: 10 } })).nodes.map(node => node.name)).toEqual(['tiny-old']);
        expect((await readdir(join(scratch, 'state', 'storage', 'scans'))).filter(name => name.endsWith('.sqlite'))).toHaveLength(1);
        await runner.dispose();
    });
    it.each([{ childScans: 1, fullTarget: 'folder', existingChild: false }, { childScans: 2, fullTarget: 'folder', existingChild: false },
        { childScans: 3, fullTarget: 'volume', existingChild: false }, { childScans: 2, fullTarget: 'folder', existingChild: true }])(
        'compares a repeated $fullTarget target with its own complete scan after $childScans child scans (existing: $existingChild)', async ({ childScans, fullTarget, existingChild }) => {
        const volume = join(scratch, `same-target-history-${fullTarget}-${childScans}-${existingChild}`); await mkdir(volume);
        const existing = join(volume, 'existing'); await writeFile(existing, Buffer.alloc(8192));
        const child = join(volume, 'new-child');
        if (existingChild) { await mkdir(child); await writeFile(join(child, 'new.txt'), Buffer.alloc(4096)); }
        const activeServerDir = join(scratch, `same-target-history-${fullTarget}-${childScans}-${existingChild}-state`); let time = 10000;
        let index = createStorageScanIndex({ activeServerDir, nowMs: () => time });
        const createRunner = () => createStorageScanRunner({ index, readVolumes: () => [{ id: 'same-target', mountPath: volume, usedBytes: 100_000 }],
            readEnabled: () => true, fullDiskAccess: () => ({ state: 'not_applicable' as const, binary: { name: 'fixture', path: process.execPath } }) });
        let runner = createRunner();
        const scan = async (folderPath: string) => { const state = await runner.start({ target: { folderPath } }); return runner.wait(state.scanId); };
        const scanFullTarget = async () => {
            const state = await runner.start({ target: fullTarget === 'volume' ? { volumeId: 'same-target' } : { folderPath: volume } });
            return runner.wait(state.scanId);
        };
        try {
            await runner.initialize(); await scanFullTarget();
            const firstBytes = index.readNode(volume)!.node.size.allocatedBytes;
            if (existingChild) await writeFile(join(child, 'new.txt'), Buffer.alloc(12288));
            else { await mkdir(child); await writeFile(join(child, 'new.txt'), Buffer.alloc(4096)); }
            time = 20000; await scan(child);
            const firstChild = await runner.get({ view: { tab: 'insights', depth: 1, pageSize: 10 } });
            expect(firstChild.previousScanAt).toBeUndefined();
            let appearedBytes = existingChild ? 8192 : index.readNode(child)!.node.size.allocatedBytes;
            if (!existingChild) expect(appearedBytes).toBe((await measureNativeDisk({ paths: [child] })).totalAllocatedBytes);
            if (process.platform === 'linux') expect(appearedBytes).toBe(8192);
            for (let repeat = 1; repeat < childScans; repeat++) {
                time = 25000;
                if (repeat === 1) {
                    await scan(child);
                    const childComparison = await runner.get({ view: { tab: 'insights', depth: 1, pageSize: 10 } });
                    expect(childComparison.previousScanAt).toBe(20000);
                    expect(childComparison.insights).toMatchObject({ growthBytes: 0, reclaimedBytes: 0, notComparableFolders: 0 });
                } else {
                    const sibling = join(volume, 'second-child'); await mkdir(sibling); await writeFile(join(sibling, 'new.txt'), Buffer.alloc(4096));
                    await scan(sibling); appearedBytes += index.readNode(sibling)!.node.size.allocatedBytes;
                }
            }
            if (childScans > 1) {
                await runner.dispose(); index = createStorageScanIndex({ activeServerDir, nowMs: () => time }); runner = createRunner();
                await runner.initialize();
                // A cancelled child replacement must not change the full
                // target's baseline, even across reopening the retained index.
                time = 26000;
                await index.begin({ volumeId: 'same-target', root: child, target: { folderPath: child },
                    fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
                index.finish('same-target', 'interrupted');
            }
            time = 30000; await scanFullTarget();
            const comparison = await runner.get({ view: { tab: 'insights', depth: 1, pageSize: 10 } });
            expect(comparison.previousScanAt).toBe(10000);
            expect(comparison.root?.size.allocatedBytes).toBe(firstBytes + appearedBytes);
            expect(comparison.insights).toMatchObject({ growthBytes: appearedBytes, reclaimedBytes: 0, notComparableFolders: 0 });
            if (existingChild) expect(comparison.insights?.changes.grew.map(node => node.nodeId)).toContain(child);
            else expect(comparison.insights?.changes.appeared.map(node => node.nodeId)).toContain(child);
            // A later consecutive scan rotates to the new full-target baseline.
            await writeFile(existing, Buffer.alloc(16384)); time = 40000; await scanFullTarget();
            const neighbor = await runner.get({ view: { tab: 'insights', depth: 1, pageSize: 10 } });
            expect(neighbor.previousScanAt).toBe(30000);
            expect(neighbor.insights).toMatchObject({ growthBytes: 8192, reclaimedBytes: 0, notComparableFolders: 0 });
            expect(neighbor.insights?.changes.appeared).toEqual([]);
            expect((await runner.get({ view: { tab: 'large', depth: 1 } })).nodes.find(node => node.nodeId === existing)?.deltaSincePrevious).toBe(8192);
        } finally { await runner.dispose(); }
    });
    it('keeps the last complete baseline through interruption, reports appeared/disappeared rows, and purges on opt-out', async () => {
        const volume = join(scratch, 'replacement'); const gone = join(volume, 'gone'); const kept = join(volume, 'kept');
        await mkdir(gone, { recursive: true }); await mkdir(kept); await writeFile(join(gone, 'data'), Buffer.alloc(8192)); await writeFile(join(kept, 'data'), Buffer.alloc(8192));
        const activeServerDir = join(scratch, 'replacement-state'); let enabled = true;
        const index = createStorageScanIndex({ activeServerDir });
        const volumes = [{ id: 'replace', mountPath: volume, usedBytes: 1_000_000 }];
        const runner = createStorageScanRunner({ index, readVolumes: () => volumes, readEnabled: () => enabled,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const start = () => runner.start({ target: { volumeId: 'replace' } });
        const first = await start(); await runner.wait(first.scanId);
        await rm(gone, { recursive: true }); const appeared = join(volume, 'appeared'); await mkdir(appeared); await writeFile(join(appeared, 'data'), Buffer.alloc(16384));
        const second = await start(); await runner.wait(second.scanId);
        const insights = await runner.get({ view: { tab: 'insights', depth: 1, pageSize: 10 } });
        expect(insights.insights?.changes.appeared.map(node => node.name)).toEqual(['appeared']);
        expect(insights.insights?.changes.disappeared.map(node => node.name)).toEqual(['gone']);
        const folder = await runner.get({ view: { tab: 'folders', depth: 1, pageSize: 10 } });
        expect(folder.nodes.find(node => node.name === 'kept')?.deltaSincePrevious).toBe(0);
        const files = (await readdir(join(activeServerDir, 'storage', 'scans'))).filter(name => name.endsWith('.sqlite')); expect(files).toHaveLength(2);
        const previous = join(activeServerDir, 'storage', 'scans', files.find(name => name.includes('.previous'))!); const previousBefore = await stat(previous);
        await index.begin({ volumeId: 'replace', root: volume, target: { volumeId: 'replace' }, usedBytes: 1_000_000,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } }); index.finish('replace', 'interrupted');
        expect((await stat(previous)).mtimeMs).toBe(previousBefore.mtimeMs);
        const current = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', files.find(name => !name.includes('.previous'))!));
        try {
            // Interrupted admission keeps path identities/free pages available
            // for reuse. Repeating it must not grow those rows or lose baseline
            // history; successful completion owns final reclamation.
            const retained = current.prepare('SELECT COUNT(*) AS count FROM paths').get();
            expect(retained).toEqual(current.prepare('SELECT COUNT(*) AS count FROM baseline_paths').get());
            expect(Object.values(retained!)[0]).toBeGreaterThan(0);
            await index.begin({ volumeId: 'replace', root: volume, target: { volumeId: 'replace' }, usedBytes: 1_000_000,
                fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } }); index.finish('replace', 'interrupted');
            expect(current.prepare('SELECT COUNT(*) AS count FROM paths').get()).toEqual(retained);
            expect(current.prepare('SELECT COUNT(*) AS count FROM entries').get()).toEqual({ count: 0 });
        } finally { current.close(); }
        await runner.dispose();
        const reopened = createStorageScanIndex({ activeServerDir }); await reopened.initialize(volumes, true);
        expect(reopened.state()?.status).toBe('interrupted'); expect(reopened.frontier('replace')).toEqual([volume]);
        reopened.finish('replace', 'complete');
        const reclaimed = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', files.find(name => !name.includes('.previous'))!));
        try { expect(reclaimed.prepare('SELECT COUNT(*) AS count FROM paths').get()).toEqual({ count: 0 }); }
        finally { reclaimed.close(); }
        enabled = false; await reopened.initialize(volumes, enabled);
        expect((await readdir(join(activeServerDir, 'storage', 'scans'))).filter(name => name.endsWith('.sqlite'))).toEqual([]);
        reopened.close();
    });
    it('pages prefix-first Find, sorts by actual change, and re-lists a folder on drill', async () => {
        const volume = join(scratch, 'views'); const nested = join(volume, 'fold-me'); await mkdir(nested, { recursive: true });
        const a = join(volume, 'a-large'); const zed = join(volume, 'z-growing'); await mkdir(a); await mkdir(zed);
        await writeFile(join(a, 'data'), Buffer.alloc(32768)); await writeFile(join(zed, 'data'), Buffer.alloc(8192));
        await writeFile(join(nested, 'target-prefix'), 'x'); await writeFile(join(nested, 'a-target-substring'), 'x'); await writeFile(join(volume, 'big'), Buffer.alloc(1024 * 1024));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'views-state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'views', mountPath: volume, usedBytes: 2_000_000 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const first = await runner.start({ target: { volumeId: 'views' } }); await runner.wait(first.scanId);
        await writeFile(join(zed, 'data'), Buffer.alloc(16384)); const second = await runner.start({ target: { volumeId: 'views' } }); await runner.wait(second.scanId);
        const sorted = await runner.get({ view: { tab: 'folders', depth: 1, sort: { by: 'since', direction: 'desc' }, pageSize: 10 } });
        expect(sorted.nodes.filter(node => node.kind === 'folder').map(node => node.name).slice(0, 2)).toEqual(['z-growing', 'a-large']);
        const found = await runner.get({ view: { tab: 'find', depth: 1, query: { name: 'target', kind: 'file', minBytes: 0 }, pageSize: 1 } });
        expect(found.nodes[0]?.name).toBe('target-prefix'); expect(found.nextCursor).toBeDefined();
        expect((await runner.get({ view: { tab: 'find', depth: 1, query: { name: 'target', kind: 'file', minBytes: 0 }, pageSize: 1, cursor: found.nextCursor } })).nodes[0]?.name).toBe('a-target-substring');
        await writeFile(join(volume, 'big'), Buffer.alloc(4 * 1024 * 1024));
        const folded = await runner.start({ target: { volumeId: 'views' } }); await runner.wait(folded.scanId);
        const drill = await runner.get({ view: { tab: 'folders', nodeId: nested, depth: 1, pageSize: 10 } });
        expect(drill.state?.status).toBe('running'); await runner.wait(drill.state!.scanId);
        expect((await runner.get({ view: { tab: 'large', nodeId: nested, depth: 1, pageSize: 10 } })).nodes.map(node => node.name).sort()).toEqual(['a-target-substring', 'target-prefix']);
        expect(index.readNode(nested)?.node.parentId).toBe(volume);
        expect(index.readNode(volume)?.node.size.allocatedBytes).toBe((await measureNativeDisk({ paths: [volume] })).totalAllocatedBytes);
        await runner.dispose();
    });
    it('keeps indexed folder reads passive and materializes a folded drill only once across sibling navigation', async () => {
        const volume = join(scratch, 'passive-reads'); const indexed = join(volume, 'indexed'); const sibling = join(volume, 'sibling'); const folded = join(volume, 'folded'); const secondFolded = join(volume, 'second-folded');
        await mkdir(indexed, { recursive: true }); await mkdir(sibling); await mkdir(folded); await mkdir(secondFolded);
        await writeFile(join(indexed, 'large'), Buffer.alloc(1024 * 1024)); await writeFile(join(sibling, 'large'), Buffer.alloc(1024 * 1024));
        await writeFile(join(folded, 'small'), 'x');
        await writeFile(join(secondFolded, 'small'), 'x');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'passive-reads-state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'passive', mountPath: volume, usedBytes: 0 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize(); const first = await runner.start({ target: { volumeId: 'passive' } }); await runner.wait(first.scanId);
            for (let read = 0; read < 3; read++) {
                const page = await runner.get({ view: { tab: 'folders', nodeId: indexed, depth: 1, pageSize: 1 } });
                expect(page.state?.scanId).toBe(first.scanId); expect(page.state?.status).toBe('complete');
                expect(page.nodes[0]?.name).toBe('large');
            }
            const [drill, concurrent] = await Promise.all([runner.get({ view: { tab: 'folders', nodeId: folded, depth: 1 } }),
                runner.get({ view: { tab: 'folders', nodeId: folded, depth: 1 } })]);
            expect(concurrent.state?.scanId).toBe(drill.state?.scanId);
            expect(drill.state?.status).toBe('running'); expect(drill.state?.scanId).not.toBe(first.scanId); await runner.wait(drill.state!.scanId);
            for (const nodeId of [folded, sibling, folded, indexed, folded]) {
                const page = await runner.get({ view: { tab: 'folders', nodeId, depth: 1 } });
                expect(page.state?.scanId).toBe(drill.state?.scanId); expect(page.state?.status).toBe('complete');
            }
            const siblingDrill = await runner.get({ view: { tab: 'folders', nodeId: secondFolded, depth: 1 } });
            expect(siblingDrill.state?.status).toBe('running'); await runner.wait(siblingDrill.state!.scanId);
            expect((await runner.get({ view: { tab: 'folders', nodeId: folded, depth: 1 } })).state?.scanId).toBe(siblingDrill.state?.scanId);
            await writeFile(join(indexed, 'new'), 'x');
            const refreshed = await runner.start({ target: { folderPath: indexed } }); await runner.wait(refreshed.scanId);
            expect((await runner.get({ view: { tab: 'large', nodeId: indexed, depth: 1 } })).nodes.map(node => node.name)).toContain('new');
        } finally { await runner.dispose(); }
    });
    it('limits comparison construction to requested pages after two completed large scans', async () => {
        const volume = join(scratch, 'comparison-pages'); const selected = join(volume, 'selected'); const other = join(volume, 'other');
        await mkdir(selected, { recursive: true }); await mkdir(other);
        const perFolder = 1024;
        for (const folder of [selected, other]) for (let i = 0; i < perFolder; i++) await writeFile(join(folder, `file-${i}`), 'x');
        const activeServerDir = join(scratch, 'comparison-pages-state');
        const index = createStorageScanIndex({ activeServerDir });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'comparison', mountPath: volume, usedBytes: 0 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize(); const first = await runner.start({ target: { volumeId: 'comparison' } }); await runner.wait(first.scanId);
            await writeFile(join(selected, 'file-0'), Buffer.alloc(32768));
            const second = await runner.start({ target: { volumeId: 'comparison' } }); await runner.wait(second.scanId);
            const currentFile = (await readdir(join(activeServerDir, 'storage', 'scans'))).find(name => name.endsWith('.sqlite') && !name.includes('.previous'))!;
            const database = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', currentFile));
            const prototype: typeof database = Object.getPrototypeOf(database);
            const exec = prototype.exec; const comparisons: number[] = [];
            // Instrument the actual SQLite boundary; every query still executes against both real scans.
            const boundary = vi.spyOn(prototype, 'exec').mockImplementation(function(this: typeof database, sql) {
                exec.call(this, sql);
                if (sql.includes('CREATE INDEX comparison_parent')) comparisons.push(Number(Object.values(this.prepare('SELECT COUNT(*) FROM comparison_rows').get()!)[0]));
            });
            const elapsed: number[] = [];
            try {
                for (let repeat = 0; repeat < 5; repeat++) {
                    const started = performance.now();
                    const folder = index.readView({ view: { tab: 'folders', nodeId: selected, depth: 1, pageSize: 5 } });
                    const large = index.readView({ view: { tab: 'large', nodeId: selected, depth: 1, pageSize: 5 } });
                    elapsed.push(performance.now() - started);
                    expect(folder.nodes.find(node => node.name === 'file-0')?.deltaSincePrevious).toBe(28672);
                    expect(large.nodes[0]).toMatchObject({ name: 'file-0', deltaSincePrevious: 28672 });
                }
                console.log(JSON.stringify({ qa: 'comparison-page-work', ordinaryFiles: perFolder * 2, reads: 10, comparisonRows: comparisons, elapsedPairMs: elapsed }));
                expect(comparisons.every(rows => rows <= 6)).toBe(true);
                expect((await index.stats('comparison')).fileRows).toBe(perFolder * 2);
            } finally { boundary.mockRestore(); database.close(); }
        } finally { await runner.dispose(); }
    }, 120_000);
    it('retains every ordinary file under a verified atomic summary and materializes its drill once', async () => {
        const volume = join(scratch, 'atomic-index'); const project = join(volume, 'project'); const modules = join(project, 'node_modules');
        const source = join(volume, 'source', 'node_modules'); await mkdir(modules, { recursive: true }); await mkdir(source, { recursive: true });
        await writeFile(join(project, 'package.json'), '{}');
        const leaves: string[] = [];
        for (let directory = 0; directory < 8; directory++) {
            const path = join(modules, `dependency-${directory}`); await mkdir(path);
            for (let file = 0; file < 16; file++) { const leaf = join(path, `file-${file}`); await writeFile(leaf, 'data'); await utimes(leaf, 1_000_000, 1_000_000); leaves.push(leaf); }
        }
        await writeFile(join(source, 'source-file'), 'source');
        const volumes = [{ id: 'atomic', mountPath: volume, usedBytes: 0 }];
        async function firstScanCost(withSummaries: boolean) {
            const measuredIndex = createStorageScanIndex({ activeServerDir: join(scratch, withSummaries ? 'atomic-cost-after' : 'atomic-cost-before') });
            let records = 0; let streamJsonBytes = 0;
            // Observe the real adapter-to-index stream without replacing its logic.
            const measuredRunner = createStorageScanRunner({ index: { ...measuredIndex, ingest(volumeId, record) {
                records++; streamJsonBytes += Buffer.byteLength(JSON.stringify(record)); measuredIndex.ingest(volumeId, record);
            } }, readVolumes: () => volumes, readEnabled: () => true,
                ...(withSummaries ? { readScanHints: (root: string) => readStorageScanHints({ root, repositoryRoots: [project], facts: { now: Date.now(), suggestUnusedAfterDays: 30, protection: { homeDir: volume } } }) } : {}),
                fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
            try {
                await measuredRunner.initialize(); const started = performance.now();
                const scan = await measuredRunner.start({ target: { volumeId: 'atomic' } }); await measuredRunner.wait(scan.scanId);
                return { elapsedMs: performance.now() - started, records, streamJsonBytes, stats: await measuredIndex.stats('atomic'),
                    allocatedBytes: measuredIndex.readNode(volume)?.node.size.allocatedBytes };
            } finally { await measuredRunner.dispose(); }
        }
        const beforeCost = await firstScanCost(false); const afterCost = await firstScanCost(true);
        expect(afterCost.allocatedBytes).toBe(beforeCost.allocatedBytes);
        expect(afterCost.stats.fileRows).toBe(beforeCost.stats.fileRows);
        expect(afterCost.stats.directoryRows).toBeLessThan(beforeCost.stats.directoryRows);
        expect(afterCost.records).toBeLessThan(beforeCost.records);
        console.log(JSON.stringify({ qa: 'atomic-summary-first-scan-cost', ordinaryFiles: leaves.length + 2, before: beforeCost, after: afterCost }));
        const activeServerDir = join(scratch, 'atomic-index-state'); const index = createStorageScanIndex({ activeServerDir });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'atomic', mountPath: volume, usedBytes: 0 }], readEnabled: () => true,
            readScanHints: root => readStorageScanHints({ root, repositoryRoots: [project], facts: { now: Date.now(), suggestUnusedAfterDays: 30, protection: { homeDir: volume } } }),
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize(); const first = await runner.start({ target: { volumeId: 'atomic' } }); await runner.wait(first.scanId);
            const measured = await measureNativeDisk({ paths: [modules] });
            expect(index.readNode(modules)).toMatchObject({ complete: true, materialized: false, node: { size: { allocatedBytes: measured.totalAllocatedBytes }, items: leaves.length + 9 } });
            expect(index.readNode(join(modules, 'dependency-0'))?.materialized).toBe(false);
            expect(index.readNode(source)?.materialized).toBe(true);
            const large = await runner.get({ view: { tab: 'large', nodeId: modules, depth: 1, pageSize: 1000 } });
            expect(large.nodes.map(node => node.nodeId).sort()).toEqual([...leaves].sort());
            expect(large.nodes.every(node => node.size.allocatedBytes > 0)).toBe(true);
            expect((await runner.get({ view: { tab: 'old', nodeId: modules, depth: 1, pageSize: 1000 } })).nodes).toHaveLength(leaves.length);
            const nestedRefresh = await runner.start({ target: { folderPath: join(modules, 'dependency-0') } }); await runner.wait(nestedRefresh.scanId);
            expect(index.readNode(modules)?.node.size.allocatedBytes).toBe(measured.totalAllocatedBytes);
            expect(index.readNode(join(modules, 'dependency-0'))?.node.size.allocatedBytes).toBe((await measureNativeDisk({ paths: [join(modules, 'dependency-0')] })).totalAllocatedBytes);
            expect((await runner.get({ view: { tab: 'large', nodeId: modules, depth: 1, pageSize: 1000 } })).nodes.map(node => node.nodeId).sort()).toEqual([...leaves].sort());
            const beforeStats = await index.stats('atomic');
            const drill = await runner.get({ view: { tab: 'folders', nodeId: modules, depth: 1 } });
            expect(drill.state?.status).toBe('running'); await runner.wait(drill.state!.scanId);
            expect(index.readNode(join(modules, 'dependency-0'))?.materialized).toBe(true);
            expect(index.readNode(modules)?.node.size.allocatedBytes).toBe(measured.totalAllocatedBytes);
            expect((await index.stats('atomic')).fileRows).toBe(beforeStats.fileRows);
            expect((await runner.get({ view: { tab: 'large', nodeId: modules, depth: 1, pageSize: 1000 } })).nodes.map(node => node.nodeId).sort()).toEqual([...leaves].sort());
            expect((await runner.get({ view: { tab: 'folders', nodeId: modules, depth: 1 } })).state?.scanId).toBe(drill.state?.scanId);
            const summarizedBaseline = await runner.start({ target: { volumeId: 'atomic' } }); await runner.wait(summarizedBaseline.scanId);
            const appeared = join(modules, 'dependency-0', 'file-new'); const disappeared = join(modules, 'dependency-1', 'file-0');
            await writeFile(appeared, 'new'); await rm(disappeared);
            const compared = await runner.start({ target: { volumeId: 'atomic' } }); await runner.wait(compared.scanId);
            const insights = await runner.get({ view: { tab: 'insights', nodeId: modules, depth: 1, pageSize: 1000 } });
            expect(insights.insights?.changes.appeared.map(node => node.nodeId)).toContain(appeared);
            expect(insights.insights?.changes.disappeared.map(node => node.nodeId)).toContain(disappeared);
            expect(index.readNode(modules)?.complete).toBe(true);
            if (process.platform !== 'win32' && process.getuid?.() !== 0) {
                const denied = join(modules, 'dependency-1'); const grown = join(modules, 'dependency-0', 'file-1');
                await chmod(denied, 0);
                try {
                    const unreadable = await runner.start({ target: { folderPath: denied } }); await runner.wait(unreadable.scanId);
                    expect(index.readNode(denied)?.complete).toBe(false);
                    await writeFile(grown, Buffer.alloc(32768));
                    const refreshed = await runner.start({ target: { folderPath: join(modules, 'dependency-0') } }); await runner.wait(refreshed.scanId);
                    const changed = await runner.get({ view: { tab: 'large', nodeId: modules, depth: 1, pageSize: 1000 } });
                    expect(changed.nodes.find(node => node.nodeId === grown)?.deltaSincePrevious).toBe(28672);
                    expect(index.readNode(modules)?.complete).toBe(false);
                } finally { await chmod(denied, 0o700); }
            }
        } finally { await runner.dispose(); }
    });
    it('accepts scheduled work without waiting for scan completion and leaves the active invocation intact when pending work is cleared', async () => {
        const volume = join(scratch, 'scheduled'); await mkdir(volume); await writeFile(join(volume, 'first'), 'x');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'scheduled-state') });
        let clearDuringNative = false; let cleared = false;
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'scheduled', mountPath: volume, usedBytes: 1_000_000 }], readEnabled: () => true,
            onChange: () => { const state = index.state(); if (clearDuringNative && !cleared && state && runner.activeNativePid(state.scanId)) { cleared = true; runner.clearScheduled(); } },
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const first = await runner.start({ target: { volumeId: 'scheduled' } }); await runner.wait(first.scanId);
        await writeFile(join(volume, 'new'), 'x'); clearDuringNative = true; await runner.scheduleVolumes(['scheduled']); await runner.waitScheduled();
        expect(cleared).toBe(true); expect(index.state()?.status).toBe('complete');
        expect((await runner.get({ view: { tab: 'large', depth: 1, pageSize: 10 } })).nodes.map(node => node.name).sort()).toEqual(['first', 'new']);
        await runner.dispose();
    });
    it('re-lists direct names only, retains nested coverage dates, and invalidates removed or replaced children', async () => {
        const volume = join(scratch, 'direct-relist'); const folder = join(volume, 'selected'); const child = join(folder, 'retained');
        const removed = join(folder, 'removed'); const replaced = join(folder, 'replaced');
        await mkdir(child, { recursive: true }); await mkdir(removed); await mkdir(replaced);
        for (const path of [child, removed, replaced]) await writeFile(join(path, 'nested'), Buffer.alloc(8192));
        const direct = join(folder, 'direct'); await writeFile(direct, Buffer.alloc(8192));
        const linked = join(folder, 'z-linked'); await link(join(child, 'nested'), linked);
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'direct-relist-state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'direct-relist', mountPath: volume, usedBytes: 1_000_000 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const first = await runner.start({ target: { volumeId: 'direct-relist' } }); await runner.wait(first.scanId);
        const prior = index.readNode(child)!;
        await writeFile(join(child, 'nested'), Buffer.alloc(65536)); await writeFile(direct, Buffer.alloc(65536));
        await rm(removed, { recursive: true }); await rename(replaced, join(scratch, 'pinned-replaced')); await mkdir(replaced); await writeFile(join(replaced, 'new'), Buffer.alloc(32768));
        const drill = await runner.start({ target: { folderPath: folder } }, { relistOnly: true });
        expect(drill.status).toBe('running'); await runner.wait(drill.scanId);
        expect(index.readNode(child)).toMatchObject({ complete: true, scannedAt: prior.scannedAt, node: { size: { allocatedBytes: prior.node.size.allocatedBytes } } });
        expect(index.readNode(direct)?.node.size.allocatedBytes).toBe(65536);
        expect(index.readNode(removed)).toBeNull(); expect(index.readNode(join(replaced, 'nested'))).toBeNull();
        expect(index.readNode(replaced)?.complete).toBe(false); expect(index.readNode(join(replaced, 'new'))).toBeNull();
        expect(index.readNode(folder)?.complete).toBe(false); expect(index.readNode(folder)?.node.flags.atLeast).toBe(true);
        expect(index.readNode(linked)?.node.size.allocatedBytes).toBe(0);
        const retainedView = await runner.get({ view: { tab: 'folders', nodeId: folder, depth: 1, pageSize: 100 } });
        expect(retainedView.nodes.find(node => node.nodeId === child)?.deltaSincePrevious).toBeUndefined();
        const repeated = await runner.get({ view: { tab: 'folders', nodeId: folder, depth: 1, pageSize: 1 } });
        expect(repeated.state?.scanId).toBe(drill.scanId); expect(repeated.state?.status).toBe('complete');
        await runner.dispose();
    });
    it('schedules an unscanned volume, retains blocked work for an idle edge, and clears pending work across an awaited authority check', async () => {
        const volume = join(scratch, 'scheduled-new'); await mkdir(volume); await writeFile(join(volume, 'first'), 'x');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'scheduled-new-state') });
        let blocked = true; let entered: (() => void) | undefined; let release: (() => void) | undefined;
        let authorityWait: Promise<void> | undefined;
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'scheduled-new', mountPath: volume, usedBytes: 1_000_000 }], readEnabled: () => true,
            beforeScheduledEffect: async () => { entered?.(); await authorityWait; if (blocked) throw Object.assign(new Error('Busy'), { code: 'scheduled_scan_blocked' }); },
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); await runner.scheduleVolumes(['scheduled-new']); await runner.waitScheduled(); expect(index.states()).toEqual([]);
        blocked = false; runner.resumeScheduled(); await runner.waitScheduled();
        expect(index.state()?.status).toBe('complete'); expect(index.readNode(join(volume, 'first'))).not.toBeNull();
        await writeFile(join(volume, 'later'), 'x'); authorityWait = new Promise<void>(resolve => { release = resolve; });
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        await runner.scheduleVolumes(['scheduled-new']); await waiting; runner.clearScheduled(); release!(); await runner.waitScheduled();
        expect(index.readNode(join(volume, 'later'))).toBeNull(); runner.resumeScheduled(); await runner.waitScheduled();
        expect(index.readNode(join(volume, 'later'))).toBeNull(); await runner.dispose();
    });
    it('retains a resume edge delivered before a blocked scheduled drain settles', async () => {
        const volume = join(scratch, 'scheduled-edge'); await mkdir(volume); await writeFile(join(volume, 'first'), 'x');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'scheduled-edge-state') }); let blocked = true;
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'scheduled-edge', mountPath: volume, usedBytes: 1_000_000 }], readEnabled: () => true,
            beforeScheduledEffect: async () => { if (blocked) { blocked = false; runner.resumeScheduled(); throw Object.assign(new Error('Busy before edge'), { code: 'scheduled_scan_blocked' }); } },
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const first = await runner.start({ target: { volumeId: 'scheduled-edge' } }); await runner.wait(first.scanId);
        await writeFile(join(volume, 'after-edge'), 'x'); await runner.scheduleVolumes(['scheduled-edge']); await runner.waitScheduled();
        expect(index.readNode(join(volume, 'after-edge'))).not.toBeNull(); await runner.dispose();
    });
    it('keeps hidden and reserved volume accounting separate and never resolves virtual nodes for effects', async () => {
        const volume = join(scratch, 'virtual'); await mkdir(volume); await writeFile(join(volume, 'data'), Buffer.alloc(8192));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'virtual-state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'virtual', mountPath: volume, usedBytes: 100_000, reservedBytes: 4096 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const state = await runner.start({ target: { volumeId: 'virtual' } }); await runner.wait(state.scanId);
        const nodes = (await runner.get({ view: { tab: 'folders', depth: 1, pageSize: 10 } })).nodes;
        const measured = await measureNativeDisk({ paths: [volume] });
        expect(nodes.find(node => node.kind === 'hidden-space')).toMatchObject({ size: { allocatedBytes: 100_000 - 4096 - measured.totalAllocatedBytes }, flags: { protection: 'forbidden', atLeast: true } });
        expect(nodes.find(node => node.kind === 'reserved')?.size.allocatedBytes).toBe(4096);
        expect(index.lookupPath(`hidden-space:${volume}`)).toBeNull(); await runner.dispose();
    });
    it('reconciles native physical components across separately resumed frontiers', async () => {
        const volume = join(scratch, 'frontier'); const left = join(volume, 'left'); const right = join(volume, 'right');
        await mkdir(left, { recursive: true }); await mkdir(right); await writeFile(join(left, 'shared'), Buffer.alloc(8192)); await link(join(left, 'shared'), join(right, 'shared'));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'frontier-state') }); await index.initialize([{ id: 'frontier', mountPath: volume, usedBytes: 100_000 }], true);
        const admitted = await index.begin({ volumeId: 'frontier', root: volume, target: { volumeId: 'frontier' }, usedBytes: 100_000,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        const first = startNativeDiskScan({ root: volume, resumeFrom: [right], keepMinBytes: 0 }, { onRecord: record => index.ingest('frontier', record) });
        await first.done; index.finish('frontier', 'interrupted');
        const projection = await index.writePriorProjection('frontier', { resume: true });
        const next = startNativeDiskScan({ root: volume, resumeFrom: [left], previousIndexPath: projection?.path, keepMinBytes: 0 }, { onRecord: record => index.ingest('frontier', record) });
        index.finish('frontier', await next.done); await projection?.dispose();
        const measured = await measureNativeDisk({ paths: [left, right] });
        expect(index.readView({ scanId: admitted.scanId, view: { tab: 'folders', nodeId: volume, depth: 1, pageSize: 10 } }).nodes.filter(node => node.kind === 'folder').reduce((sum, node) => sum + node.size.allocatedBytes, 0)).toBe(measured.totalAllocatedBytes);
        expect(index.readNode(join(left, 'shared'))?.node.size.allocatedBytes).toBe(8192);
        expect(index.readNode(join(right, 'shared'))?.node.size.allocatedBytes).toBe(0);
        index.close();
    });
    it('refreshes retained ancestors after a folder scan without losing the containing parent', async () => {
        const volume = join(scratch, 'ancestor-metadata'); const folder = join(volume, 'child'); await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'first'), 'x'); await utimes(join(folder, 'first'), 1, 1);
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'ancestor-metadata-state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'ancestor-metadata', mountPath: volume, usedBytes: 100_000 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const first = await runner.start({ target: { volumeId: 'ancestor-metadata' } }); await runner.wait(first.scanId);
        await writeFile(join(folder, 'new-old'), Buffer.alloc(8192)); await utimes(join(folder, 'new-old'), 1_000_000, 1_000_000);
        const next = await runner.start({ target: { folderPath: folder } }); await runner.wait(next.scanId);
        let rootRecord: Extract<import('../measure/nativeDiskMeasure').NativeDiskScanRecord, { type: 'dir' }> | undefined;
        const native = startNativeDiskScan({ root: volume, keepMinBytes: 0 }, { onRecord: record => { if (record.type === 'dir' && record.id === volume && record.complete) rootRecord = record; } });
        await native.done;
        expect(rootRecord).toBeDefined(); expect(index.readNode(folder)?.node.parentId).toBe(volume);
        expect(index.readNode(volume)?.node.logicalBytes).toBe(rootRecord!.logicalBytes);
        expect(index.readNode(volume)?.node.items).toBe(rootRecord!.items);
        const insights = index.readView({ view: { tab: 'insights', nodeId: volume, depth: 1 } });
        expect(insights.insights?.ageGroupBytes).toEqual(rootRecord!.ageGroupBytes);
        expect((await runner.get({ view: { tab: 'old', depth: 1, minBytes: 0, olderThanDays: 1 } })).nodes.map(node => node.name)).toEqual(['new-old']);
        if (process.platform !== 'win32' && process.getuid?.() !== 0) {
            await chmod(folder, 0);
            try {
                const unreadable = await runner.start({ target: { folderPath: folder } }); await runner.wait(unreadable.scanId);
                expect(index.readNode(volume)?.node.flags.atLeast).toBe(true);
                expect(index.readView({ view: { tab: 'folders', nodeId: volume, depth: 1 } }).coverage).toContainEqual({ path: volume, scannedAt: expect.any(Number), complete: false });
            } finally { await chmod(folder, 0o700); }
        }
        await runner.dispose();
    });
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves unrelated folder and direct-file deltas across an unreadable branch', async () => {
        const volume = join(scratch, 'unreadable'); const bad = join(volume, 'bad'); const safe = join(volume, 'safe');
        await mkdir(bad, { recursive: true }); await mkdir(safe); await writeFile(join(bad, 'data'), Buffer.alloc(8192));
        await writeFile(join(safe, 'data'), Buffer.alloc(8192)); await writeFile(join(volume, 'direct'), Buffer.alloc(8192));
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'unreadable-state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'unreadable', mountPath: volume, usedBytes: 100_000 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const first = await runner.start({ target: { volumeId: 'unreadable' } }); await runner.wait(first.scanId);
        await chmod(bad, 0); await writeFile(join(safe, 'data'), Buffer.alloc(16384)); await writeFile(join(volume, 'direct'), Buffer.alloc(16384));
        try {
            const next = await runner.start({ target: { volumeId: 'unreadable' } }); await runner.wait(next.scanId);
            const large = await runner.get({ view: { tab: 'large', depth: 1, pageSize: 10 } });
            expect(large.nodes.find(node => node.name === 'direct')?.deltaSincePrevious).toBe(8192);
            const byChange = await runner.get({ view: { tab: 'large', depth: 1, sort: { by: 'since', direction: 'desc' }, pageSize: 10 } });
            expect(byChange.nodes.findIndex(node => node.name === 'direct')).toBeLessThan(byChange.nodes.findIndex(node => node.parentId === safe));
            const folders = await runner.get({ view: { tab: 'folders', depth: 1, pageSize: 10 } });
            expect(folders.nodes.find(node => node.name === 'safe')?.deltaSincePrevious).toBe(8192);
            expect(folders.nodes.find(node => node.name === 'bad')?.deltaSincePrevious).toBeUndefined();
            const insights = await runner.get({ view: { tab: 'insights', depth: 1, pageSize: 10 } });
            expect(insights.insights?.growthBytes).toBe(16384); expect(insights.insights?.reclaimedBytes).toBe(0);
            expect((await runner.get({ view: { tab: 'insights', nodeId: safe, depth: 1, pageSize: 10 } })).insights?.largestDistinct).toEqual([]);
        } finally { await chmod(bad, 0o700); await runner.dispose(); }
    });
    it('preserves indexes when volume reporting is unavailable, but removes known-absent volumes', async () => {
        const volume = join(scratch, 'reporting'); await mkdir(volume); await writeFile(join(volume, 'data'), 'x');
        const activeServerDir = join(scratch, 'reporting-state'); const index = createStorageScanIndex({ activeServerDir });
        let volumes = [{ id: 'reporting', mountPath: volume, usedBytes: 100_000 }]; let reported = true;
        const runner = createStorageScanRunner({ index, readVolumes: () => volumes, readVolumesReported: () => reported, readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const state = await runner.start({ target: { volumeId: 'reporting' } }); await runner.wait(state.scanId);
        volumes = []; reported = false; await runner.initialize(); expect(index.readNode(join(volume, 'data'))).not.toBeNull();
        await expect(runner.start({ target: { volumeId: 'reporting' } })).rejects.toMatchObject({ code: 'volumes_unavailable' });
        reported = true; await runner.initialize(); expect(index.states()).toEqual([]);
        expect((await readdir(join(activeServerDir, 'storage', 'scans'))).filter(name => name.endsWith('.sqlite'))).toEqual([]); await runner.dispose();
    });
    it('keeps a durably completed scan complete when its completion consumer fails', async () => {
        const volume = join(scratch, 'completion-consumer'); await mkdir(volume); await writeFile(join(volume, 'data'), 'x');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'completion-consumer-state') });
        const failure = new Error('Consumer failed');
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'completion-consumer', mountPath: volume, usedBytes: 100_000 }], readEnabled: () => true,
            onCompleted: async () => { throw failure; }, fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const state = await runner.start({ target: { volumeId: 'completion-consumer' } });
        await expect(runner.wait(state.scanId)).rejects.toBe(failure); expect(index.state()?.status).toBe('complete'); await runner.dispose();
    });
    it.skipIf(process.platform === 'win32')('keeps native symlink leaves out of ordinary Large/Old file queries', async () => {
        const root = join(scratch, 'file-kinds'); await mkdir(root); const file = join(root, 'ordinary'); const alias = join(root, 'alias');
        await writeFile(file, Buffer.alloc(1024 * 1024)); await symlink(file, alias);
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'file-kinds-state') });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'kinds', mountPath: root, usedBytes: 0 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize(); const state = await runner.start({ target: { volumeId: 'kinds' } }); await runner.wait(state.scanId);
            expect(index.readNode(alias)).not.toBeNull();
            expect(index.readView({ view: { tab: 'large', depth: 1, minBytes: 0, pageSize: 10 } }).nodes.map(node => node.nodeId)).toEqual([file]);
            expect((await index.stats('kinds')).fileRows).toBe(1);
            expect((await index.stats('kinds')).chartRows).toBe(1 + index.readView({ view: { tab: 'folders', nodeId: root, depth: 1, pageSize: 10 } }).nodes.length);
        } finally { await runner.dispose(); }
    });
    it('prunes chart rows and stores wide/deep small-file facts once in a compact index', async () => {
        const root = join(scratch, 'compact-fixture'); const activeServerDir = join(scratch, 'compact-state');
        await mkdir(root); const folders: string[] = []; let deep = root;
        for (let depth = 0; depth < 8; depth++) {
            deep = join(deep, `level-${depth}-` + 'd'.repeat(56)); await mkdir(deep); folders.push(deep);
        }
        for (let branch = 0; branch < 8; branch++) {
            const folder = join(root, `branch-${branch}`); await mkdir(folder); folders.push(folder);
        }
        const perFolder = 256; const fileCount = folders.length * perFolder;
        for (const folder of folders) for (let i = 0; i < perFolder; i++) await writeFile(join(folder, `tiny-${i}`), 'x');
        const index = createStorageScanIndex({ activeServerDir });
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'compact', mountPath: root, usedBytes: 0 }],
            readEnabled: () => true, fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        try {
            await runner.initialize(); const state = await runner.start({ target: { volumeId: 'compact' } }); await runner.wait(state.scanId);
            const stats = await index.stats('compact');
            console.log(JSON.stringify({ qa: 'compact-wide-deep-index', fileCount, chartBudget: STORAGE_CHART_MAX_DRAWABLE_NODES, ...stats }));
            // Every ordinary file remains queryable with STO-19's no-floor Large-files contract.
            expect(stats.fileRows).toBe(fileCount);
            const fileAllocation = (await measureNativeDisk({ paths: [join(folders[0], 'tiny-0')] })).totalAllocatedBytes;
            for (const folder of folders) {
                const node = index.readNode(folder)!;
                const children = index.readView({ view: { tab: 'folders', nodeId: folder, depth: 1, pageSize: 1000 } }).nodes;
                const small = children.find(child => child.kind === 'small-items')!;
                expect(small.items).toBe(perFolder);
                expect(small.size.allocatedBytes).toBe(perFolder * fileAllocation);
                expect(small.logicalBytes).toBe(perFolder);
                expect(node.node.size.allocatedBytes).toBeGreaterThanOrEqual(small.size.allocatedBytes);
            }
            // Persist drawable nodes, rather than a second full copy of every folded file.
            // Before normalization, nodes and files were two physical payload
            // tables. Now both projections consume one entry relation.
            const storedPayloadRows = stats.entryRows ?? stats.nodeRows + stats.fileRows;
            expect(storedPayloadRows).toBe(fileCount + folders.length * 2 + 1);
            expect(stats.chartRows).toBeLessThan(fileCount / 10);
            // Fixture-only regression boundary: a compact record plus its two path dictionary copies.
            // This is an evidence assertion, never a product row/byte cap.
            const pathBytes = folders.reduce((sum, folder) => sum + Array.from({ length: perFolder }, (_, i) => Buffer.byteLength(join(folder, `tiny-${i}`))).reduce((a, b) => a + b, 0), 0);
            expect(stats.databaseBytes).toBeLessThan(pathBytes * 2 + fileCount * 768);
            const changed = join(folders[0], 'tiny-0'); const before = index.readNode(changed)!.node.size.allocatedBytes;
            await writeFile(changed, Buffer.alloc(32768));
            const second = await runner.start({ target: { volumeId: 'compact' } }); await runner.wait(second.scanId);
            const after = index.readNode(changed)!.node.size.allocatedBytes;
            const deltaPage = index.readView({ view: { tab: 'large', depth: 1, minBytes: 32768, pageSize: 10 } });
            expect(deltaPage.nodes.find(node => node.nodeId === changed)?.deltaSincePrevious).toBe(after - before);
            const secondStats = await index.stats('compact');
            const third = await runner.start({ target: { volumeId: 'compact' } }); await runner.wait(third.scanId);
            const thirdStats = await index.stats('compact');
            console.log(JSON.stringify({ qa: 'compact-repeat-index', second: secondStats, third: thirdStats }));
            expect(thirdStats.entryRows).toBe(secondStats.entryRows);
            // Retiring the prior-prior baseline must return free pages rather than grow the current file each scan.
            expect(thirdStats.databaseBytes).toBeLessThanOrEqual(secondStats.databaseBytes + 32 * 4096);
            const databaseFiles = (await readdir(join(activeServerDir, 'storage', 'scans'))).filter(name => name.endsWith('.sqlite'));
            expect(databaseFiles).toHaveLength(2);
            for (const file of databaseFiles) {
                const database = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', file));
                try { expect(Object.values(database.prepare('PRAGMA integrity_check').get()!)).toEqual(['ok']); }
                finally { database.close(); }
            }
        } finally { await runner.dispose(); }
    }, 120_000);
    it.skipIf(process.env.HAPPIER_SCAN_QA_MEDIUM !== '1')('measures the consumed metadata stream on a medium zero-byte file fixture', async () => {
        const root = join(scratch, 'medium-stream'); await mkdir(root); const fixtureFiles = 5000;
        for (let i = 0; i < fixtureFiles; i++) await writeFile(join(root, `entry-${i}`), '');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'medium-stream-state') });
        const baselineWriterRssBytes = process.memoryUsage().rss; let peakWriterRssBytes = baselineWriterRssBytes;
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'medium', mountPath: root, usedBytes: 0 }], readEnabled: () => true,
            onChange: () => { peakWriterRssBytes = Math.max(peakWriterRssBytes, process.memoryUsage().rss); },
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const start = performance.now(); const state = await runner.start({ target: { volumeId: 'medium' } }); await runner.wait(state.scanId);
        const elapsedMs = performance.now() - start; const stats = await index.stats('medium'); expect(stats.fileRows).toBe(fixtureFiles);
        let cursor: string | undefined; let readFiles = 0;
        do { const page = await runner.get({ view: { tab: 'large', depth: 1, minBytes: 0, pageSize: STORAGE_CHART_MAX_DRAWABLE_NODES, ...(cursor ? { cursor } : {}) } });
            readFiles += page.nodes.length; cursor = page.nextCursor;
        } while (cursor);
        expect(readFiles).toBe(fixtureFiles); expect(index.state()?.status).toBe('complete');
        console.log(JSON.stringify({ qa: 'metadata-only-medium-zero-byte-files', fixtureFiles, chartBudget: STORAGE_CHART_MAX_DRAWABLE_NODES,
            elapsedMs, indexedFilesPerSecond: fixtureFiles / (elapsedMs / 1000), baselineWriterRssBytes, peakWriterRssBytes, ...stats }));
        await runner.dispose();
    }, 0);
    it.skipIf(process.env.HAPPIER_SCAN_QA_PROFILE !== '1')('profiles the native scan and index owner on an owned large tree', async () => {
        const root = join(scratch, 'profile-tree'); await mkdir(root);
        const folders = 1000; const perFolder = 32;
        for (let i = 0; i < folders; i++) {
            const folder = join(root, `branch-${i}`); await mkdir(folder);
            for (let j = 0; j < perFolder; j++) await writeFile(join(folder, `entry-${j}`), j % 2 ? 'x' : '');
        }
        const nativeStarted = performance.now(); let nativeRecords = 0;
        const native = startNativeDiskScan({ root, keepMinBytes: 0, drawableNodes: STORAGE_CHART_MAX_DRAWABLE_NODES }, { onRecord: () => { nativeRecords++; } });
        const nativeSummary = await native.done; const nativeMs = performance.now() - nativeStarted;
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'profile-state') });
        const costs: Record<string, { count: number; ms: number }> = {}; let finishMs = 0; let batches = 0;
        let peakWriterRssBytes = process.memoryUsage().rss;
        const runner = createStorageScanRunner({ index: { ...index,
            ingest(volumeId, record) {
                const started = performance.now(); index.ingest(volumeId, record);
                const cost = costs[record.type] ??= { count: 0, ms: 0 }; cost.count++; cost.ms += performance.now() - started;
            },
            finish(volumeId, summary) { const started = performance.now(); index.finish(volumeId, summary); finishMs += performance.now() - started; },
            withIngestBatch(volumeId, consume) { batches++; index.withIngestBatch(volumeId, consume); },
        }, readVolumes: () => [{ id: 'profile', mountPath: root, usedBytes: 0 }], readEnabled: () => true,
            onChange: () => { peakWriterRssBytes = Math.max(peakWriterRssBytes, process.memoryUsage().rss); },
            fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        const { Session } = await import('node:inspector/promises'); const profiler = new Session(); profiler.connect();
        await profiler.post('Profiler.enable'); await profiler.post('Profiler.start');
        await runner.initialize(); const cpu = process.cpuUsage(); const started = performance.now();
        try {
            const state = await runner.start({ target: { volumeId: 'profile' } }); await runner.wait(state.scanId);
            const elapsedMs = performance.now() - started; const cpuUsed = process.cpuUsage(cpu);
            const { profile } = await profiler.post('Profiler.stop');
            // Routed TMPDIR is retired at command exit; keep the deciding profile
            // in the existing ignored evidence area for post-run inspection.
            const evidenceDirectory = resolve(import.meta.dirname, '../../../../../.project/tmp'); await mkdir(evidenceDirectory, { recursive: true });
            const profileDirectory = await mkdtemp(join(evidenceDirectory, 'FX36-profile-'));
            const profilePath = join(profileDirectory, 'writer.cpuprofile'); await writeFile(profilePath, JSON.stringify(profile));
            const hotspots = profile.nodes.filter(node => node.hitCount).sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0)).slice(0, 20)
                .map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, hits: node.hitCount }));
            const stats = await index.stats('profile');
            expect(stats.fileRows).toBe(folders * perFolder); expect(index.readNode(root)?.complete).toBe(true);
            expect(index.readNode(root)?.node.size.allocatedBytes).toBe(nativeSummary.allocatedBytes);
            console.log(JSON.stringify({ qa: 'owned-large-native-index-profile', folders, perFolder, nativeRecords, nativeMs, elapsedMs,
                rowsPerSecond: stats.nodeRows * 1000 / elapsedMs, cpuUsed, costs, finishMs, batches, peakWriterRssBytes, ...stats, hotspots, profilePath }));
        } finally { profiler.disconnect(); await runner.dispose(); }
    }, 0);
    it.skipIf(process.env.HAPPIER_SCAN_QA_HOME !== '1')('measures actual home-tree index cost without opening file contents', async () => {
        const { readProcessCensus } = await import('@/processes/census/processCensus');
        const index = createStorageScanIndex({ activeServerDir: join(scratch, 'home-qa-state') });
        const baselineIndexWriterRssBytes = process.memoryUsage().rss; let peakRss = baselineIndexWriterRssBytes;
        let peakNativeRss = 0; let firstObservedNativeRssBytes: number | undefined; let nativeSamples = 0; let scanId: string | undefined; let sampling: Promise<void> | undefined;
        const sample = () => {
            peakRss = Math.max(peakRss, process.memoryUsage().rss);
            const pid = scanId ? runner.activeNativePid(scanId) : undefined;
            if (!pid || sampling) return;
            sampling = readProcessCensus({ freshness: 'fresh', pids: [pid] }).then(snapshot => {
                if (snapshot.status !== 'ok') return;
                const memory = snapshot.rows.find(row => row.pid === pid)?.memory;
                if (memory?.kind === 'rss') { firstObservedNativeRssBytes ??= memory.bytes; nativeSamples++; peakNativeRss = Math.max(peakNativeRss, memory.bytes); }
            }).finally(() => { sampling = undefined; });
        };
        const runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'home-qa', mountPath: homedir(), usedBytes: 0 }], readEnabled: () => true,
            fullDiskAccess: () => ({ state: 'unknown', binary: { name: 'fixture', path: process.execPath } }), onChange: sample });
        await runner.initialize(); const started = performance.now(); const state = await runner.start({ target: { folderPath: homedir() } }); scanId = state.scanId;
        sample(); await runner.wait(state.scanId); await sampling;
        const elapsedMs = performance.now() - started; const stats = await index.stats('home-qa');
        console.log(JSON.stringify({ qa: 'metadata-only-home-tree', platform: process.platform, chartBudget: STORAGE_CHART_MAX_DRAWABLE_NODES,
            rootCoverageComplete: index.readNode(homedir())?.complete ?? false, unreadableCounts: index.state()?.unreadable.counts,
            unreadableExamples: index.state()?.unreadable.examples,
            elapsedMs, rowsPerSecond: stats.nodeRows * 1000 / elapsedMs,
            baselineIndexWriterRssBytes, peakIndexWriterRssBytes: peakRss, firstObservedNativeRssBytes,
            peakNativeRssBytes: peakNativeRss, nativeRssSamples: nativeSamples, ...stats, status: index.state()?.status }));
        expect(index.state()?.status).toBe('complete'); expect(stats.nodeRows).toBeGreaterThan(0); await runner.dispose();
    }, 0);
});
