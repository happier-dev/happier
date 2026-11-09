import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { createStorageScanIndex } from './scanIndex';
import { scanDataTables, scanIndexSchema } from './scanIndexSchema';
import { seedRetainedScanIndex } from './scanIndex.retained.testkit';

it('visits only the requested parent children for a size sorted retained page', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-page-cost-'));
    const volumeId = 'page-cost'; const root = '/retained';
    const index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true);
    await index.begin({ volumeId, root, target: { folderPath: root }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    const db = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volumeId).digest('hex')}.sqlite`));
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    const plans: string[][] = [];
    let visits = 0; let comparisonVisits = 0; let priorVisits = 0; let priorDirectoryVisits = 0;
    let priorViewCounted = false;
    const observed = new WeakSet<InstanceType<typeof DatabaseSync>>();
    try {
        // 22 first-level folders, 176 package folders and 299,904 file facts.
        // All normalized facts use the real retained schema and query owner.
        seedRetainedScanIndex(db, root);
        const expectedNames = db.prepare('SELECT name FROM entries e JOIN paths p ON p.ref=e.ref WHERE e.parent=1 ORDER BY allocated DESC,p.path ASC').all().map(row => z.object({ name: z.string() }).parse(row).name);
        for (const table of scanDataTables) db.exec(`CREATE TABLE baseline_${table} AS SELECT * FROM ${table}`);
        db.exec(scanIndexSchema('', 'baseline_'));
        db.prepare("INSERT INTO meta VALUES('baselineState',?)").run(JSON.stringify(index.state()));
        const priorView = z.object({ sql: z.string() }).parse(db.prepare("SELECT sql FROM sqlite_master WHERE name='baseline_nodes'").get()).sql;
        const observation = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
            if (sql.startsWith('INSERT INTO comparison_rows SELECT')) {
                if (!observed.has(this)) {
                    this.function('count_page_visit', () => { visits++; return 1; });
                    this.function('count_comparison_visit', () => { comparisonVisits++; return 1; }); observed.add(this);
                }
                this.function('count_prior_directory_visit', () => { priorDirectoryVisits++; return 1; });
                const counted = sql.replace(" WHERE n.kind IN", " WHERE count_comparison_visit() AND n.kind IN")
                    .replaceAll('FROM baseline_dirs d WHERE', 'FROM baseline_dirs d WHERE count_prior_directory_visit() AND');
                const ids = JSON.stringify(Array.from({ length: 22 }, (_, n) => `${root}/${23 - n}`));
                const explain = (query: string) => prepare.call(this, `EXPLAIN QUERY PLAN ${query}`).all(...Array.from({ length: query.split('?').length - 1 }, () => ids)).map(row => String(row.detail));
                const plan = explain(sql); plans.push(plan);
                if (!priorViewCounted) {
                    this.function('count_prior_visit', value => { priorVisits++; return value; });
                    db.exec(`DROP VIEW baseline_nodes; ${priorView.replace(' CASE WHEN parent.path IS NULL', ' count_prior_visit(CASE WHEN parent.path IS NULL').replace(' END AS data,e.seen', ' END) AS data,e.seen')}`);
                    priorViewCounted = true;
                }
                expect(explain(counted)).toEqual(plan);
                return prepare.call(this, counted);
            }
            if (!sql.startsWith('SELECT id,parent,data FROM nodes WHERE') || !sql.includes(' ORDER BY ')) return prepare.call(this, sql);
            if (!observed.has(this)) {
                this.function('count_page_visit', () => { visits++; return 1; });
                this.function('count_comparison_visit', () => { comparisonVisits++; return 1; }); observed.add(this);
            }
            const counted = sql.replace(' WHERE ', ' WHERE count_page_visit() AND ');
            const explain = (query: string) => prepare.call(this, `EXPLAIN QUERY PLAN ${query}`).all(root, 1, 204, 0).map(row => String(row.detail));
            const plan = explain(sql); plans.push(plan);
            expect(explain(counted)).toEqual(plan);
            return prepare.call(this, counted);
        });
        try {
            const page = index.readView({ view: { tab: 'folders', depth: 1, sort: { by: 'size', direction: 'desc' } } });
            console.log(JSON.stringify({ qa: 'sto19-page-cost', entries: 300103, visits, comparisonVisits, priorVisits, priorDirectoryVisits, plans }));
            expect(page.nodes.map(node => node.name)).toEqual(expectedNames);
            expect(page.nodes.every(node => node.deltaSincePrevious === 0)).toBe(true);
            expect(visits).toBeLessThanOrEqual(22);
            expect(comparisonVisits).toBeLessThanOrEqual(22);
            expect(priorVisits).toBeLessThanOrEqual(22);
            expect(priorDirectoryVisits).toBeLessThanOrEqual(44);
        } finally { observation.mockRestore(); }
    } finally { db.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});
