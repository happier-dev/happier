import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { applyPostgresMigrations, applySqliteMigrations } from '../prismaMigrations';
import { splitMigrationStatements } from '../../sources/migrations/missingMigrationReconciliation';

const serverRoot = join(import.meta.dirname, '../..');
const previousMigration = '20261116195000_automation_subject_action_projection_final';
const migrationId = '20261117053000_automation_parent_turn_started';
type Provider = 'postgres' | 'sqlite' | 'mysql';
interface Database {
    execute(sql: string): Promise<unknown>;
    query(sql: string): Promise<Record<string, unknown>[]>;
}

async function readCorrection(provider: Provider): Promise<string> {
    const root = join(serverRoot, 'prisma', ...(provider === 'postgres' ? [] : [provider]), 'migrations', migrationId);
    return readFile(join(root, 'migration.sql'), 'utf8');
}

async function proveUpgrade(provider: Provider, db: Database, upgrade: () => Promise<unknown>) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    const insert = async (table: string, values: Readonly<Record<string, string | number | null>>) => {
        const literal = (value: string | number | null) => value === null ? 'NULL'
            : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
        await db.execute(`INSERT INTO ${q(table)} (${Object.keys(values).map(q)}) VALUES (${Object.values(values).map(literal)})`);
    };
    await insert('Account', { id: 'turn-start-owner', publicKey: 'turn-start-owner', updatedAt: '2026-11-17' });
    await insert('Automation', { id: 'turn-start-workflow', accountId: 'turn-start-owner', name: 'retained',
        templateCiphertext: 'opaque workflow', updatedAt: '2026-11-17' });
    const run = { accountId: 'turn-start-owner', automationId: 'turn-start-workflow', state: 'succeeded',
        causeKind: 'trigger', causeTriggerKind: 'sessionLifecycle', triggerId: 'retained-trigger', causeTriggerRevision: 2,
        causeOccurredAt: '2026-11-17', causeSessionLifecycleEvent: 'parentTurnCompleted', causeSourceSessionId: 'source-session',
        causeSourceTurnId: 'source-turn', causeSessionLifecyclePolicyKind: 'everyMatch',
        scheduledAt: '2026-11-17', dueAt: '2026-11-17', updatedAt: '2026-11-17' };
    // The old value is the fixture control; RED must be the new value's storage refusal.
    await insert('AutomationRun', { ...run, id: 'retained-completed', occurrenceKey: 'completed-occurrence' });
    await insert('AutomationRunEvent', { id: 'retained-event', runId: 'retained-completed', type: 'succeeded' });
    await insert('WorkflowRunInvocation', { id: 'retained-invocation', runId: 'retained-completed', sequence: 0,
        memberOrdinal: 0, contentEnvelope: 'opaque invocation', updatedAt: '2026-11-17' });
    await insert('AutomationRun', { ...run, id: 'retained-action', occurrenceKey: 'action-occurrence',
        causeTriggerKind: 'action', causeSessionLifecycleEvent: null, causeSourceSessionId: null,
        causeSourceTurnId: null, causeSessionLifecyclePolicyKind: null, causeActionEvidenceJson: '{"actionId":"session.stop"}' });
    await insert('AutomationRun', { ...run, id: 'retained-presence', occurrenceKey: 'presence-occurrence',
        causeTriggerKind: 'pluginEvent', causeSessionLifecycleEvent: null, causeSourceSessionId: null,
        causeSourceTurnId: null, causeSessionLifecyclePolicyKind: null, causeEventPluginId: 'happier.machine.services',
        causeEventLocalId: 'machine-offline', causeSourceSelectorId: 'presence-selector',
        causePluginEventEvidenceJson: '{"kind":"machinePresence","payload":{"transition":"offline"}}' });
    const bytes = provider === 'postgres' ? "decode('0001ff','hex')" : "X'0001FF'";
    await db.execute(`UPDATE ${q('AutomationRun')} SET ${q('resultEnvelopeBytes')}=${bytes},
        ${q('workflowCheckpointEnvelopeBytes')}=${bytes} WHERE ${q('id')}='retained-completed'`);
    const tables = ['AutomationRun', 'AutomationRunEvent', 'WorkflowRunInvocation'];
    const before = await Promise.all(tables.map(table => db.query(`SELECT * FROM ${q(table)} ORDER BY ${q('id')}`)));
    const metadata = provider === 'sqlite' ? await db.query(`SELECT type,name,sql FROM sqlite_master
        WHERE tbl_name='AutomationRun' AND type IN ('index','trigger') ORDER BY type,name`) : null;
    const foreignKeys = provider === 'sqlite' ? await db.query('PRAGMA foreign_key_list("AutomationRun")') : null;
    await upgrade();
    for (const [index, table] of tables.entries()) {
        expect(await db.query(`SELECT * FROM ${q(table)} ORDER BY ${q('id')}`)).toEqual(before[index]);
    }
    if (provider === 'sqlite') {
        expect(await db.query(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name='AutomationRun'
            AND type IN ('index','trigger') ORDER BY type,name`)).toEqual(metadata);
        expect(await db.query('PRAGMA foreign_key_list("AutomationRun")')).toEqual(foreignKeys);
    }
    const started = { ...run, causeSessionLifecycleEvent: 'parentTurnStarted' };
    await insert('AutomationRun', { ...started, id: 'started', occurrenceKey: 'started-occurrence' });
    expect(await db.query(`SELECT ${q('causeSessionLifecycleEvent')},${q('causeSourceTurnId')} FROM ${q('AutomationRun')}
        WHERE ${q('id')}='started'`)).toEqual([{ causeSessionLifecycleEvent: 'parentTurnStarted', causeSourceTurnId: 'source-turn' }]);
    for (const invalid of [
        { causeSourceTurnId: null }, { causeSourceSessionId: null }, { causeSessionLifecycleEvent: 'unknown-event' },
        { causeSessionLifecycleRequestId: 'request' }, { causeSessionLifecyclePolicyKind: 'unknown-policy' },
        { causeSessionLifecyclePolicyKind: 'nextMatches', causeSessionLifecycleConfiguredCount: 0 },
        { causeActionEvidenceJson: '{}' }, { causePluginEventEvidenceJson: '{}' }, { state: 'unknown-state' },
    ]) {
        await expect(insert('AutomationRun', { ...started, ...invalid, id: 'invalid', occurrenceKey: 'invalid-occurrence' })).rejects.toThrow();
    }
    await expect(db.execute(`DELETE FROM ${q('Automation')} WHERE ${q('id')}='turn-start-workflow'`)).rejects.toThrow();
    if (provider === 'sqlite') {
        expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
        expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    }
}

describe('Session turn-start cause storage upgrade', () => {
    it.each(['sqlite', 'postgres'] as const)('admits turn-start facts and preserves retained history and constraints on %s', async provider => {
        const scratch = await mkdtemp(join(tmpdir(), 'happier-turn-start-migration-'));
        const migrationsDir = join(scratch, 'migrations');
        const databasePath = join(scratch, 'test.sqlite');
        const sqlite = provider === 'sqlite' ? new DatabaseSync(databasePath) : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const db: Database = {
            execute: async sql => sqlite ? sqlite.exec(sql) : postgres!.exec(sql),
            query: async sql => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query<Record<string, unknown>>(sql)).rows,
        };
        const deploy = () => sqlite ? applySqliteMigrations({ databasePath, migrationsDir })
            : applyPostgresMigrations({ db: postgres!, migrationsDir });
        try {
            const root = join(serverRoot, 'prisma', ...(provider === 'postgres' ? [] : [provider]), 'migrations');
            for (const entry of await readdir(root, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name <= previousMigration) {
                    await cp(join(root, entry.name), join(migrationsDir, entry.name), { recursive: true });
                }
            }
            await deploy();
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            const ledger = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
            await proveUpgrade(provider, db, async () => {
                const sql = await readCorrection(provider);
                await mkdir(join(migrationsDir, migrationId), { recursive: true });
                await writeFile(join(migrationsDir, migrationId, 'migration.sql'), sql);
                await deploy();
            });
            const after = await db.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name');
            expect(after.filter(row => row.migration_name !== migrationId)).toEqual(ledger);
            expect(await deploy()).toEqual({ applied: [] });
        } finally {
            sqlite?.close();
            await postgres?.close();
            await rm(scratch, { recursive: true, force: true });
        }
    }, 120_000);

    const mysqlUrl = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID && process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
    (mysqlUrl ? it : it.skip)('preserves MySQL enum values and rejects malformed turn-start causes', async () => {
        const { createDbMaintenanceClient } = await import('../../sources/storage/prisma');
        const client = await createDbMaintenanceClient('mysql', mysqlUrl || undefined);
        const db: Database = { execute: sql => client.$executeRawUnsafe(sql),
            query: sql => client.$queryRawUnsafe<Record<string, unknown>[]>(sql) };
        try {
            await proveUpgrade('mysql', db, async () => {
                const sql = await readCorrection('mysql');
                for (const statement of splitMigrationStatements(sql)) await db.execute(statement);
            });
        } finally { await client.$disconnect(); }
    }, 120_000);
});
