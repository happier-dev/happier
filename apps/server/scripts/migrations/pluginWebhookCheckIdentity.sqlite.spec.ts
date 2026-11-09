import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prepareSqliteMigration } from '../../sources/flavors/light/qualifiedConnectedAccountsV4SqliteMigration';
import type { SqliteMigrationExecutor } from '../../sources/flavors/light/sqliteMigrations';

describe('heartbeat SQLite identity migration', () => {
    it('backfills every retained exact identity through the canonical transactional preparation hook', async () => {
        const database = new DatabaseSync(':memory:');
        try {
            const predecessor = await readFile(new URL('../../prisma/sqlite/migrations/20260810130000_add_plugin_webhook_ingress_v1/migration.sql', import.meta.url), 'utf8');
            database.exec('CREATE TABLE Account (id TEXT PRIMARY KEY); CREATE TABLE PluginWebhookRoute (id TEXT PRIMARY KEY); INSERT INTO Account VALUES (\'account\'); INSERT INTO PluginWebhookRoute VALUES (\'route\');');
            database.exec(predecessor.slice(predecessor.indexOf('CREATE TABLE "PluginWebhookEndpoint" ('), predecessor.indexOf('CREATE TABLE "PluginWebhookEndpointOperation"')));
            database.exec('ALTER TABLE PluginWebhookEndpoint ADD COLUMN providerConfirmedAt DATETIME; ALTER TABLE PluginWebhookEndpoint ADD COLUMN targetIntentEpoch INTEGER; ALTER TABLE PluginWebhookEndpoint ADD COLUMN checkId TEXT NOT NULL DEFAULT \'\'; ALTER TABLE PluginWebhookEndpoint ADD COLUMN lastAcceptedAt DATETIME;');
            const vectors = ['', 'ordinary', '雪🙂é', 'quote"\\slash/', '\b\f\n\r\t\u0001\u001f', '\u2028\u2029', '脈'.repeat(2000)];
            vectors.forEach((value, index) => database.prepare('INSERT INTO PluginWebhookEndpoint (id, accountId, pluginId, webhookContributionId, sourceInstanceId, checkId, routeId, routingKind, updatedAt) VALUES (?, \'account\', \'plugin\', \'heartbeat\', \'same-source\', ?, \'route\', \'accountEndpoint\', \'preserve-clock\')').run(String(index), value));
            const executor = {
                exec: (sql: string) => { database.exec(sql); },
                queryRows: (sql: string, values = []) => database.prepare(sql).all(...values),
                run: (sql: string, values = []) => { database.prepare(sql).run(...values); },
                queryTableNames: () => new Set(['PluginWebhookEndpoint']),
                queryAppliedMigrations: () => [], insertAppliedMigration: () => {},
            } satisfies SqliteMigrationExecutor;
            database.exec('PRAGMA foreign_keys=OFF; BEGIN');
            const migration = await readFile(new URL('../../prisma/sqlite/migrations/20261101151500_plugin_webhook_check_identity/migration.sql', import.meta.url), 'utf8');
            const sql = await prepareSqliteMigration('20261101151500_plugin_webhook_check_identity',
                migration, executor);
            database.exec(sql);
            database.exec('COMMIT');
            const rows = database.prepare('SELECT checkId, checkIdDigest, updatedAt FROM PluginWebhookEndpoint ORDER BY id').all();
            expect(rows).toEqual(vectors.map(value => ({ checkId: value,
                checkIdDigest: value === '' ? '' : createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'),
                updatedAt: 'preserve-clock' })));
            expect(database.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            for (const update of ["revision=0", "routingKind='wrong'", "providerInstallationId='wrong'", "accountId=NULL"]) {
                expect(() => database.exec(`UPDATE PluginWebhookEndpoint SET ${update} WHERE id='0'`)).toThrow(/CHECK constraint failed/);
            }
            expect(() => database.exec("UPDATE PluginWebhookEndpoint SET checkIdDigest=NULL WHERE id='0'")).toThrow(/NOT NULL constraint/);
            expect(() => database.prepare('INSERT INTO PluginWebhookEndpoint (id, accountId, pluginId, webhookContributionId, sourceInstanceId, routeId, routingKind, updatedAt) VALUES (\'ordinary-duplicate\', \'account\', \'plugin\', \'heartbeat\', \'same-source\', \'route\', \'accountEndpoint\', \'clock\')').run()).toThrow(/UNIQUE constraint/);
        } finally { database.close(); }
    });
});
