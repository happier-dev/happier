import { readFile } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const migrationName = '20261118225000_webhook_bitbucket_hmac_verifier';
const previousMigrationName = '20261112180000_webhook_gitlab_token_verifier';
const kinds = ['github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'capabilityUrl_v1', 'gitlab_token_v1', 'bitbucket_hmac_sha256_v1'];
const migration = async (provider: 'sqlite' | 'postgres' | 'mysql', name = migrationName) => readFile(new URL(
    `../../../../prisma/${provider === 'postgres' ? '' : `${provider}/`}migrations/${name}/migration.sql`, import.meta.url), 'utf8');

it('preserves every retained SQLite delivery column, route, index and foreign key while widening verifier admission', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY); INSERT INTO "Account" VALUES (\'account\');');
        for (const name of ['20260810130000_add_plugin_webhook_ingress_v1',
            '20260823120000_add_plugin_webhook_endpoint_provider_confirmation',
            '20260902130000_add_plugin_webhook_endpoint_target_intent_epoch',
            '20261031131500_plugin_webhook_heartbeat_ingress']) {
            db.exec(await readFile(new URL(`../../../../prisma/sqlite/migrations/${name}/migration.sql`, import.meta.url), 'utf8'));
        }
        const stamp = '2026-11-10T10:00:00.000Z';
        db.prepare('INSERT INTO "PluginWebhookRoute" ("id","opaqueRouteId","verifierKind","routingKind","updatedAt") VALUES (?,?,?,?,?)')
            .run('route', 'opaque', kinds[0]!, 'accountEndpoint', stamp);
        db.prepare('INSERT INTO "PluginWebhookEndpoint" ("id","accountId","routeId","routingKind","updatedAt") VALUES (?,?,?,?,?)')
            .run('endpoint', 'account', 'route', 'accountEndpoint', stamp);
        const columns = db.prepare('PRAGMA table_info("PluginWebhookDelivery")').all() as unknown as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
        const special: Record<string, SQLInputValue> = { id: 'retained', endpointId: 'endpoint', accountId: 'account', routeId: 'route',
            verifierKind: kinds[0]!, state: 'queued', payloadKind: 'plain', payload: '{"private":"retained"}', payloadBytes: 22,
            attemptCount: 2, replayCount: 1, revision: 7, wireVersion: 1, payloadVersion: 1 };
        const names = columns.map(column => `"${column.name}"`).join(',');
        const values = columns.map(column => special[column.name] ?? (column.notnull || column.pk
            ? column.type === 'INTEGER' ? 1 : column.type === 'DATETIME' ? stamp : column.name : null));
        // A queued record has no terminal or active-claim metadata.
        for (const name of ['leaseId', 'claimedByMachineId', 'claimedByMachineInstallationId', 'firstClaimAt', 'executionStartedAt', 'leaseExpiresAt',
            'succeededAt', 'deadLetteredAt', 'discardedAt', 'discardedByUserId', 'discardReasonCode', 'terminalDisposition', 'payloadPurgeAt', 'automationAdmissionUnresolved']) {
            values[columns.findIndex(column => column.name === name)] = null;
        }
        db.prepare(`INSERT INTO "PluginWebhookDelivery" (${names}) VALUES (${values.map(() => '?').join(',')})`).run(...values);
        db.exec(`INSERT INTO "PluginWebhookEndpointOperation" ("id","accountId","endpointId","operationKind","idempotencyKey","expectedRevision","resultKind","resultRevision")
            VALUES ('retained-revoke','account','endpoint','revoke','revoke',1,'revoked',2);
            INSERT INTO "PluginWebhookEndpointOperation" ("id","accountId","endpointId","operationKind","idempotencyKey","expectedRevision","resultKind","resultRevision",
                "requestTargetMachineId","requestTargetMaterializationId","requestTargetPluginId","resultPreviousTargetMachineId","resultPreviousTargetMaterializationId",
                "resultPreviousTargetPluginId","resultTargetMachineId","resultTargetMaterializationId","resultTargetPluginId")
            VALUES ('retained-retarget','account','endpoint','retarget','retarget',2,'retargeted',3,'new-machine','new-install','plugin','old-machine','old-install','plugin','new-machine','new-install','plugin');`);
        const tables = ['PluginWebhookRoute', 'PluginWebhookDelivery', 'PluginWebhookEndpointOperation'];
        const before = tables.map(table => ({ rows: db.prepare(`SELECT * FROM "${table}"`).all(),
            columns: db.prepare(`PRAGMA table_info("${table}")`).all(),
            indexes: db.prepare(`PRAGMA index_list("${table}")`).all().map(row => row.name).sort(),
            keys: db.prepare(`PRAGMA foreign_key_list("${table}")`).all() }));
        db.exec(await migration('sqlite', '20261110114500_webhook_capability_handler_delivery'));
        db.exec(await migration('sqlite', previousMigrationName));
        // Before the forward migration, retained GitHub/GitLab data remains valid while Bitbucket is refused.
        for (const table of ['PluginWebhookRoute', 'PluginWebhookDelivery']) {
            expect(() => db.prepare(`UPDATE "${table}" SET "verifierKind"=?`).run('bitbucket_hmac_sha256_v1')).toThrow();
        }
        db.exec(await migration('sqlite'));
        for (const [index, table] of tables.entries()) {
            expect(db.prepare(`SELECT * FROM "${table}"`).all()).toEqual(before[index]!.rows);
            expect(db.prepare(`PRAGMA table_info("${table}")`).all()).toEqual(before[index]!.columns);
            expect(db.prepare(`PRAGMA index_list("${table}")`).all().map(row => row.name).sort()).toEqual(before[index]!.indexes);
            expect(db.prepare(`PRAGMA foreign_key_list("${table}")`).all()).toEqual(before[index]!.keys);
            if (table !== 'PluginWebhookEndpointOperation') {
                for (const kind of kinds) db.prepare(`UPDATE "${table}" SET "verifierKind"=?`).run(kind);
                expect(() => db.exec(`UPDATE "${table}" SET "verifierKind"='unknown'`)).toThrow();
            }
        }
        db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "operationKind"='rotateUrl',"resultKind"='rotated' WHERE "id"='retained-revoke'`);
        expect(() => db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "operationKind"='unknown' WHERE "id"='retained-revoke'`)).toThrow();
        expect(() => db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "resultKind"='revoked' WHERE "id"='retained-revoke'`)).toThrow();
        expect(() => db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "requestTargetMachineId"='forged' WHERE "id"='retained-revoke'`)).toThrow();
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { db.close(); }
});

it('widens PostgreSQL checks without rewriting retained payloads and keeps the MySQL constraints equivalent', async () => {
    const db = new PGlite();
    try {
        for (const table of ['PluginWebhookRoute', 'PluginWebhookDelivery']) {
            await db.exec(`CREATE TABLE "${table}" ("id" TEXT PRIMARY KEY, "verifierKind" TEXT NOT NULL,
                "payload" TEXT, CONSTRAINT "${table}_verifier_kind_check" CHECK ("verifierKind"='github_hmac_sha256_v1'));
                INSERT INTO "${table}" VALUES ('retained','github_hmac_sha256_v1','opaque-existing-content');`);
        }
        await db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY); INSERT INTO "Account" VALUES (\'account\'); CREATE TABLE "PluginWebhookEndpoint" ("id" TEXT PRIMARY KEY); INSERT INTO "PluginWebhookEndpoint" VALUES (\'endpoint\');');
        const original = await readFile(new URL('../../../../prisma/migrations/20260810130000_add_plugin_webhook_ingress_v1/migration.sql', import.meta.url), 'utf8');
        const operationTable = original.match(/CREATE TABLE "PluginWebhookEndpointOperation" \([\s\S]+?\n\);/u)?.[0];
        if (!operationTable) throw new Error('Released endpoint operation DDL is missing');
        await db.exec(operationTable);
        await db.exec(`INSERT INTO "PluginWebhookEndpointOperation" ("id","accountId","endpointId","operationKind","idempotencyKey","expectedRevision","resultKind","resultRevision")
            VALUES ('retained','account','endpoint','revoke','request',1,'revoked',2);`);
        const retainedOperation = (await db.query('SELECT * FROM "PluginWebhookEndpointOperation"')).rows;
        await db.exec(await migration('postgres', '20261110114500_webhook_capability_handler_delivery'));
        await db.exec(await migration('postgres', previousMigrationName));
        for (const table of ['PluginWebhookRoute', 'PluginWebhookDelivery']) {
            await expect(db.exec(`UPDATE "${table}" SET "verifierKind"='bitbucket_hmac_sha256_v1'`)).rejects.toThrow();
        }
        await db.exec(await migration('postgres'));
        expect((await db.query('SELECT * FROM "PluginWebhookEndpointOperation"')).rows).toEqual(retainedOperation);
        await db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "operationKind"='rotateUrl',"resultKind"='rotated'`);
        await expect(db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "operationKind"='unknown'`)).rejects.toThrow();
        await expect(db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "resultKind"='revoked'`)).rejects.toThrow();
        await expect(db.exec(`UPDATE "PluginWebhookEndpointOperation" SET "requestTargetMachineId"='forged'`)).rejects.toThrow();
        for (const table of ['PluginWebhookRoute', 'PluginWebhookDelivery']) {
            expect((await db.query(`SELECT "payload" FROM "${table}"`)).rows).toEqual([{ payload: 'opaque-existing-content' }]);
            for (const kind of kinds) await db.query(`UPDATE "${table}" SET "verifierKind"=$1`, [kind]);
            await expect(db.exec(`UPDATE "${table}" SET "verifierKind"='unknown'`)).rejects.toThrow();
        }
        const mysql = await migration('mysql');
        expect([...mysql.matchAll(/CHECK \(`verifierKind` IN \(([^)]+)\)\)/gu)].map(match => match[1]!.match(/'([^']+)'/gu)?.map(value => value.slice(1, -1))))
            .toEqual([kinds, kinds]);
        const capabilityMysql = await migration('mysql', '20261110114500_webhook_capability_handler_delivery');
        expect(capabilityMysql).toContain("`operationKind` IN ('revoke', 'retarget', 'rotateUrl')");
        expect(capabilityMysql).toContain("`resultKind` IN ('revoked', 'alreadyRevoked', 'retargeted', 'alreadyRetargeted', 'rotated')");
        expect(capabilityMysql).toContain("`operationKind` = 'rotateUrl'");
    } finally { await db.close(); }
});
