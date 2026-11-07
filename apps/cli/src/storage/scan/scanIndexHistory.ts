import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { DiskScanStateV1Schema, type DiskScanStateV1 } from '@happier-dev/protocol/storage/storageV1';
import type { SqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { storagePathContains, storagePathsEqual } from '../storagePath';
import { scanDataTables, scanIndexSchema } from './scanIndexSchema';

const storedState = createStoredReadSchema(DiskScanStateV1Schema);
const valueRow = z.object({ value: z.string() });
const sqlRow = z.record(z.string(), z.unknown());

function readPreviousScanState(db: SqliteDatabaseSync): string | undefined {
    const attached = db.prepare('PRAGMA database_list').all().some(row => z.object({ name: z.string() }).parse(row).name === 'previous');
    if (!attached) return undefined;
    const row = db.prepare("SELECT value FROM previous.meta WHERE key='state'").get();
    return row ? valueRow.parse(row).value : undefined;
}

export function scanStateMatchesTarget(value: string, target: DiskScanStateV1['target']): boolean {
    const prior = storedState.parse(JSON.parse(value) as unknown).target;
    return 'folderPath' in prior ? 'folderPath' in target && storagePathsEqual(prior.folderPath, target.folderPath)
        : 'volumeId' in target && prior.volumeId === target.volumeId;
}

/** Copies a complete target's comparison facts before the live subtree changes. */
export async function prepareScanBaseline(db: SqliteDatabaseSync, target: DiskScanStateV1['target'],
    basis: Readonly<{ completeState: string; baselineState?: string; status?: DiskScanStateV1['status'] }>, yieldRow: () => Promise<void>): Promise<string | undefined> {
    const previous = readPreviousScanState(db);
    // Child scans update the current composite without completing its parent
    // again. Returning to that parent consumes its retained complete snapshot.
    const source = previous && scanStateMatchesTarget(previous, target) && !scanStateMatchesTarget(basis.completeState, target) ? 'previous.' : '';
    if (basis.baselineState && basis.status !== 'complete' && !source) return undefined;
    for (const table of scanDataTables) db.exec(`DROP TABLE IF EXISTS baseline_${table}; CREATE TABLE baseline_${table} AS SELECT * FROM ${table} WHERE 0`);
    // Build empty indexes before copying, so their maintenance belongs to each
    // yielded row rather than one full retained-tree sort at the end.
    db.exec(scanIndexSchema('', 'baseline_'));
    for (const table of scanDataTables) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(value => z.object({ name: z.string() }).parse(value).name);
        const insert = db.prepare(`INSERT INTO baseline_${table} VALUES(${columns.map(() => '?').join(',')})`);
        for (const row of db.prepare(`SELECT * FROM ${source}${table}`).iterate()) {
            const values = sqlRow.parse(row); insert.run(...columns.map(column => values[column])); await yieldRow();
        }
    }
    return source ? previous : basis.completeState;
}

/** A child completion must not replace the still-current parent snapshot. */
export function retainsParentScanHistory(db: SqliteDatabaseSync, root: string, wholeDiskRoot: string | undefined, baselineState: string): boolean {
    const value = readPreviousScanState(db); if (!value) return false;
    const { target } = storedState.parse(JSON.parse(value) as unknown);
    const parent = 'folderPath' in target ? target.folderPath : wholeDiskRoot;
    if (!parent || storagePathsEqual(parent, root) || !storagePathContains(parent, root)) return false;
    const baselineTarget = storedState.parse(JSON.parse(baselineState) as unknown).target;
    const baselineRoot = 'folderPath' in baselineTarget ? baselineTarget.folderPath : wholeDiskRoot;
    return Boolean(baselineRoot && !storagePathsEqual(parent, baselineRoot) && storagePathContains(parent, baselineRoot));
}
