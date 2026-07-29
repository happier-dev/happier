import assert from "node:assert/strict";
import { cp, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import {
    backfillVoiceProviderConversationIdentityBatch,
    countVoiceProviderConversationIdentityBackfillRemaining,
} from "../sources/app/api/routes/voice/voiceProviderConversationIdentityBackfill";
import { deriveVoiceProviderConversationKey } from "../sources/app/api/routes/voice/voiceProviderConversationIdentity";
import { db, initDbMysql } from "../sources/storage/db";

import { resolveServerWorkspaceRoot, runPrismaCli } from "./prismaCli";

export const MYSQL_VOICE_IDENTITY_TARGET_MIGRATION = "20260710170000_add_voice_provider_conversation_keys";

export interface MysqlVoiceIdentityMigrationSequence {
    readonly preTarget: readonly string[];
    readonly target: string;
    readonly remaining: readonly string[];
}

export function resolveMysqlVoiceIdentityMigrationSequence(params: Readonly<{
    migrationNames: readonly string[];
    targetMigration: string;
}>): MysqlVoiceIdentityMigrationSequence {
    const ordered = [...params.migrationNames].sort();
    const targetIndexes = ordered
        .map((name, index) => name === params.targetMigration ? index : -1)
        .filter((index) => index >= 0);
    if (targetIndexes.length !== 1) {
        throw new Error(`Expected MySQL voice identity target migration exactly once; found ${targetIndexes.length}`);
    }
    const targetIndex = targetIndexes[0];
    return {
        preTarget: ordered.slice(0, targetIndex),
        target: ordered[targetIndex],
        remaining: ordered.slice(targetIndex + 1),
    };
}

async function copyMigrationAsset(params: Readonly<{
    sourceMigrationsDir: string;
    stagedMigrationsDir: string;
    migrationName: string;
}>): Promise<void> {
    await cp(
        join(params.sourceMigrationsDir, params.migrationName),
        join(params.stagedMigrationsDir, params.migrationName),
        { recursive: true, force: false },
    );
}

async function stagePreTargetMigrations(params: Readonly<{
    sourcePrismaDir: string;
    stageDir: string;
    sequence: MysqlVoiceIdentityMigrationSequence;
}>): Promise<string> {
    const stagedMigrationsDir = join(params.stageDir, "migrations");
    await mkdir(stagedMigrationsDir, { recursive: true });
    await copyFile(join(params.sourcePrismaDir, "schema.prisma"), join(params.stageDir, "schema.prisma"));
    await copyFile(
        join(params.sourcePrismaDir, "migrations", "migration_lock.toml"),
        join(stagedMigrationsDir, "migration_lock.toml"),
    );
    for (const migrationName of params.sequence.preTarget) {
        await copyMigrationAsset({
            sourceMigrationsDir: join(params.sourcePrismaDir, "migrations"),
            stagedMigrationsDir,
            migrationName,
        });
    }
    return stagedMigrationsDir;
}

async function deployStagedMigrations(params: Readonly<{
    serverRoot: string;
    stageDir: string;
    databaseUrl: string;
}>): Promise<void> {
    await runPrismaCli({
        serverRoot: params.serverRoot,
        args: ["migrate", "deploy", "--schema", join(params.stageDir, "schema.prisma")],
        env: { ...process.env, DATABASE_URL: params.databaseUrl },
    });
}

interface LegacyVoiceIdentityFixture {
    readonly accountId: string;
    readonly conversationId: string;
    readonly boundLeaseId: string;
    readonly nullLeaseId: string;
    readonly providerOnlyLeaseId: string;
    readonly conversationOnlyLeaseId: string;
    readonly providerId: string;
    readonly providerConversationId: string;
    readonly sessionId: string;
}

async function seedLegacyVoiceIdentityFixture(label: string): Promise<LegacyVoiceIdentityFixture> {
    const suffix = randomUUID();
    const fixture: LegacyVoiceIdentityFixture = {
        accountId: `mysql-upgrade-account-${suffix}`,
        conversationId: `mysql-upgrade-conversation-${suffix}`,
        boundLeaseId: `mysql-upgrade-bound-${suffix}`,
        nullLeaseId: `mysql-upgrade-null-${suffix}`,
        providerOnlyLeaseId: `mysql-upgrade-provider-only-${suffix}`,
        conversationOnlyLeaseId: `mysql-upgrade-conversation-only-${suffix}`,
        providerId: `mysql-upgrade-${label}-é`,
        // The predecessor columns are VARCHAR(191). Widening belongs to the
        // later contract release after this writer is unreachable.
        providerConversationId: ` ${"界".repeat(189)} `,
        sessionId: "🙂".repeat(191),
    };
    assert.equal([...fixture.providerConversationId].length, 191);
    assert.equal([...fixture.sessionId].length, 191);

    await db.$executeRawUnsafe(
        "INSERT INTO `Account` (`id`, `publicKey`, `updatedAt`) VALUES (?, ?, CURRENT_TIMESTAMP(3))",
        fixture.accountId,
        `mysql-upgrade-key-${suffix}`,
    );
    await db.$executeRawUnsafe(
        `INSERT INTO \`VoiceSessionLease\`
            (\`id\`, \`accountId\`, \`sessionId\`, \`periodKey\`, \`grantedBy\`, \`elevenLabsAgentId\`,
             \`providerId\`, \`providerConversationId\`, \`expiresAt\`)
         VALUES (?, ?, ?, '2026-07', 'contract', 'contract-agent', ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR))`,
        fixture.boundLeaseId,
        fixture.accountId,
        fixture.sessionId,
        fixture.providerId,
        fixture.providerConversationId,
    );
    await db.$executeRawUnsafe(
        `INSERT INTO \`VoiceSessionLease\`
            (\`id\`, \`accountId\`, \`sessionId\`, \`periodKey\`, \`grantedBy\`, \`elevenLabsAgentId\`,
             \`providerId\`, \`providerConversationId\`, \`expiresAt\`)
         VALUES
            (?, ?, NULL, '2026-07', 'contract', 'contract-agent', NULL, NULL, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)),
            (?, ?, NULL, '2026-07', 'contract', 'contract-agent', ?, NULL, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)),
            (?, ?, NULL, '2026-07', 'contract', 'contract-agent', NULL, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR))`,
        fixture.nullLeaseId,
        fixture.accountId,
        fixture.providerOnlyLeaseId,
        fixture.accountId,
        fixture.providerId,
        fixture.conversationOnlyLeaseId,
        fixture.accountId,
        fixture.providerConversationId,
    );
    await db.$executeRawUnsafe(
        `INSERT INTO \`VoiceConversation\`
            (\`id\`, \`accountId\`, \`leaseId\`, \`providerId\`, \`providerConversationId\`, \`durationSeconds\`)
         VALUES (?, ?, ?, ?, ?, 1)`,
        fixture.conversationId,
        fixture.accountId,
        fixture.boundLeaseId,
        fixture.providerId,
        fixture.providerConversationId,
    );
    return fixture;
}

async function assertLegacyFixtureKey(
    fixture: LegacyVoiceIdentityFixture,
    expectedKey: string | null,
): Promise<void> {
    const conversations = await db.$queryRawUnsafe<Array<{
        providerId: string;
        providerConversationId: string;
        providerConversationKey: string | null;
    }>>(
        `SELECT \`providerId\`, \`providerConversationId\`, \`providerConversationKey\`
         FROM \`VoiceConversation\` WHERE \`id\` = ?`,
        fixture.conversationId,
    );
    assert.deepEqual(conversations, [{
        providerId: fixture.providerId,
        providerConversationId: fixture.providerConversationId,
        providerConversationKey: expectedKey,
    }]);

    const leases = await db.$queryRawUnsafe<Array<{
        id: string;
        sessionId: string | null;
        providerId: string | null;
        providerConversationId: string | null;
        providerConversationKey: string | null;
    }>>(
        `SELECT \`id\`, \`sessionId\`, \`providerId\`, \`providerConversationId\`, \`providerConversationKey\`
         FROM \`VoiceSessionLease\`
         WHERE \`id\` IN (?, ?, ?, ?)
         ORDER BY \`id\``,
        fixture.boundLeaseId,
        fixture.nullLeaseId,
        fixture.providerOnlyLeaseId,
        fixture.conversationOnlyLeaseId,
    );
    const leasesById = new Map(leases.map((lease) => [lease.id, lease]));
    assert.deepEqual(leasesById.get(fixture.boundLeaseId), {
        id: fixture.boundLeaseId,
        sessionId: fixture.sessionId,
        providerId: fixture.providerId,
        providerConversationId: fixture.providerConversationId,
        providerConversationKey: expectedKey,
    });
    assert.deepEqual(leasesById.get(fixture.nullLeaseId), {
        id: fixture.nullLeaseId,
        sessionId: null,
        providerId: null,
        providerConversationId: null,
        providerConversationKey: null,
    });
    assert.deepEqual(leasesById.get(fixture.providerOnlyLeaseId), {
        id: fixture.providerOnlyLeaseId,
        sessionId: null,
        providerId: fixture.providerId,
        providerConversationId: null,
        providerConversationKey: null,
    });
    assert.deepEqual(leasesById.get(fixture.conversationOnlyLeaseId), {
        id: fixture.conversationOnlyLeaseId,
        sessionId: null,
        providerId: null,
        providerConversationId: fixture.providerConversationId,
        providerConversationKey: null,
    });
}

async function assertPreparedSchema(): Promise<void> {
    const migrationRows = await db.$queryRawUnsafe<Array<{
        migration_name: string;
        finished: number;
        rolledBack: number;
    }>>(
        `SELECT \`migration_name\`, \`finished_at\` IS NOT NULL AS \`finished\`,
                \`rolled_back_at\` IS NOT NULL AS \`rolledBack\`
         FROM \`_prisma_migrations\` WHERE \`migration_name\` = ?`,
        MYSQL_VOICE_IDENTITY_TARGET_MIGRATION,
    );
    assert.deepEqual(migrationRows.map((row) => ({
        migration_name: row.migration_name,
        finished: Number(row.finished),
        rolledBack: Number(row.rolledBack),
    })), [{
        migration_name: MYSQL_VOICE_IDENTITY_TARGET_MIGRATION,
        finished: 1,
        rolledBack: 0,
    }]);

    const columns = await db.$queryRawUnsafe<Array<{
        TABLE_NAME: string;
        COLUMN_NAME: string;
        CHARACTER_MAXIMUM_LENGTH: bigint | number;
        IS_NULLABLE: "YES" | "NO";
    }>>(
        `SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND ((TABLE_NAME = 'VoiceConversation' AND COLUMN_NAME IN ('providerConversationId', 'providerConversationKey'))
             OR (TABLE_NAME = 'VoiceSessionLease' AND COLUMN_NAME IN ('sessionId', 'providerConversationId', 'providerConversationKey')))`,
    );
    const columnShape = Object.fromEntries(columns.map((column) => [
        `${column.TABLE_NAME}.${column.COLUMN_NAME}`,
        { maxLength: Number(column.CHARACTER_MAXIMUM_LENGTH), nullable: column.IS_NULLABLE === "YES" },
    ]));
    assert.deepEqual(columnShape, {
        "VoiceConversation.providerConversationId": { maxLength: 191, nullable: false },
        "VoiceConversation.providerConversationKey": { maxLength: 64, nullable: true },
        "VoiceSessionLease.sessionId": { maxLength: 512, nullable: true },
        "VoiceSessionLease.providerConversationId": { maxLength: 191, nullable: true },
        "VoiceSessionLease.providerConversationKey": { maxLength: 64, nullable: true },
    });

    const indexes = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string; INDEX_NAME: string }>>(
        `SELECT DISTINCT TABLE_NAME, INDEX_NAME
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN ('VoiceConversation', 'VoiceSessionLease')`,
    );
    const indexNames = new Set(indexes.map((row) => `${row.TABLE_NAME}.${row.INDEX_NAME}`));
    assert(indexNames.has("VoiceConversation.VoiceConversation_providerId_providerConversationKey_key"));
    assert(indexNames.has("VoiceSessionLease.VoiceSessionLease_provider_binding_key_lookup_idx"));
    assert(indexNames.has("VoiceConversation.VoiceConversation_providerId_providerConversationId_key"));
    assert(indexNames.has("VoiceSessionLease.VoiceSessionLease_provider_binding_lookup_idx"));
}

interface CanonicalVoiceIdentityFixture {
    readonly id: string;
    readonly providerId: string;
    readonly providerConversationId: string;
    readonly providerConversationKey: string;
}

async function seedCanonicalVoiceIdentityFixture(): Promise<CanonicalVoiceIdentityFixture> {
    const suffix = randomUUID();
    const accountId = `mysql-upgrade-canonical-account-${suffix}`;
    const identity = {
        providerId: "mysql-upgrade-canonical",
        providerConversationId: `canonical-${suffix}`,
    };
    const fixture: CanonicalVoiceIdentityFixture = {
        id: `mysql-upgrade-canonical-conversation-${suffix}`,
        ...identity,
        providerConversationKey: deriveVoiceProviderConversationKey(identity),
    };
    await db.$executeRawUnsafe(
        "INSERT INTO `Account` (`id`, `publicKey`, `updatedAt`) VALUES (?, ?, CURRENT_TIMESTAMP(3))",
        accountId,
        `mysql-upgrade-canonical-key-${suffix}`,
    );
    // This fixture intentionally targets the historical schema immediately
    // after the identity migration. Use its exact column projection rather
    // than the current Prisma model, which may contain later additive fields.
    await db.$executeRawUnsafe(
        `INSERT INTO \`VoiceConversation\`
            (\`id\`, \`accountId\`, \`providerId\`, \`providerConversationId\`,
             \`providerConversationKey\`, \`durationSeconds\`)
         VALUES (?, ?, ?, ?, ?, 1)`,
        fixture.id,
        accountId,
        fixture.providerId,
        fixture.providerConversationId,
        fixture.providerConversationKey,
    );
    return fixture;
}

async function assertRollbackReaderFindsCanonicalFixture(fixture: CanonicalVoiceIdentityFixture): Promise<void> {
    const rows = await db.$queryRawUnsafe<Array<{
        id: string;
        providerConversationKey: string | null;
    }>>(
        `SELECT \`id\`, \`providerConversationKey\`
         FROM \`VoiceConversation\`
         WHERE \`providerId\` = ? AND \`providerConversationId\` = ?`,
        fixture.providerId,
        fixture.providerConversationId,
    );
    assert.deepEqual(rows, [{ id: fixture.id, providerConversationKey: fixture.providerConversationKey }]);
}

async function runBoundedBackfillToZero(): Promise<void> {
    let conversationsUpdated = 0;
    let leasesUpdated = 0;
    for (let batch = 0; batch < 10; batch += 1) {
        const result = await backfillVoiceProviderConversationIdentityBatch({ batchSize: 1 });
        conversationsUpdated += result.conversationsUpdated;
        leasesUpdated += result.leasesUpdated;
        if (result.conversationsUpdated === 0 && result.leasesUpdated === 0) break;
    }
    assert.equal(conversationsUpdated, 2);
    assert.equal(leasesUpdated, 2);
    assert.deepEqual(await countVoiceProviderConversationIdentityBackfillRemaining(), {
        conversations: 0,
        leases: 0,
    });
    assert.deepEqual(await backfillVoiceProviderConversationIdentityBatch({ batchSize: 1 }), {
        conversationsUpdated: 0,
        leasesUpdated: 0,
    });
}

export async function runMysqlVoiceIdentityUpgradeContract(params: Readonly<{
    databaseUrl: string;
    serverRoot: string;
}>): Promise<void> {
    const sourcePrismaDir = join(params.serverRoot, "prisma", "mysql");
    const sourceMigrationsDir = join(sourcePrismaDir, "migrations");
    const migrationNames = (await readdir(sourceMigrationsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    const sequence = resolveMysqlVoiceIdentityMigrationSequence({
        migrationNames,
        targetMigration: MYSQL_VOICE_IDENTITY_TARGET_MIGRATION,
    });
    const stageDir = await mkdtemp(join(tmpdir(), "happier-mysql-voice-identity-upgrade-"));
    let connected = false;
    try {
        const stagedMigrationsDir = await stagePreTargetMigrations({
            sourcePrismaDir,
            stageDir,
            sequence,
        });
        await deployStagedMigrations({ ...params, stageDir });

        process.env.DATABASE_URL = params.databaseUrl;
        await initDbMysql();
        await db.$connect();
        connected = true;
        const beforePrepare = await seedLegacyVoiceIdentityFixture("before-prepare");

        await copyMigrationAsset({
            sourceMigrationsDir,
            stagedMigrationsDir,
            migrationName: sequence.target,
        });
        await deployStagedMigrations({ ...params, stageDir });

        // remote-dev's exact predecessor persistence shape omits the digest.
        const afterPrepare = await seedLegacyVoiceIdentityFixture("after-prepare");
        await assertPreparedSchema();
        await assertLegacyFixtureKey(beforePrepare, null);
        await assertLegacyFixtureKey(afterPrepare, null);

        const canonical = await seedCanonicalVoiceIdentityFixture();
        await assertRollbackReaderFindsCanonicalFixture(canonical);

        await runBoundedBackfillToZero();
        for (const fixture of [beforePrepare, afterPrepare]) {
            await assertLegacyFixtureKey(fixture, deriveVoiceProviderConversationKey(fixture));
        }

        for (const migrationName of sequence.remaining) {
            await copyMigrationAsset({ sourceMigrationsDir, stagedMigrationsDir, migrationName });
        }
        await deployStagedMigrations({ ...params, stageDir });
        await assertPreparedSchema();
        await assertRollbackReaderFindsCanonicalFixture(canonical);
    } finally {
        if (connected) await db.$disconnect();
        await rm(stageDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const provider = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "")
        .trim()
        .toLowerCase();
    if (provider !== "mysql") {
        throw new Error(`MySQL voice identity upgrade contract requires HAPPIER_DB_PROVIDER=mysql; received ${provider || "unset"}`);
    }
    const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
    if (!databaseUrl) throw new Error("MySQL voice identity upgrade contract requires DATABASE_URL");
    await runMysqlVoiceIdentityUpgradeContract({
        databaseUrl,
        serverRoot: resolveServerWorkspaceRoot(import.meta.url),
    });
}

function isMain(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
