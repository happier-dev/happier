import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { createStorageScanIndex } from './scanIndex';
import type { NativeDiskScanRecord } from '../measure/nativeDiskMeasure';

it.each([{ folders: 2048, files: 16 }, { folders: 8192, files: 32 }])('settles cancellation without rewriting $folders retained completed folders', async ({ folders, files }) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-settlement-'));
    const volumeId = 'retained'; const root = '/retained';
    const index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true);
    const admission = { volumeId, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable' as const, binary: { name: 'fixture', path: process.execPath } } };
    const directory = (id: string): Extract<NativeDiskScanRecord, { type: 'dir' }> => ({ v: 1, type: 'dir', id,
        name: id.split('/').at(-1)!, allocatedBytes: 0, logicalBytes: 0, ownLogicalBytes: 0, items: 1, mtimeMs: 2000,
        flags: { atLeast: true }, children: [], files: [], folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 },
        ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false, enumerated: false, streamed: true });
    let db: ReturnType<typeof openProtectedSqliteDatabaseSync> | undefined;
    // Observe the native SQLite boundary. A bounded rollup must seek the
    // changed parents' children, not visit every unrelated retained entry in
    // every stdout transaction. Row counts/wall time alone cannot detect that
    // hidden work (the SELECT returns the same small set either way).
    const { DatabaseSync } = await import('node:sqlite');
    const exec = DatabaseSync.prototype.exec;
    const childPlans: string[] = [];
    let retainedFileVisits = 0;
    const firstFile = folders + 2; const last = folders * (files + 1) + 1;
    const observed = new WeakSet<InstanceType<typeof DatabaseSync>>();
    const execution = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        const statement = sql.split(';').find(value => value.includes('INSERT OR IGNORE INTO scan_charge_owners SELECT'));
        if (statement && !observed.has(this)) {
            this.function('count_retained_visit', ref => {
                if (typeof ref === 'number' && ref >= firstFile && ref <= last) retainedFileVisits++;
                return 1;
            });
            observed.add(this);
        }
        const counted = statement?.replace(/\bWHERE /, 'WHERE count_retained_visit(e.ref) AND ');
        const result = exec.call(this, statement && counted ? sql.replace(statement, counted) : sql);
        if (statement && counted) {
            const plan = this.prepare(`EXPLAIN QUERY PLAN ${statement}`).all();
            for (const row of plan) if (typeof row.detail === 'string') childPlans.push(row.detail);
            // The non-filtering counter must not select a different access path.
            expect(this.prepare(`EXPLAIN QUERY PLAN ${counted}`).all().map(row => row.detail)).toEqual(plan.map(row => row.detail));
        }
        return result;
    });
    try {
        await index.begin(admission); index.ingest(volumeId, directory(root));
        db = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volumeId).digest('hex')}.sqlite`));
        // Retained normalized rows, as on reopening a previous scan. Both sizes
        // represent 10 GiB, with different folder/fact counts to expose scaling.
        const bytes = 10737418240; const fileBytes = bytes / (folders * files);
        db.exec(`BEGIN;
            WITH RECURSIVE ids(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM ids WHERE i<${last})
            INSERT INTO paths(ref,path) SELECT i,CASE WHEN i<${firstFile} THEN '/retained/'||i ELSE '/retained/'||(2+(i-${firstFile})/${files})||'/'||i END FROM ids;
            INSERT INTO entries SELECT ref,CASE WHEN ref<${firstFile} THEN 1 ELSE 2+(ref-${firstFile})/${files} END,
                CAST(ref AS TEXT),CASE WHEN ref<${firstFile} THEN 'folder' ELSE 'file' END,
                CASE WHEN ref<${firstFile} THEN ${fileBytes * files} ELSE ${fileBytes} END,2000,
                CASE WHEN ref<${firstFile} THEN ${files + 1} ELSE 1 END,1,
                '{"logicalBytes":0,"size":{"freesBytes":0,"sharedBytes":0,"sharedExtentsUnmeasured":false,"atLeast":false},"flags":{"happier":false,"protection":"none","atLeast":false,"inUse":false},"childCount":0}',1,0
                FROM paths WHERE ref>1;
            INSERT INTO dirs SELECT path,1,100,0,0,0,0,${fileBytes * files},1,0,1,1 FROM paths WHERE ref BETWEEN 2 AND ${firstFile - 1};
            INSERT INTO coverage SELECT id,100,1 FROM dirs WHERE complete=1;
            INSERT INTO allocation_observations SELECT ref,ref,'physical:'||ref,${fileBytes},2000,1 FROM paths WHERE ref>=${firstFile};
            UPDATE entries SET allocated=${bytes},items=${last} WHERE ref=1;
            COMMIT;
            CREATE TABLE settlement_writes(ref INTEGER);
            CREATE TRIGGER count_settlement_writes AFTER UPDATE ON entries BEGIN INSERT INTO settlement_writes VALUES(NEW.ref); END;`);
        // Only one new physical owner changes in this stdout batch. Its total
        // must already be durable before cancellation, without rewriting siblings.
        index.withIngestBatch(volumeId, () => {
            index.ingest(volumeId, { v: 1, type: 'dir-entry', parent: root, visible: true, retained: false, replaceFacts: true,
                node: { id: `${root}/new`, name: 'new', kind: 'file', allocatedBytes: 0, logicalBytes: 4096, items: 1, mtimeMs: 2000, flags: { atLeast: false } } });
            index.ingest(volumeId, { v: 1, type: 'fact', owner: `${root}/new`, fact: { key: 'new-physical', pathId: `${root}/new`, allocatedBytes: 4096, mtimeMs: 2000, ageIncluded: true } });
        });
        expect(index.readNode(root)?.node.size.allocatedBytes).toBe(bytes + 4096);
        expect(childPlans.length).toBeGreaterThan(0);
        expect(retainedFileVisits).toBe(0);
        expect(db.prepare(`SELECT COUNT(*) AS count FROM settlement_writes WHERE ref BETWEEN 2 AND ${last}`).get()).toEqual({ count: 0 });
        db.exec('DELETE FROM settlement_writes');
        const started = performance.now(); index.finish(volumeId, 'cancelled');
        const finishMs = performance.now() - started;
        const writes = db.prepare('SELECT COUNT(*) AS count FROM settlement_writes WHERE ref>1').get();
        console.log(JSON.stringify({ qa: 'retained-index-settlement', folders, facts: folders * files + 1, bytes: bytes + 4096, finishMs, writes }));
        expect(index.state()?.progress.sizedBytes).toBe(bytes + 4096);
        // A stop with no new observations must not rewrite completed siblings.
        expect(writes).toEqual({ count: 0 });
        // Admission replaces a known subtree before the helper produces any
        // output. The containing folder's retained total must already agree
        // with those committed facts, including cancellation before stdout.
        await index.begin({ ...admission, root: `${root}/2`, target: { folderPath: `${root}/2` } });
        expect(index.readNode(root)?.node.size.allocatedBytes).toBe(bytes + 4096 - fileBytes * files);
    } finally { execution.mockRestore(); db?.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});
