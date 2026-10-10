import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { prepareSqliteMigration } from '../../sources/flavors/light/qualifiedConnectedAccountsV4SqliteMigration';
import type { SqliteMigrationExecutor } from '../../sources/flavors/light/sqliteMigrations';

const directory = join(import.meta.dirname, '../../prisma/sqlite/migrations');
const target = '20261002090000_add_run_lifecycle_triggers';

// The moving 0.2 queue writer has no execution-input column. Start at its
// actual schema frontier, then keep those rows through every later CHECK copy.
const predecessorQueuedRowsSql = `
    INSERT INTO "Account"("id", "publicKey", "encryptionMode", "updatedAt") VALUES ('predecessor-account', 'predecessor-key', 'plain', CURRENT_TIMESTAMP);
    INSERT INTO "Machine"("id", "accountId", "metadata", "updatedAt") VALUES ('predecessor-machine', 'predecessor-account', '{}', CURRENT_TIMESTAMP);
    INSERT INTO "Automation"("id", "accountId", "name", "enabled", "scheduleKind", "timezone", "targetType", "templateCiphertext", "updatedAt")
        VALUES ('predecessor-automation', 'predecessor-account', '0.2 queued work', true, 'manual', 'UTC', 'new_session', '{}', CURRENT_TIMESTAMP);
    INSERT INTO "AutomationAssignment"("id", "automationId", "machineId", "enabled", "updatedAt")
        VALUES ('predecessor-assignment', 'predecessor-automation', 'predecessor-machine', true, CURRENT_TIMESTAMP);
    INSERT INTO "AutomationRun"("id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "updatedAt")
        VALUES ('predecessor-queued', 'predecessor-automation', 'predecessor-account', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
`;

function scopedPullRequestRowsSql(): string {
    return ['prComment', 'ciFailed'].flatMap(kind => {
        const triggerId = `scoped-${kind}`;
        return [
            `INSERT INTO "AutomationTrigger"("id", "automationId", "kind", "enabled", "sourceSessionId", "definitionEnvelope", "updatedAt")
                VALUES ('${triggerId}', 'automation', '${kind}', true, 'origin-session', 'opaque-trigger-definition', CURRENT_TIMESTAMP)`,
            ...['plain', 'encrypted'].map(mode => {
                const envelope = mode === 'plain' ? '{"t":"plain","v":{}}' : '{"t":"encrypted","c":"opaque-evidence"}';
                const equalityTag = mode === 'plain' ? 'NULL' : `'${'A'.repeat(43)}'`;
                return `INSERT INTO "AutomationRun"("id", "accountId", "automationId", "originKind", "state", "triggerId", "causeKind", "causeOccurredAt",
                    "occurrenceKey", "triggerEvidenceEnvelope", "occurrenceEvidenceEqualityTag", "scheduledAt", "dueAt", "updatedAt")
                    VALUES ('${triggerId}-${mode}', 'account', 'automation', 'automation', 'succeeded', '${triggerId}', 'conversation', CURRENT_TIMESTAMP,
                    '${triggerId}-${mode}', '${envelope}', ${equalityTag}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
            }),
        ];
    }).join(';\n') + ';';
}

it('preserves populated Automation rows, opaque content, assignments and incumbent constraints through the Run source expansion', async () => {
    const database = new DatabaseSync(':memory:');
    // Native SQLite is the persistence boundary. Preparation and all on-disk
    // migrations are real; no internal migrator or normalization is replaced.
    const executor: SqliteMigrationExecutor = {
        exec: sql => { database.exec(sql); },
        queryRows: (sql, params = []) => database.prepare(sql).all(...params),
        run: (sql, params = []) => { database.prepare(sql).run(...params); },
        queryTableNames: () => new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name))),
        queryAppliedMigrations: () => { throw new Error('This contract applies SQL, not a retained deploy ledger'); },
        insertAppliedMigration: () => { throw new Error('This contract applies SQL, not a retained deploy ledger'); },
    };
    try {
        const migrations = readdirSync(directory).filter(name => /^\d/.test(name)).sort();
        expect(migrations).toContain(target);
        for (const migration of migrations) {
            if (migration === target) break;
            if (migration === '20260816231000_add_event_automations_v1') database.exec(predecessorQueuedRowsSql);
            const sql = readFileSync(join(directory, migration, 'migration.sql'), 'utf8');
            database.exec(await prepareSqliteMigration(migration, sql, executor));
        }
        database.exec(`
            INSERT INTO Account(id, publicKey, encryptionMode, updatedAt) VALUES ('account', 'public-key', 'plain', 1);
            INSERT INTO Machine(id, accountId, metadata, updatedAt) VALUES ('machine', 'account', '{}', 1);
            INSERT INTO Automation(id, accountId, name, enabled, templateCiphertext, templateVersion, updatedAt)
                VALUES ('automation', 'account', 'Retained data', 1, 'opaque-retained-template-bytes', 1, 1);
            INSERT INTO AutomationAssignment(id, automationId, machineId, enabled, updatedAt)
                VALUES ('assignment', 'automation', 'machine', 1, 1);
            INSERT INTO AutomationTrigger(id, automationId, kind, enabled, scheduleKind, everyMs, nextRunAt, updatedAt)
                VALUES ('trigger', 'automation', 'schedule', 1, 'interval', 60000, 2, 1);
            INSERT INTO AutomationRun(id, accountId, automationId, originKind, state, causeKind, causeOccurredAt,
                idempotencyKey, scheduledAt, dueAt, finishedAt, summaryCiphertext, resultEnvelope, updatedAt)
                VALUES ('run', 'account', 'automation', 'automation', 'succeeded', 'manual', 1,
                'retained-manual-key', 1, 1, 2, 'opaque-summary-bytes', 'opaque-result-bytes', 1);
            INSERT INTO AutomationRunAssignment(runId, machineId) VALUES ('run', 'machine');
        `);
        const tables = ['Account', 'Machine', 'Automation', 'AutomationAssignment', 'AutomationTrigger', 'AutomationRun', 'AutomationRunAssignment'];
        const snapshots = tables.map(table => {
            const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map(column => String(column.name));
            const select = `SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${table}"`;
            return { table, select, rows: database.prepare(select).all() };
        });
        const indexColumns = (name: string) => database.prepare(`PRAGMA index_xinfo("${name}")`).all().map(({ cid: _physicalColumn, ...column }) => column);
        const indexPolicy = (table: string, name: string) => database.prepare(`PRAGMA index_list("${table}")`).all().find(row => row.name === name);
        const indexes = database.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND tbl_name IN ('AutomationRun','AutomationTrigger') AND sql IS NOT NULL ORDER BY name").all().map(index => ({
            name: String(index.name), table: String(index.tbl_name), columns: indexColumns(String(index.name)),
            policy: indexPolicy(String(index.tbl_name), String(index.name)),
        }));
        database.exec(readFileSync(join(directory, target, 'migration.sql'), 'utf8'));
        expect(database.prepare(`SELECT "state", "executionInputEnvelope" FROM "AutomationRun" WHERE "id" = 'predecessor-queued'`).get()).toEqual({ state: 'queued', executionInputEnvelope: null });
        expect(() => database.exec(`UPDATE "AutomationRun" SET "startedAt"=CURRENT_TIMESTAMP WHERE "id"='predecessor-queued'`)).toThrow(/CHECK constraint failed/);
        for (const snapshot of snapshots) expect(database.prepare(snapshot.select).all(), snapshot.table).toEqual(snapshot.rows);
        for (const index of indexes) {
            expect(indexColumns(index.name), index.name).toEqual(index.columns);
            expect(indexPolicy(index.table, index.name), index.name).toMatchObject({ unique: index.policy?.unique, partial: index.policy?.partial });
        }
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        expect(() => database.exec("UPDATE AutomationRun SET causeScheduledFor=3 WHERE id='run'")).toThrow(/CHECK constraint failed/);
        expect(() => database.exec("UPDATE AutomationTrigger SET sourceSessionId='not-a-session' WHERE id='trigger'")).toThrow(/CHECK constraint failed/);
        database.exec(scopedPullRequestRowsSql());
        expect(database.prepare("SELECT kind, sourceSessionId FROM AutomationTrigger WHERE id LIKE 'scoped-%' ORDER BY kind").all()).toEqual([
            { kind: 'ciFailed', sourceSessionId: 'origin-session' }, { kind: 'prComment', sourceSessionId: 'origin-session' },
        ]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM AutomationRun WHERE triggerId LIKE 'scoped-%' AND causeKind='conversation'").get()?.count).toBe(4);
        expect(() => database.exec("UPDATE AutomationTrigger SET sourceSessionId=NULL WHERE id='scoped-prComment'")).toThrow(/CHECK constraint failed/);
        expect(() => database.exec("UPDATE AutomationTrigger SET definitionEnvelope=NULL WHERE id='scoped-ciFailed'")).toThrow(/CHECK constraint failed/);
        expect(() => database.exec("UPDATE AutomationTrigger SET sourceRunId='mixed-source' WHERE id='scoped-ciFailed'")).toThrow(/CHECK constraint failed/);
        expect(() => database.exec("UPDATE AutomationRun SET causeTriggerKind='schedule' WHERE id='scoped-prComment-plain'")).toThrow(/CHECK constraint failed/);
    } finally { database.close(); }
});

it('preserves actual PostgreSQL direct and Automation cause arms when expanding Run sources', async () => {
    const database = new PGlite();
    const postgresDirectory = join(import.meta.dirname, '../../prisma/migrations');
    try {
        for (const migration of readdirSync(postgresDirectory).filter(name => /^\d/.test(name)).sort()) {
            if (migration === target) break;
            try {
                if (migration === '20260816231000_add_event_automations_v1') await database.exec(predecessorQueuedRowsSql);
                await database.exec(readFileSync(join(postgresDirectory, migration, 'migration.sql'), 'utf8'));
            } catch (cause) {
                throw new Error(`PostgreSQL migration prerequisite failed: ${migration}`, { cause });
            }
        }
        await database.exec(`
            INSERT INTO "Account"("id", "publicKey", "encryptionMode", "updatedAt") VALUES ('account', 'public-key', 'plain', CURRENT_TIMESTAMP);
            INSERT INTO "Machine"("id", "accountId", "metadata", "updatedAt") VALUES ('machine', 'account', '{}', CURRENT_TIMESTAMP);
            INSERT INTO "Automation"("id", "accountId", "name", "enabled", "templateCiphertext", "templateVersion", "updatedAt")
                VALUES ('automation', 'account', 'Retained data', true, 'opaque-retained-template-bytes', 1, CURRENT_TIMESTAMP);
            INSERT INTO "AutomationAssignment"("id", "automationId", "machineId", "enabled", "updatedAt")
                VALUES ('assignment', 'automation', 'machine', true, CURRENT_TIMESTAMP);
            INSERT INTO "AutomationTrigger"("id", "automationId", "kind", "enabled", "scheduleKind", "everyMs", "nextRunAt", "updatedAt")
                VALUES ('trigger', 'automation', 'schedule', true, 'interval', 60000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO "AutomationRun"("id", "accountId", "automationId", "originKind", "state", "causeKind", "causeOccurredAt",
                "idempotencyKey", "scheduledAt", "dueAt", "finishedAt", "summaryCiphertext", "resultEnvelope", "updatedAt")
                VALUES ('run', 'account', 'automation', 'automation', 'succeeded', 'manual', CURRENT_TIMESTAMP,
                'retained-manual-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'opaque-summary-bytes', 'opaque-result-bytes', CURRENT_TIMESTAMP);
            INSERT INTO "AutomationRunAssignment"("runId", "machineId") VALUES ('run', 'machine');
            INSERT INTO "AutomationRun"("id", "accountId", "originKind", "causeKind", "state", "workflowAcceptedSnapshotEnvelope", "workflowCustodyState", "scheduledAt", "dueAt", "updatedAt")
                VALUES ('direct', 'account', 'direct', NULL, 'succeeded', '{"t":"plain","v":{}}', 'settled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        `);
        const snapshots = [];
        for (const table of ['Account', 'Machine', 'Automation', 'AutomationAssignment', 'AutomationTrigger', 'AutomationRun', 'AutomationRunAssignment']) {
            const { rows: columns } = await database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [table]);
            const select = `SELECT ${columns.map(column => `"${column.column_name}"`).join(',')} FROM "${table}" ORDER BY 1`;
            snapshots.push({ table, select, rows: (await database.query(select)).rows });
        }
        // Execute the real new migration inside a transaction, including its
        // enum expansion; no extracted/reconstructed CHECK replaces the bytes.
        await database.transaction(async transaction => {
            await transaction.exec(readFileSync(join(postgresDirectory, target, 'migration.sql'), 'utf8'));
        });
        expect((await database.query(`SELECT "state"::text, "executionInputEnvelope" FROM "AutomationRun" WHERE "id"='predecessor-queued'`)).rows).toEqual([{ state: 'queued', executionInputEnvelope: null }]);
        await expect(database.exec(`UPDATE "AutomationRun" SET "startedAt"=CURRENT_TIMESTAMP WHERE "id"='predecessor-queued'`)).rejects.toMatchObject({ code: '23514' });
        for (const snapshot of snapshots) expect((await database.query(snapshot.select)).rows, snapshot.table).toEqual(snapshot.rows);
        await expect(database.exec(`UPDATE "AutomationRun" SET "finishedAt"=CURRENT_TIMESTAMP WHERE "id"='direct'`)).resolves.toBeDefined();
        await expect(database.exec(`UPDATE "AutomationRun" SET "causeScheduledFor"=CURRENT_TIMESTAMP WHERE "id"='run'`)).rejects.toMatchObject({ code: '23514' });
        await expect(database.exec(`UPDATE "AutomationTrigger" SET "sourceSessionId"='not-a-session' WHERE "id"='trigger'`)).rejects.toMatchObject({ code: '23514' });
        await database.exec(scopedPullRequestRowsSql());
        expect((await database.query(`SELECT "kind", "sourceSessionId" FROM "AutomationTrigger" WHERE "id" LIKE 'scoped-%' ORDER BY "kind"::text`)).rows).toEqual([
            { kind: 'ciFailed', sourceSessionId: 'origin-session' }, { kind: 'prComment', sourceSessionId: 'origin-session' },
        ]);
        expect((await database.query<{ count: number }>(`SELECT COUNT(*)::integer AS count FROM "AutomationRun" WHERE "triggerId" LIKE 'scoped-%' AND "causeKind"='conversation'`)).rows[0]?.count).toBe(4);
        await expect(database.exec(`UPDATE "AutomationTrigger" SET "sourceSessionId"=NULL WHERE "id"='scoped-prComment'`)).rejects.toMatchObject({ code: '23514' });
        await expect(database.exec(`UPDATE "AutomationTrigger" SET "definitionEnvelope"=NULL WHERE "id"='scoped-ciFailed'`)).rejects.toMatchObject({ code: '23514' });
        await expect(database.exec(`UPDATE "AutomationTrigger" SET "sourceRunId"='mixed-source' WHERE "id"='scoped-ciFailed'`)).rejects.toMatchObject({ code: '23514' });
        await expect(database.exec(`UPDATE "AutomationRun" SET "causeTriggerKind"='schedule' WHERE "id"='scoped-prComment-plain'`)).rejects.toMatchObject({ code: '23514' });
    } finally { await database.close(); }
});
