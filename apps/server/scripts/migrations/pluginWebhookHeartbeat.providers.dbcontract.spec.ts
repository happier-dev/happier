import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { applyPostgresMigrations, applySqliteMigrations } from '../prismaMigrations';
import { runPrismaCli } from '../prismaCli';
import { readPostgresSemanticSchema } from './postgresSchema.testkit';

const serverRoot = join(import.meta.dirname, '../..');
const heartbeatMigration = '20261031131500_plugin_webhook_heartbeat_ingress';
const originalMigration = '20260810130000_add_plugin_webhook_ingress_v1';
// Committed predecessor bytes, also present in the retained development ledger.
const originalChecksums = {
    postgres: '507526e49dac0147964d49857bcb2c2af6d9ba6d122e6f8102359693032ff4e6',
    sqlite: '5ba431c95a370b3729cf5dfbb7aa06f62b703119af8d56bca370ede366c4ca54',
};
type Provider = keyof typeof originalChecksums;
interface Database {
    execute(sql: string): Promise<unknown>;
    query(sql: string): Promise<Record<string, unknown>[]>;
}

async function stageMigrations(provider: Provider, stage: string, current: boolean) {
    const root = join(serverRoot, 'prisma', ...(provider === 'sqlite' ? ['sqlite'] : []));
    await mkdir(join(stage, 'migrations'), { recursive: true });
    await copyFile(join(root, 'schema.prisma'), join(stage, 'schema.prisma'));
    await copyFile(join(root, 'migrations/migration_lock.toml'), join(stage, 'migrations/migration_lock.toml'));
    for (const entry of await readdir(join(root, 'migrations'), { withFileTypes: true })) {
        if (entry.isDirectory() && (current || entry.name <= originalMigration)) {
            await cp(join(root, 'migrations', entry.name), join(stage, 'migrations', entry.name), { recursive: true });
        }
    }
}

async function proveUpgrade(provider: Provider, stage: string, db: Database, deploy: () => Promise<unknown>, verifyAppliedChecksums: () => Promise<unknown>) {
    await stageMigrations(provider, stage, false);
    await deploy();
    const ledgerSql = 'SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name';
    const oldLedger = await db.query(ledgerSql);
    expect(oldLedger.find(row => row.migration_name === originalMigration)?.checksum).toBe(originalChecksums[provider]);

    await db.execute(`INSERT INTO "Account" ("id","publicKey","updatedAt") VALUES ('webhook-owner','webhook-owner',CURRENT_TIMESTAMP)`);
    await db.execute(`INSERT INTO "PluginWebhookRoute" ("id","opaqueRouteId","verifierKind","routingKind","updatedAt") VALUES ('old-route','old-opaque','github_hmac_sha256_v1','accountEndpoint',CURRENT_TIMESTAMP)`);
    await db.execute(`INSERT INTO "PluginWebhookEndpoint" ("id","accountId","pluginId","webhookContributionId","handlerActionId","sourceInstanceId","ensureIdempotencyKey","ensureRequestFingerprint","setupKind","routeId","routingKind","targetMachineId","targetMachineInstallationId","targetMaterializationId","targetPluginVersion","updatedAt") VALUES ('old-endpoint','webhook-owner','machine-services','heartbeat','handle','source','old-ensure','${'a'.repeat(64)}','manual','old-route','accountEndpoint','machine','installation','materialization','1',CURRENT_TIMESTAMP)`);
    const bytes = provider === 'postgres' ? "decode('010203','hex')" : "X'010203'";
    await db.execute(`INSERT INTO "PluginWebhookCredential" ("id","routeId","credentialVersionId","verifierKind","encryptedSecret","state","updatedAt") VALUES ('old-credential','old-route','old-version','github_hmac_sha256_v1',${bytes},'current',CURRENT_TIMESTAMP)`);
    await db.execute(`UPDATE "PluginWebhookRoute" SET "accountEndpointId"='old-endpoint',"currentCredentialId"='old-credential' WHERE "id"='old-route'`);
    await db.execute(`INSERT INTO "PluginWebhookEndpointOperation" ("id","accountId","endpointId","operationKind","idempotencyKey","expectedRevision","resultKind","resultRevision") VALUES ('old-operation','webhook-owner','old-endpoint','revoke','old-revoke',1,'revoked',1)`);
    await db.execute(`INSERT INTO "PluginWebhookDelivery" ("id","endpointId","accountId","routeId","deliveryIdentityDigest","verifierKind","targetMachineId","targetMachineInstallationId","targetMaterializationId","targetPluginId","targetPluginVersion","endpointRevision","endpointWebhookContributionId","endpointHandlerActionId","endpointSourceInstanceId","payloadKind","wireVersion","payloadVersion","state","nextAttemptAt","metadataDeleteAt","receivedAt","updatedAt") VALUES ('old-delivery','old-endpoint','webhook-owner','old-route','${'b'.repeat(64)}','github_hmac_sha256_v1','machine','installation','materialization','machine-services','1',1,'heartbeat','handle','source','plain',1,1,'succeeded',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    const tables = ['PluginWebhookRoute', 'PluginWebhookEndpoint', 'PluginWebhookCredential', 'PluginWebhookDelivery', 'PluginWebhookEndpointOperation'];
    const before = new Map<string, Record<string, unknown>[]>();
    for (const table of tables) before.set(table, await db.query(`SELECT * FROM "${table}" ORDER BY "id"`));

    // Edit only this test's disposable copy of an already-applied migration.
    // Exercise the existing checksum owner, not a test-owned checksum guard.
    const oldSqlPath = join(stage, 'migrations', originalMigration, 'migration.sql');
    const oldSql = await readFile(oldSqlPath, 'utf8');
    await writeFile(oldSqlPath, `${oldSql}\n-- applied migration drift regression control\n`);
    try {
        await expect(verifyAppliedChecksums()).rejects.toThrow(/checksum mismatch.*20260810130000_add_plugin_webhook_ingress_v1/i);
        expect(await db.query(ledgerSql)).toEqual(oldLedger);
        for (const table of tables) expect(await db.query(`SELECT * FROM "${table}" ORDER BY "id"`)).toEqual(before.get(table));
    } finally {
        await writeFile(oldSqlPath, oldSql);
    }

    await stageMigrations(provider, stage, true);
    await deploy();
    const currentLedger = await db.query(ledgerSql);
    const oldNames = new Set(oldLedger.map(row => row.migration_name));
    expect(currentLedger.filter(row => oldNames.has(row.migration_name))).toEqual(oldLedger);
    // This read must fail on the original canonical schema, not on a mock or SQL-text assertion.
    expect(await db.query(`SELECT "checkId","lastAcceptedAt" FROM "PluginWebhookEndpoint" WHERE "id"='old-endpoint'`)).toEqual([{ checkId: '', lastAcceptedAt: null }]);
    expect(currentLedger.some(row => row.migration_name === heartbeatMigration)).toBe(true);
    const currentSelects = new Map<string, string>();
    for (const table of tables) {
        const oldColumns = Object.keys(before.get(table)![0]!);
        const columns = table === 'PluginWebhookEndpoint' ? [...oldColumns, 'checkId', 'lastAcceptedAt'] : oldColumns;
        // An explicit projection does not reuse a PostgreSQL prepared SELECT *
        // whose result type changed when the external deploy added columns.
        const select = `SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${table}" ORDER BY "id"`;
        currentSelects.set(table, select);
        const rows = await db.query(select);
        const preserved = rows.map(row => Object.fromEntries(oldColumns.map(column => [column, row[column]])));
        expect(preserved).toEqual(before.get(table));
    }

    await expect(db.execute(`UPDATE "PluginWebhookRoute" SET "accountEndpointId"='missing-endpoint' WHERE "id"='old-route'`)).rejects.toThrow();
    await expect(db.execute(`UPDATE "PluginWebhookRoute" SET "currentCredentialId"='missing-credential' WHERE "id"='old-route'`)).rejects.toThrow();

    await db.execute(`INSERT INTO "PluginWebhookRoute" ("id","opaqueRouteId","verifierKind","routingKind","updatedAt") VALUES ('heartbeat-route','heartbeat-opaque','capabilityUrl_v1','accountEndpoint',CURRENT_TIMESTAMP)`);
    await expect(db.execute(`INSERT INTO "PluginWebhookRoute" ("id","opaqueRouteId","verifierKind","routingKind","updatedAt") VALUES ('invalid-route','invalid-opaque','unknown-verifier','accountEndpoint',CURRENT_TIMESTAMP)`)).rejects.toThrow();
    const insertEndpoint = (id: string, checkId?: string) => db.execute(`INSERT INTO "PluginWebhookEndpoint" ("id","accountId","pluginId","webhookContributionId","sourceInstanceId","routeId","routingKind","updatedAt"${checkId === undefined ? '' : ',"checkId"'}) VALUES ('${id}','webhook-owner','machine-services','heartbeat','source','heartbeat-route','accountEndpoint',CURRENT_TIMESTAMP${checkId === undefined ? '' : `,'${checkId}'`})`);
    await insertEndpoint('heartbeat-a', 'check-a');
    await insertEndpoint('heartbeat-b', 'check-b');
    await expect(insertEndpoint('duplicate-check', 'check-a')).rejects.toThrow();
    await expect(insertEndpoint('duplicate-ordinary')).rejects.toThrow();
    expect(await db.query(`SELECT "id","checkId","lastAcceptedAt" FROM "PluginWebhookEndpoint" ORDER BY "id"`)).toEqual([
        { id: 'heartbeat-a', checkId: 'check-a', lastAcceptedAt: null },
        { id: 'heartbeat-b', checkId: 'check-b', lastAcceptedAt: null },
        { id: 'old-endpoint', checkId: '', lastAcceptedAt: null },
    ]);
    const replayRows = new Map<string, Record<string, unknown>[]>();
    for (const table of tables) replayRows.set(table, await db.query(currentSelects.get(table)!));
    await deploy();
    expect(await db.query(ledgerSql)).toEqual(currentLedger);
    for (const table of tables) expect(await db.query(currentSelects.get(table)!)).toEqual(replayRows.get(table));
}

describe('Plugin webhook heartbeat additive upgrade', () => {
    it('rejects applied-byte drift and upgrades the committed August ledger on real SQLite without losing referenced records', async () => {
        const stage = await mkdtemp(join(tmpdir(), 'happier-webhook-heartbeat-sqlite-'));
        const path = join(stage, 'contract.sqlite');
        const sqlite = new DatabaseSync(path);
        sqlite.exec('PRAGMA foreign_keys=ON');
        const db: Database = { execute: async sql => sqlite.exec(sql), query: async sql => sqlite.prepare(sql).all() };
        try {
            const deploy = () => applySqliteMigrations({ databasePath: path, migrationsDir: join(stage, 'migrations') });
            await proveUpgrade('sqlite', stage, db, deploy, deploy);
            expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
            expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        } finally {
            sqlite.close();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);

    const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
    (databaseUrl ? it : it.skip)('rejects applied-byte drift at the SQL migration owner and upgrades the committed August ledger on real PostgreSQL', async () => {
        const stage = await mkdtemp(join(tmpdir(), 'happier-webhook-heartbeat-postgres-'));
        const schema = `webhook_heartbeat_${randomUUID().replaceAll('-', '')}`;
        const admin = new PrismaClient({ datasourceUrl: databaseUrl });
        const scoped = new URL(databaseUrl!);
        scoped.searchParams.set('schema', schema);
        const client = new PrismaClient({ datasourceUrl: scoped.toString() });
        const db: Database = { execute: sql => client.$executeRawUnsafe(sql), query: sql => client.$queryRawUnsafe<Record<string, unknown>[]>(sql) };
        let created = false;
        try {
            await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
            created = true;
            await proveUpgrade('postgres', stage, db,
                () => runPrismaCli({ serverRoot, args: ['migrate', 'deploy', '--schema', join(stage, 'schema.prisma')], env: { ...process.env, DATABASE_URL: scoped.toString(), HAPPIER_DB_PROVIDER: 'postgres' }, quiet: true }),
                // This is the light/embedded SQL migration owner, exercised against
                // real PostgreSQL. Full-server Prisma CLI checksum policy is separate.
                () => applyPostgresMigrations({ migrationsDir: join(stage, 'migrations'), db: {
                    exec: sql => client.$executeRawUnsafe(sql),
                    query: async sql => ({ rows: await client.$queryRawUnsafe<Record<string, unknown>[]>(sql) }),
                } }));
            const fresh = new PrismaClient({ datasourceUrl: databaseUrl });
            try {
                const canonical = await readPostgresSemanticSchema({ query: sql => fresh.$queryRawUnsafe<Record<string, unknown>[]>(sql) });
                expect(await readPostgresSemanticSchema(db)).toEqual(canonical);
            } finally {
                await fresh.$disconnect();
            }
        } finally {
            await client.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
            await admin.$disconnect();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);
});
