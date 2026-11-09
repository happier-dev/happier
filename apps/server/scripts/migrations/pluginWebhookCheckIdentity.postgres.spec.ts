import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { createPluginWebhookCheckIdDigestV1 } from '../../sources/app/plugins/webhooks/checkIdDigest';
import { resolveServerScriptCommandInvocation } from '../runCommand';

const migrationId = '20261101151500_plugin_webhook_check_identity';
const migrationsDir = join(import.meta.dirname, '../../prisma/migrations');

describe('PostgreSQL webhook check identity migration', () => {
    it('deploys every canonical migration through the PostgreSQL light owner and replays without changing its ledger', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-heartbeat-full-postgres-'));
        const databaseDir = join(root, 'pglite');
        let database: PGlite | undefined;
        const deploy = async () => {
            const env = { ...process.env, HAPPIER_DB_PROVIDER: 'pglite', HAPPY_DB_PROVIDER: 'pglite',
                HAPPIER_SERVER_LIGHT_DATA_DIR: root, HAPPY_SERVER_LIGHT_DATA_DIR: root,
                HAPPIER_SERVER_LIGHT_DB_DIR: databaseDir, HAPPY_SERVER_LIGHT_DB_DIR: databaseDir };
            const invocation = resolveServerScriptCommandInvocation('pnpm', ['--silent', 'run', 'migrate:light:deploy'], env);
            await new Promise<void>((resolve, reject) => {
                const child = spawn(invocation.command, invocation.args, { cwd: join(import.meta.dirname, '../..'),
                    env, stdio: ['ignore', 'pipe', 'pipe'],
                    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
                let output = '';
                child.stdout.on('data', chunk => { output += String(chunk); });
                child.stderr.on('data', chunk => { output += String(chunk); });
                child.on('error', reject);
                child.on('close', code => code === 0 ? resolve() : reject(new Error(`migrate:light:deploy exited ${code}: ${output}`)));
            });
        };
        try {
            await deploy();
            database = new PGlite(databaseDir);
            const ledgerSql = 'SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name';
            const expected = await Promise.all((await readdir(migrationsDir, { withFileTypes: true }))
                .filter(entry => entry.isDirectory()).map(async entry => ({ migration_name: entry.name,
                    checksum: createHash('sha256').update(await readFile(join(migrationsDir, entry.name, 'migration.sql'))).digest('hex'),
                })));
            expected.sort((left, right) => left.migration_name.localeCompare(right.migration_name));
            expect((await database.query(ledgerSql)).rows).toEqual(expected);
            expect(expected.some(entry => entry.migration_name === migrationId)).toBe(true);
            const columns = await database.query(
                `SELECT column_name, data_type, is_nullable FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'PluginWebhookEndpoint'
                 AND column_name IN ('checkId', 'checkIdDigest', 'lastAcceptedAt') ORDER BY column_name`);
            expect(columns.rows).toEqual([
                { column_name: 'checkId', data_type: 'text', is_nullable: 'NO' },
                { column_name: 'checkIdDigest', data_type: 'text', is_nullable: 'NO' },
                { column_name: 'lastAcceptedAt', data_type: 'timestamp without time zone', is_nullable: 'YES' },
            ]);
            await database.close();
            database = undefined;
            await deploy();
            database = new PGlite(databaseDir);
            expect((await database.query(ledgerSql)).rows).toEqual(expected);
        } finally {
            await database?.close();
            await rm(root, { recursive: true, force: true });
        }
    }, 180_000);

    it('backfills legacy rows with the exported canonical digest and preserves exact long Unicode check identity', async () => {
        const database = new PGlite();
        try {
            // The predecessor identity columns and unique index are the real August/October schema.
            // Only this isolated table is needed to discriminate the new SQL backfill and index behavior.
            await database.exec(`CREATE TABLE "PluginWebhookEndpoint" (
                "id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "pluginId" TEXT NOT NULL,
                "webhookContributionId" TEXT NOT NULL, "sourceInstanceId" TEXT,
                "checkId" VARCHAR(128) COLLATE "C" NOT NULL DEFAULT '', "lastAcceptedAt" TIMESTAMP(3));
                CREATE UNIQUE INDEX "plugin_webhook_endpoint_account_contribution_source_key"
                ON "PluginWebhookEndpoint"("accountId","pluginId","webhookContributionId","sourceInstanceId","checkId");`);
            const vectors = ['', 'ordinary-check', '雪🙂é', 'quote" and slash\\', '\b\f\n\r\t', '\u0001\u001f', '\u2028\u2029'];
            for (const [index, checkId] of vectors.entries()) {
                await database.query(`INSERT INTO "PluginWebhookEndpoint"
                    ("id","accountId","pluginId","webhookContributionId","sourceInstanceId","checkId")
                    VALUES ($1,'owner','machine-services','heartbeat',$2,$3)`, [`legacy-${index}`, `source-${index}`, checkId]);
            }
            await database.query(`INSERT INTO "PluginWebhookEndpoint"
                ("id","accountId","pluginId","webhookContributionId","sourceInstanceId")
                VALUES ('null-source','owner','machine-services','heartbeat',NULL)`);
            await database.exec(await readFile(join(migrationsDir, migrationId, 'migration.sql'), 'utf8'));
            const rows = await database.query<{ id: string; checkId: string; checkIdDigest: string; lastAcceptedAt: null }>(
                `SELECT "id","checkId","checkIdDigest","lastAcceptedAt" FROM "PluginWebhookEndpoint" ORDER BY "id"`);
            expect(rows.rows).toEqual([
                ...vectors.map((checkId, index) => ({ id: `legacy-${index}`, checkId,
                    checkIdDigest: createPluginWebhookCheckIdDigestV1(checkId), lastAcceptedAt: null })),
                { id: 'null-source', checkId: '', checkIdDigest: '', lastAcceptedAt: null },
            ]);
            const insert = (id: string, checkId: string, sourceInstanceId: string | null) => database.query(
                `INSERT INTO "PluginWebhookEndpoint"
                 ("id","accountId","pluginId","webhookContributionId","sourceInstanceId","checkId","checkIdDigest")
                 VALUES ($1,'owner','machine-services','heartbeat',$2,$3,$4)`,
                [id, sourceInstanceId, checkId, createPluginWebhookCheckIdDigestV1(checkId)]);
            const prefix = '雪🙂'.repeat(1000);
            const first = `${prefix}a`;
            const second = `${prefix}b`;
            await insert('long-first', first, 'shared-source');
            await insert('long-second', second, 'shared-source');
            await expect(insert('duplicate-long', first, 'shared-source')).rejects.toThrow();
            await expect(insert('duplicate-ordinary', '', 'source-0')).rejects.toThrow();
            await insert('second-null-source', '', null);
            const stored = await database.query<{ checkId: string }>(
                `SELECT "checkId" FROM "PluginWebhookEndpoint" WHERE "sourceInstanceId"='shared-source' ORDER BY "id"`);
            expect(stored.rows).toEqual([{ checkId: first }, { checkId: second }]);
        } finally {
            await database.close();
        }
    }, 120_000);
});
