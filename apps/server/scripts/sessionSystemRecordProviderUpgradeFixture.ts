import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    hasSessionSystemRecordContractMigration,
} from "../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution";
import { deriveSessionSystemRecordAddressKeys } from "../sources/app/session/systemRecords/sessionSystemRecordAddressKeys";
import { initializeSessionSystemRecordsProtocolV1Activation } from "../sources/app/session/systemRecords/sessionSystemRecordProtocolContract";
import { createDbMaintenanceClient, type PrismaClientType } from "../sources/storage/db";
import { resolveServerWorkspaceRoot } from "./prismaCli";
import { runPrismaMigrateCli } from "./prismaMigrateCli";
import { SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE } from "./sessionSystemRecordPreviewProvenance";

type Provider = "postgres" | "mysql";
type Operation = "seed" | "verify";

const FIXTURE = {
    accountId: "ssr-preview-upgrade-owner",
    sessionId: "ssr-preview-upgrade-session",
    cipher: "AP8AgP8A-preview-session-system-record-v1",
    records: [
        {
            id: "ssr-preview-upgrade-nfc",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "Résumé",
        },
        {
            id: "ssr-preview-upgrade-nfd",
            namespace: "memory",
            kind: "synopsis.v1",
            localId: "Re\u0301sume\u0301",
        },
    ],
} as const;

function requireProvider(env: NodeJS.ProcessEnv): Provider {
    const value = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? "")
        .trim()
        .toLowerCase();
    if (value === "postgres" || value === "postgresql") return "postgres";
    if (value === "mysql") return "mysql";
    throw new Error(`Session System Record upgrade fixture requires postgres|mysql; received ${value || "unset"}`);
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
    const value = String(env.DATABASE_URL ?? "").trim();
    if (!value) throw new Error("Session System Record upgrade fixture requires DATABASE_URL");
    return value;
}

function requireOperation(argv: readonly string[]): Operation {
    const value = String(argv[0] ?? "").trim();
    if (value === "seed" || value === "verify") return value;
    throw new Error(`Session System Record upgrade fixture requires seed|verify; received ${value || "unset"}`);
}

function providerPrismaRoot(serverRoot: string, provider: Provider): string {
    return provider === "postgres"
        ? join(serverRoot, "prisma")
        : join(serverRoot, "prisma", "mysql");
}

async function migrationDirectoryNames(migrationsDir: string): Promise<string[]> {
    return (await readdir(migrationsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

async function digestMigrationSql(migrationsDir: string, names: readonly string[]): Promise<string> {
    const hash = createHash("sha256");
    for (const name of names) {
        hash.update(name);
        hash.update("\0");
        hash.update(await readFile(join(migrationsDir, name, "migration.sql")));
        hash.update("\0");
    }
    return hash.digest("hex");
}

async function inspectSessionSystemRecordPreviewSource(params: Readonly<{
    provider: Provider;
    serverRoot: string;
}>): Promise<Readonly<{
    migrationNames: readonly string[];
    migrationDigest: string;
    schemaBytes: Buffer;
    schemaDigest: string;
    schemaFixturePath: string;
}>> {
    const sourcePrismaRoot = providerPrismaRoot(params.serverRoot, params.provider);
    const sourceMigrationsDir = join(sourcePrismaRoot, "migrations");
    const provenance = SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE.providers[params.provider];
    const migrationNames = [...provenance.migrationNames];
    const availableNames = new Set(await migrationDirectoryNames(sourceMigrationsDir));
    const missingNames = migrationNames.filter((name) => !availableNames.has(name));
    assert.deepEqual(
        missingNames,
        [],
        `Current source is missing migrations from ${SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE.release} `
        + `(${SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE.commit})`,
    );
    const migrationDigest = await digestMigrationSql(sourceMigrationsDir, migrationNames);
    assert.equal(
        migrationDigest,
        provenance.migrationAggregateSha256,
        `The ${params.provider} preview migration bytes drifted from `
        + `${SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE.release} (${SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE.commit})`,
    );
    const schemaFixturePath = join(
        params.serverRoot,
        "scripts",
        "fixtures",
        "session-system-record-preview",
        provenance.schemaFixtureFile,
    );
    const schemaBytes = await readFile(schemaFixturePath);
    const schemaDigest = createHash("sha256").update(schemaBytes).digest("hex");
    assert.equal(
        schemaDigest,
        provenance.schemaSha256,
        `The ${params.provider} preview schema fixture drifted from `
        + `${SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE.release} (${SESSION_SYSTEM_RECORD_PREVIEW_PROVENANCE.commit})`,
    );
    return {
        migrationNames,
        migrationDigest,
        schemaBytes,
        schemaDigest,
        schemaFixturePath,
    };
}

export async function stageReleasedPreviewMigrations(params: Readonly<{
    provider: Provider;
    serverRoot: string;
}>): Promise<Readonly<{ stageDir: string; schemaPath: string }>> {
    const sourcePrismaRoot = providerPrismaRoot(params.serverRoot, params.provider);
    const sourceMigrationsDir = join(sourcePrismaRoot, "migrations");
    const inspected = await inspectSessionSystemRecordPreviewSource(params);
    const names = inspected.migrationNames;

    const stageDir = await mkdtemp(join(tmpdir(), `happier-ssr-preview-${params.provider}-`));
    const stagedMigrationsDir = join(stageDir, "migrations");
    await mkdir(stagedMigrationsDir, { recursive: true });
    await copyFile(inspected.schemaFixturePath, join(stageDir, "schema.prisma"));
    await copyFile(
        join(sourceMigrationsDir, "migration_lock.toml"),
        join(stagedMigrationsDir, "migration_lock.toml"),
    );
    for (const name of names) {
        await cp(join(sourceMigrationsDir, name), join(stagedMigrationsDir, name), { recursive: true });
    }
    return { stageDir, schemaPath: join(stageDir, "schema.prisma") };
}

function numeric(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Expected numeric database value; received ${String(value)}`);
    return parsed;
}

async function assertEmptyFixtureDatabase(database: PrismaClientType, provider: Provider): Promise<void> {
    const rows = provider === "postgres"
        ? await database.$queryRawUnsafe<Array<{ tableCount: bigint | number }>>(
            `SELECT COUNT(*) AS "tableCount" FROM information_schema.tables WHERE table_schema = current_schema()`,
        )
        : await database.$queryRawUnsafe<Array<{ tableCount: bigint | number }>>(
            `SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE()`,
        );
    assert.equal(numeric(rows[0]?.tableCount), 0, "The provider-upgrade fixture requires a disposable empty database");
}

async function seedRows(database: PrismaClientType, provider: Provider): Promise<void> {
    if (provider === "postgres") {
        await database.$executeRawUnsafe(
            `INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
            FIXTURE.accountId,
            "ssr-preview-upgrade-public-key",
        );
        await database.$executeRawUnsafe(
            `INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
            FIXTURE.sessionId,
            FIXTURE.sessionId,
            FIXTURE.accountId,
            "{}",
        );
        for (const record of FIXTURE.records) {
            await database.$executeRawUnsafe(
                `INSERT INTO "SessionSystemRecord"
                    ("id", "accountId", "sessionId", "namespace", "kind", "localId", "content", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)`,
                record.id,
                FIXTURE.accountId,
                FIXTURE.sessionId,
                record.namespace,
                record.kind,
                record.localId,
                JSON.stringify({ t: "encrypted", c: `${FIXTURE.cipher}:${record.id}` }),
            );
        }
        return;
    }

    await database.$executeRawUnsafe(
        "INSERT INTO `Account` (`id`, `publicKey`, `updatedAt`) VALUES (?, ?, CURRENT_TIMESTAMP(3))",
        FIXTURE.accountId,
        "ssr-preview-upgrade-public-key",
    );
    await database.$executeRawUnsafe(
        `INSERT INTO \`Session\` (\`id\`, \`tag\`, \`accountId\`, \`metadata\`, \`updatedAt\`)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
        FIXTURE.sessionId,
        FIXTURE.sessionId,
        FIXTURE.accountId,
        "{}",
    );
    for (const record of FIXTURE.records) {
        await database.$executeRawUnsafe(
            `INSERT INTO \`SessionSystemRecord\`
                (\`id\`, \`accountId\`, \`sessionId\`, \`namespace\`, \`kind\`, \`localId\`, \`content\`, \`updatedAt\`)
             VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CURRENT_TIMESTAMP(3))`,
            record.id,
            FIXTURE.accountId,
            FIXTURE.sessionId,
            record.namespace,
            record.kind,
            record.localId,
            JSON.stringify({ t: "encrypted", c: `${FIXTURE.cipher}:${record.id}` }),
        );
    }
}

async function seed(params: Readonly<{ provider: Provider; databaseUrl: string; serverRoot: string }>): Promise<void> {
    const database = await createDbMaintenanceClient(params.provider, params.databaseUrl);
    const staged = await stageReleasedPreviewMigrations(params);
    try {
        await database.$connect();
        await assertEmptyFixtureDatabase(database, params.provider);
        await database.$disconnect();
        await runPrismaMigrateCli({
            serverRoot: params.serverRoot,
            schemaPath: staged.schemaPath, args: ['deploy'],
            env: {
                ...process.env,
                DATABASE_URL: params.databaseUrl,
                HAPPIER_DB_PROVIDER: params.provider,
            },
        });
        await database.$connect();
        assert.equal(
            await hasSessionSystemRecordContractMigration({
                provider: params.provider,
                databaseUrl: params.databaseUrl,
            }),
            false,
            "The released preview fixture must remain before the Session System Record CONTRACT migration",
        );
        assert.equal(
            await initializeSessionSystemRecordsProtocolV1Activation(database),
            false,
            "Protocol v1 must remain unavailable before the Session System Record CONTRACT migration",
        );
        await seedRows(database, params.provider);
    } finally {
        await database.$disconnect().catch(() => undefined);
        await rm(staged.stageDir, { recursive: true, force: true });
    }
}

async function verifyMigrationLedger(params: Readonly<{
    database: PrismaClientType;
    provider: Provider;
    serverRoot: string;
}>): Promise<void> {
    const migrationsDir = join(providerPrismaRoot(params.serverRoot, params.provider), "migrations");
    const names = await migrationDirectoryNames(migrationsDir);
    const rows = await params.database.$queryRawUnsafe<Array<{
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
    }>>(
        `SELECT migration_name, checksum, finished_at, rolled_back_at
         FROM _prisma_migrations ORDER BY migration_name, started_at`,
    );
    const active = rows.filter((row) => row.finished_at !== null && row.rolled_back_at === null);
    assert.equal(active.length, names.length, "Every canonical provider migration must have one active ledger row");
    assert.deepEqual(active.map((row) => row.migration_name), names);
    for (const row of active) {
        const expected = createHash("sha256")
            .update(await readFile(join(migrationsDir, row.migration_name, "migration.sql")))
            .digest("hex");
        assert.equal(row.checksum, expected, `Migration checksum mismatch: ${row.migration_name}`);
    }
}

async function verifyRows(database: PrismaClientType, provider: Provider): Promise<void> {
    const rows = provider === "postgres"
        ? await database.$queryRawUnsafe<Array<{
            id: string;
            ownerKind: string;
            pluginId: string | null;
            namespace: string;
            kind: string;
            localId: string;
            cipher: string;
            version: number;
        }>>(
            `SELECT "id", "ownerKind", "pluginId", "namespace", "kind", "localId",
                    "content" #>> '{c}' AS cipher, "version"
             FROM "SessionSystemRecord"
             WHERE "sessionId" = $1 ORDER BY "id"`,
            FIXTURE.sessionId,
        )
        : await database.$queryRawUnsafe<Array<{
            id: string;
            ownerKind: string;
            pluginId: string | null;
            namespace: string;
            kind: string;
            localId: string;
            cipher: string;
            version: number;
        }>>(
            `SELECT \`id\`, \`ownerKind\`, \`pluginId\`, \`namespace\`, \`kind\`, \`localId\`,
                    JSON_UNQUOTE(JSON_EXTRACT(\`content\`, '$.c')) AS cipher, \`version\`
             FROM \`SessionSystemRecord\`
             WHERE \`sessionId\` = ? ORDER BY \`id\``,
            FIXTURE.sessionId,
        );
    assert.equal(rows.length, FIXTURE.records.length);

    for (const record of FIXTURE.records) {
        const actual = rows.find((row) => row.id === record.id);
        assert.deepEqual(actual, {
            ...record,
            ownerKind: "host",
            pluginId: null,
            cipher: `${FIXTURE.cipher}:${record.id}`,
            version: 1,
        });
        const keys = deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace: record.namespace,
            localId: record.localId,
        });
        const byKey = provider === "postgres"
            ? await database.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT "id" FROM "SessionSystemRecord"
                 WHERE "accountId" = $1 AND "sessionId" = $2 AND "recordAddressKey" = $3`,
                FIXTURE.accountId,
                FIXTURE.sessionId,
                Buffer.from(keys.recordAddressKey),
            )
            : await database.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT \`id\` FROM \`SessionSystemRecord\`
                 WHERE \`accountId\` = ? AND \`sessionId\` = ? AND \`recordAddressKey\` = ?`,
                FIXTURE.accountId,
                FIXTURE.sessionId,
                Buffer.from(keys.recordAddressKey),
            );
        assert.deepEqual(byKey, [{ id: record.id }], `Canonical lookup failed for ${record.id}`);
    }
    assert.notEqual(rows[0]?.localId, rows[1]?.localId, "Unicode-distinct legacy identities must remain distinct");
}

async function verifyProviderIntegrity(database: PrismaClientType, provider: Provider): Promise<void> {
    if (provider === "postgres") {
        const invalidForeignKeys = await database.$queryRawUnsafe<Array<{ count: bigint | number }>>(
            `SELECT COUNT(*) AS count FROM pg_constraint WHERE contype = 'f' AND NOT convalidated`,
        );
        assert.equal(numeric(invalidForeignKeys[0]?.count), 0, "PostgreSQL has unvalidated foreign keys");
        const systemRecordForeignKeys = await database.$queryRawUnsafe<Array<{ conname: string }>>(
            `SELECT conname FROM pg_constraint
             WHERE contype = 'f' AND conrelid = '"SessionSystemRecord"'::regclass ORDER BY conname`,
        );
        assert.deepEqual(systemRecordForeignKeys.map((row) => row.conname), [
            "SessionSystemRecord_accountId_fkey",
            "SessionSystemRecord_sessionId_fkey",
        ]);
        const orphans = await database.$queryRawUnsafe<Array<{ count: bigint | number }>>(
            `SELECT COUNT(*) AS count FROM "SessionSystemRecord" r
             LEFT JOIN "Account" a ON a."id" = r."accountId"
             LEFT JOIN "Session" s ON s."id" = r."sessionId"
             WHERE a."id" IS NULL OR s."id" IS NULL`,
        );
        assert.equal(numeric(orphans[0]?.count), 0);
        return;
    }

    const check = await database.$queryRawUnsafe<Array<{
        Msg_type: string;
        Msg_text: string;
    }>>("CHECK TABLE `SessionSystemRecord`");
    assert(check.some((row) => row.Msg_type.toLowerCase() === "status" && row.Msg_text.toLowerCase() === "ok"));
    const systemRecordForeignKeys = await database.$queryRawUnsafe<Array<{ constraintName: string }>>(
        `SELECT CONSTRAINT_NAME AS constraintName
         FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'SessionSystemRecord'
         ORDER BY CONSTRAINT_NAME`,
    );
    assert.deepEqual(systemRecordForeignKeys.map((row) => row.constraintName), [
        "SessionSystemRecord_accountId_fkey",
        "SessionSystemRecord_sessionId_fkey",
    ]);
    const orphans = await database.$queryRawUnsafe<Array<{ count: bigint | number }>>(
        `SELECT COUNT(*) AS count FROM \`SessionSystemRecord\` r
         LEFT JOIN \`Account\` a ON a.\`id\` = r.\`accountId\`
         LEFT JOIN \`Session\` s ON s.\`id\` = r.\`sessionId\`
         WHERE a.\`id\` IS NULL OR s.\`id\` IS NULL`,
    );
    assert.equal(numeric(orphans[0]?.count), 0);
}

async function verify(params: Readonly<{ provider: Provider; databaseUrl: string; serverRoot: string }>): Promise<void> {
    assert.equal(
        await hasSessionSystemRecordContractMigration({
            provider: params.provider,
            databaseUrl: params.databaseUrl,
        }),
        true,
        "The canonical Session System Record CONTRACT migration must be active after both deploys",
    );
    const database = await createDbMaintenanceClient(params.provider, params.databaseUrl);
    try {
        await database.$connect();
        await verifyMigrationLedger({ database, provider: params.provider, serverRoot: params.serverRoot });
        await verifyRows(database, params.provider);
        await verifyProviderIntegrity(database, params.provider);
        assert.equal(
            await initializeSessionSystemRecordsProtocolV1Activation(database),
            true,
            "Protocol v1 must activate only after CONTRACT and the current address audit succeed",
        );
    } finally {
        await database.$disconnect();
    }
}

export async function runSessionSystemRecordProviderUpgradeFixture(params: Readonly<{
    operation: Operation;
    provider: Provider;
    databaseUrl: string;
    serverRoot: string;
}>): Promise<void> {
    if (params.operation === "seed") {
        await seed(params);
        return;
    }
    await verify(params);
}

async function main(): Promise<void> {
    await runSessionSystemRecordProviderUpgradeFixture({
        operation: requireOperation(process.argv.slice(2)),
        provider: requireProvider(process.env),
        databaseUrl: requireDatabaseUrl(process.env),
        serverRoot: resolveServerWorkspaceRoot(import.meta.url),
    });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
    void main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exit(1);
    });
}
