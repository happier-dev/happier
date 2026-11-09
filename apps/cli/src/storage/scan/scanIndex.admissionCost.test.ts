import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { Session, type Profiler } from 'node:inspector';
import type { SQLInputValue } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { createStorageScanIndex } from './scanIndex';
import { seedRetainedScanIndex } from './scanIndex.retained.testkit';
import { createStorageScanRunner } from './scanRunner';

// Observe unlink ordering at the OS boundary; every filesystem operation is real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, rm: vi.fn(actual.rm) };
});

it('does not JSON-encode retained SQLite rows just to budget admission work', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-admission-encoding-'));
    const volumeId = 'admission-encoding'; const root = '/retained';
    const index = createStorageScanIndex({ activeServerDir });
    const admission = { volumeId, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable' as const, binary: { name: 'fixture', path: process.execPath } } };
    await index.initialize([], true); await index.begin(admission);
    const db = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volumeId).digest('hex')}.sqlite`));
    seedRetainedScanIndex(db, root, 399); index.finish(volumeId, 'complete');
    const encoding = vi.spyOn(JSON, 'stringify');
    try {
        await index.begin(admission);
        // These are SQLite row identities, not wire/state payloads that
        // legitimately need encoding. Include paths and directories as well
        // as normalized entry references in this CPU-work count.
        const rowEncodings = encoding.mock.calls.filter(([value]) => typeof value === 'object' && value !== null
            && ('ref' in value || 'id' in value || 'path' in value)).length;
        expect(rowEncodings).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS n FROM baseline_entries').get()).toEqual({ n: 399 });
    } finally { encoding.mockRestore(); db.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});

it('yields retained admission row work while readers keep the committed tree', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-admission-cost-'));
    const volumeId = 'admission-cost'; const root = '/retained';
    const index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true);
    const admission = { volumeId, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable' as const, binary: { name: 'fixture', path: process.execPath } } };
    await index.begin(admission);
    const db = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volumeId).digest('hex')}.sqlite`));
    seedRetainedScanIndex(db, root); index.finish(volumeId, 'complete');
    const before = index.readView();
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare; const exec = DatabaseSync.prototype.exec;
    let rowsThisTurn = 0; let maxRows = 0; let turns = 0; let deleted = 0; let copiedEntries = 0; let observing = true;
    let firstRead = false; let copyingRead = false; let deletingRead = false; let observerError: unknown;
    let copyingAttempt = false; let deletingAttempt = false;
    const record = (rows: number) => { rowsThisTurn += rows; maxRows = Math.max(maxRows, rowsThisTurn); };
    const changes = (connection: InstanceType<typeof DatabaseSync>) => Number(prepare.call(connection, 'SELECT total_changes() AS n').get()!.n);
    const execution = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        const previous = changes(this); const result = exec.call(this, sql); record(changes(this) - previous);
        // SQLite CTAS does not include copied rows in total_changes(). Count
        // its actual result too, so the original bulk baseline is observable.
        for (const match of sql.matchAll(/CREATE TABLE (baseline_\w+) AS SELECT \* FROM \w+(?![\s\S]*WHERE 0)/g)) {
            record(Number(prepare.call(this, `SELECT COUNT(*) AS n FROM ${match[1]}`).get()!.n));
        }
        if (sql.includes('DELETE FROM nodes WHERE id IN')) deleted += 300103;
        return result;
    });
    const preparation = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        const connection = this; const statement = prepare.call(connection, sql); const run = statement.run;
        statement.run = function (...args: (SQLInputValue | Record<string, SQLInputValue>)[]) {
            // Preserve both native positional and named-parameter overloads.
            const result: ReturnType<typeof run> = Reflect.apply(run, statement, args); record(Number(result.changes));
            if (sql.startsWith('DELETE FROM entries WHERE')) deleted += Number(result.changes);
            if (sql.startsWith('INSERT INTO baseline_entries')) copiedEntries += Number(result.changes);
            return result;
        };
        return statement;
    });
    const observe = () => {
        if (!observing) return;
        rowsThisTurn = 0; turns++;
        if (!firstRead || copiedEntries >= 10000 && !copyingAttempt || deleted > 0 && !deletingAttempt) {
            if (copiedEntries >= 10000) copyingAttempt = true;
            if (deleted > 0) deletingAttempt = true;
            try {
                expect(index.readView()).toEqual(before);
                firstRead = true; if (copiedEntries >= 10000) copyingRead = true; if (deleted > 0) deletingRead = true;
            } catch (error) { observerError = error; }
        }
        setImmediate(observe);
    };
    setImmediate(observe);
    const profiler = process.env.STO19_INDEX_PROFILE === '1' ? new Session() : undefined;
    if (profiler) {
        profiler.connect();
        await new Promise<void>((resolve, reject) => profiler.post('Profiler.enable', error => error ? reject(error) : resolve()));
        await new Promise<void>((resolve, reject) => profiler.post('Profiler.start', error => error ? reject(error) : resolve()));
    }
    try {
        const admitted = await index.begin(admission);
        observing = false;
        console.log(JSON.stringify({ qa: 'sto19-admission-cost', retained: 300103, turns, maxRows, firstRead, copyingRead, deletingRead }));
        expect(observerError).toBeUndefined();
        expect(turns).toBeGreaterThan(0);
        // Each logical row has at most seven bookkeeping changes. The work
        // quantum is SQLite's maximum table-cell count in the actual page:
        // 8-byte leaf header, 2-byte pointer, payload-length and rowid varints.
        const pageBytes = z.object({ page_size: z.number() }).parse(db.prepare('PRAGMA page_size').get()).page_size;
        expect(maxRows).toBeLessThanOrEqual(Math.floor((pageBytes - 8) / (2 + 1 + 1)) * 7 + 7);
        expect(firstRead && copyingRead && deletingRead).toBe(true);
        expect(admitted.scanId).not.toBe(before.state?.scanId);
        expect(index.readView().nodes).toEqual([]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM baseline_entries').get()).toEqual({ n: 300103 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 0 });
    } finally {
        observing = false; preparation.mockRestore(); execution.mockRestore();
        if (profiler) {
            const { profile } = await new Promise<Profiler.StopReturnType>((resolve, reject) => profiler.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result)));
            await writeFile('/tmp/sto19-index-admission.cpuprofile', JSON.stringify(profile)); profiler.disconnect();
        }
        db.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true });
    }
}, 120_000);

it('keeps Cancel responsive during runner admission and rolls preparation back on disposal', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-admission-cancel-'));
    const volume = { id: 'cancel-admission', mountPath: '/', usedBytes: 0 }; const root = '/retained';
    const fullDiskAccess = { state: 'not_applicable' as const, binary: { name: 'fixture', path: process.execPath } };
    const index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true);
    await index.begin({ volumeId: volume.id, root, target: { folderPath: root }, usedBytes: 0, fullDiskAccess });
    const file = join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volume.id).digest('hex')}.sqlite`);
    const db = openProtectedSqliteDatabaseSync(file);
    seedRetainedScanIndex(db, root, 399); index.finish(volume.id, 'complete');
    const before = index.readView();
    const runner = createStorageScanRunner({ index, readVolumes: () => [volume], readEnabled: () => true, fullDiskAccess: () => fullDiskAccess });
    const { DatabaseSync } = await import('node:sqlite'); const exec = DatabaseSync.prototype.exec;
    let admissionStarted: () => void = () => {};
    const preparing = new Promise<void>(resolve => { admissionStarted = resolve; });
    const execution = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        const result = exec.call(this, sql); if (sql === 'BEGIN IMMEDIATE') admissionStarted(); return result;
    });
    try {
        const starting = runner.start({ target: { folderPath: root } });
        // The old published id remains independently readable/cancellable. The
        // new id is published only after admission commits, so Dispose is the
        // lifecycle authority that can retire this not-yet-published start.
        await preparing;
        expect(await runner.cancel(before.state!.scanId)).toEqual(before.state);
        expect(index.readView()).toEqual(before);
        const stopped = runner.dispose();
        await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
        await stopped;
        const reopened = createStorageScanIndex({ activeServerDir });
        try {
            await reopened.initialize([volume], true);
            expect(reopened.readView()).toEqual(before);
            expect(db.prepare("SELECT value FROM meta WHERE key='baselineState'").get()).toBeUndefined();
            db.exec('BEGIN IMMEDIATE; ROLLBACK;');
        } finally { reopened.close(); }
    } finally { execution.mockRestore(); await runner.dispose(); db.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});

it('keeps a completed-node iterator usable across a successful admission', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-admission-iterator-'));
    const volumeId = 'iterator'; const root = '/retained'; const index = createStorageScanIndex({ activeServerDir });
    const admission = { volumeId, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable' as const, binary: { name: 'fixture', path: process.execPath } } };
    await index.initialize([], true); await index.begin(admission);
    const db = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volumeId).digest('hex')}.sqlite`));
    seedRetainedScanIndex(db, root, 399); index.finish(volumeId, 'complete');
    const iterator = index.iterateCompletedNodes()[Symbol.iterator]();
    try {
        expect(iterator.next().done).toBe(false);
        const admitted = await index.begin({ ...admission, relistOnly: true });
        expect(index.state()?.scanId).toBe(admitted.scanId);
        index.ingest(volumeId, { v: 1, type: 'fact', owner: `${root}/200`, fact: { pathId: `${root}/200`, key: 'physical:200', allocatedBytes: 131072, mtimeMs: 2000, ageIncluded: true } });
        const next = iterator.next(); expect(next.done).toBe(false);
        expect(next.value?.scanId).not.toBe(admitted.scanId);
    } finally { iterator.return?.(); db.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});

it.each(['opt-out', 'volume-removed', 'close'] as const)('retires a held scoped reader before %s cleanup and stops its pending iterator', async mode => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-reader-retirement-'));
    const volume = { id: 'reader-retirement', mountPath: '/', usedBytes: 0 }; const root = '/retained';
    const index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true); await index.begin({ volumeId: volume.id, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    const file = join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volume.id).digest('hex')}.sqlite`);
    const db = openProtectedSqliteDatabaseSync(file);
    seedRetainedScanIndex(db, root, 399); index.finish(volume.id, 'complete'); db.close();
    const { DatabaseSync } = await import('node:sqlite'); const prepare = DatabaseSync.prototype.prepare;
    let reader: InstanceType<typeof DatabaseSync> | undefined;
    const preparation = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        if (sql.startsWith('SELECT n.id,n.parent,n.data') && sql.includes('FROM nodes n JOIN dirs')) reader = this;
        return prepare.call(this, sql);
    });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let unlinks = 0;
    vi.mocked(filesystem.rm).mockImplementation(async (...args) => {
        if (String(args[0]).startsWith(file)) {
            expect(reader?.isOpen).toBe(false); unlinks++;
        }
        return actual.rm(...args);
    });
    const iterator = index.iterateCompletedNodes()[Symbol.iterator]();
    try {
        expect(iterator.next().done).toBe(false); expect(reader?.isOpen).toBe(true);
        if (mode === 'close') index.close();
        else await index.initialize([], mode === 'volume-removed');
        expect(reader?.isOpen).toBe(false);
        if (mode !== 'close') expect(unlinks).toBeGreaterThan(0);
        expect(iterator.next()).toEqual({ done: true, value: undefined });
    } finally {
        preparation.mockRestore(); vi.mocked(filesystem.rm).mockImplementation(actual.rm);
        iterator.return?.(); index.close(); await rm(activeServerDir, { recursive: true, force: true });
    }
});

it('recovers history rotation between its previous-file commit and main contraction', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-history-rotation-'));
    const volume = { id: 'history', mountPath: '/', usedBytes: 0 }; const root = '/retained';
    const admission = { volumeId: volume.id, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable' as const, binary: { name: 'fixture', path: process.execPath } } };
    let index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true); await index.begin(admission);
    const file = join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volume.id).digest('hex')}.sqlite`);
    const db = openProtectedSqliteDatabaseSync(file); seedRetainedScanIndex(db, root, 399); index.finish(volume.id, 'complete');
    const initial = index.readNode(root)!.node.size.allocatedBytes;
    const change = (extra: number) => index.ingest(volume.id, { v: 1, type: 'fact', owner: `${root}/200`, fact: {
        pathId: `${root}/200`, key: 'physical:200', allocatedBytes: (200 % 31 + 1) * 4096 + extra, mtimeMs: 2000, ageIncluded: true } });
    let previous: ReturnType<typeof openProtectedSqliteDatabaseSync> | undefined;
    try {
        await index.begin({ ...admission, relistOnly: true }); change(4096);
        const { DatabaseSync } = await import('node:sqlite'); const exec = DatabaseSync.prototype.exec;
        const firstFailure = new Error('First rotation interrupted');
        const firstExecution = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
            if (sql.startsWith('DROP VIEW IF EXISTS baseline_files')) throw firstFailure;
            return exec.call(this, sql);
        });
        try { expect(() => index.finish(volume.id, 'complete')).toThrow(firstFailure); }
        finally { firstExecution.mockRestore(); }
        expect(() => index.finish(volume.id, 'complete')).not.toThrow();
        await index.begin({ ...admission, relistOnly: true }); change(8192);
        const failure = new Error('Interrupted after previous commit');
        const execution = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
            if (sql.startsWith('DROP VIEW IF EXISTS baseline_files')) throw failure;
            return exec.call(this, sql);
        });
        try { expect(() => index.finish(volume.id, 'complete')).toThrow(failure); }
        finally { execution.mockRestore(); }
        previous = openProtectedSqliteDatabaseSync(file.replace('.sqlite', '.previous.sqlite'));
        expect(previous.prepare('SELECT allocated FROM nodes WHERE id=?').get(root)).toEqual({ allocated: initial + 4096 });
        index.close(); index = createStorageScanIndex({ activeServerDir }); await index.initialize([volume], true);
        expect(index.readView().state?.status).toBe('complete');
        expect(index.readNode(root)!.node.size.allocatedBytes).toBe(initial + 8192);
        expect(index.readView({ view: { tab: 'folders', depth: 1, nodeId: `${root}/24` } }).nodes.find(node => node.nodeId === `${root}/200`)?.deltaSincePrevious).toBe(4096);
        index.finish(volume.id, 'complete');
        await index.begin({ ...admission, relistOnly: true }); change(12288);
        expect(index.readView({ view: { tab: 'folders', depth: 1, nodeId: `${root}/24` } }).nodes.find(node => node.nodeId === `${root}/200`)?.deltaSincePrevious).toBe(4096);
    } finally { previous?.close(); db.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});

it('prepares fresh prior-directory hints without visiting retained file leaves in one scope step', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-prior-cost-'));
    const volumeId = 'prior-cost'; const root = '/retained'; const index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true); await index.begin({ volumeId, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    const db = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volumeId).digest('hex')}.sqlite`));
    seedRetainedScanIndex(db, root); index.finish(volumeId, 'complete');
    const { DatabaseSync } = await import('node:sqlite'); const prepare = DatabaseSync.prototype.prepare;
    let visits = 0; let thisTurn = 0; let maxVisits = 0; let observing = true;
    const observe = () => { if (!observing) return; thisTurn = 0; setImmediate(observe); }; setImmediate(observe);
    const preparation = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        if (!sql.startsWith('SELECT id,allocated FROM nodes')) return prepare.call(this, sql);
        this.function('count_prior_scope_visit', value => { visits++; thisTurn++; maxVisits = Math.max(maxVisits, thisTurn); return value; });
        const counted = sql.replace('SELECT n.id FROM nodes n JOIN scope', 'SELECT count_prior_scope_visit(n.id) FROM nodes n JOIN scope');
        const explain = (query: string) => prepare.call(this, `EXPLAIN QUERY PLAN ${query}`).all(root).map(row => row.detail);
        expect(explain(counted)).toEqual(explain(sql));
        return prepare.call(this, counted);
    });
    let projection: Awaited<ReturnType<typeof index.writePriorProjection>>;
    try {
        projection = await index.writePriorProjection(volumeId);
        console.log(JSON.stringify({ qa: 'sto19-prior-cost', retained: 300103, visits, maxVisits }));
        expect(visits).toBeGreaterThan(0);
        expect(maxVisits).toBeLessThanOrEqual(199);
        expect((await readFile(projection!.path, 'utf8')).trim().split('\n')).toHaveLength(199);
    } finally { observing = false; preparation.mockRestore(); await projection?.dispose(); db.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});
