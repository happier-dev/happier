import type { DaemonDatabase, DaemonDatabaseMigration } from '@happier-dev/plugin-sdk/storage';
import type { PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';

export const productionFindingRetention = { table: 'captureFindingRepresentatives', timeColumn: 'at', changeKeyColumn: 'worktree' } as const;

export const productionFindingMigration: DaemonDatabaseMigration = {
    version: 10,
    id: 'production-finding-representatives',
    async up(tx) {
        await tx.execute(`CREATE TABLE captureFindingRepresentatives (
            worktree TEXT NOT NULL, occurrenceId TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(worktree, occurrenceId))`);
        await tx.execute('CREATE INDEX captureFindingRepresentativePending ON captureFindingRepresentatives(worktree, published, at, occurrenceId)');
    },
};

export const databaseFindingRetention = { table: 'captureDatabaseFindingOccurrences', timeColumn: 'at', changeKeyColumn: 'worktree' } as const;

export const databaseFindingMigration: DaemonDatabaseMigration = {
    version: 12,
    id: 'database-finding-occurrences',
    async up(tx) {
        await tx.execute(`CREATE TABLE captureDatabaseFindingOccurrences (
            worktree TEXT NOT NULL, findingId TEXT NOT NULL, traceId TEXT NOT NULL, at INTEGER NOT NULL,
            PRIMARY KEY(worktree, findingId, traceId))`);
        await tx.execute('CREATE INDEX captureDatabaseFindingOccurrenceTime ON captureDatabaseFindingOccurrences(at)');
    },
};

export function createProductionFindingStore(db: DaemonDatabase) {
    return {
        async hasDatabaseFinding(worktree: string, findingId: string): Promise<boolean> {
            const rows = await db.query(`SELECT 1 FROM captureDatabaseFindingOccurrences WHERE worktree = ? AND findingId = ? LIMIT 1`,
                [worktree, findingId]);
            return rows.length > 0;
        },
        async retainDatabaseFindingOccurrence(worktree: string, findingId: string, traceId: string, at: number) {
            await db.execute(`INSERT INTO captureDatabaseFindingOccurrences(worktree,findingId,traceId,at) VALUES(?,?,?,?)
                ON CONFLICT(worktree,findingId,traceId) DO NOTHING`, [worktree, findingId, traceId, at]);
        },
        async retainProductionFindings(worktree: string, observations: readonly PluginEventObservationV1[]) {
            if (observations.length === 0) return;
            await db.transaction(async tx => {
                for (const observation of observations) {
                    await tx.execute(`INSERT INTO captureFindingRepresentatives(worktree,occurrenceId,at,body) VALUES(?,?,?,?)
                        ON CONFLICT(worktree,occurrenceId) DO NOTHING`, [
                        worktree, observation.occurrenceId, observation.occurredAt, JSON.stringify(observation),
                    ]);
                }
            });
        },
        async pendingProductionFinding(worktree: string): Promise<PluginEventObservationV1 | undefined> {
            const [row] = await db.query<{ body: string }>(`SELECT body FROM captureFindingRepresentatives
                WHERE worktree = ? AND published = 0 ORDER BY at, occurrenceId LIMIT 1`, [worktree]);
            return row ? JSON.parse(row.body) : undefined;
        },
        async settleProductionFinding(worktree: string, observationId: string) {
            await db.execute('UPDATE captureFindingRepresentatives SET published = 1 WHERE worktree = ? AND occurrenceId = ?', [worktree, observationId]);
        },
    };
}
