import { createHash, randomUUID } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPrismaMigrateCli } from "../prismaMigrateCli";
import { createDbMaintenanceClient, type PrismaClientType } from "../../sources/storage/prisma";

type Provider = "postgres" | "mysql";
type PredecessorFrontier = "released-v0.2.1" | "released-v0.2.12" | "current-0.2";

const serverRoot = join(import.meta.dirname, "..", "..");
const quotaDropId = "20260630223000_drop_service_account_quota_snapshots";
// Immutable `server-v0.2.1` (4913c1e533c872a0712ba1c25b3104fd470aacc2)
// ends at `earlyPredecessorLastId`. The current predecessor owns the quota DROP
// on its independent line. The exact released DROP is retained in 0.3 and is
// copied from the canonical migration below.
// The later list is the observed current `../0.2` frontier at
// ac30c50856abd2265c14459e77ee3384da1698ad (branch `dev`, clean). Its relevant
// migration trees are clean through 20260907190000 and shared SQL remains byte-identical.
// Immutable `server-v0.2.12` at
// a357c65536ba89669422977d6f7daf9aa0d17e73 ends at
// `latestReleasedPredecessorLastId`; every included SQL file is byte-identical
// to the retained current migration with the same identity.
const earlyPredecessorLastId = "20260326130000_add_pending_queue_seq";
const latestReleasedPredecessorLastId = "20260902120000_add_pending_activation_authorization";
const postgresOnlyPredecessorIds = [
    "20260412172000_add_account_push_token_client_server_url",
] as const;
const laterPredecessorIds = [
    "20260504110500_add_account_pet_library",
    "20260506193000_add_session_runtime_issue_projection",
    "20260512130000_add_machine_installation_identity",
    "20260513143000_add_session_folder_assignment",
    "20260514100000_add_session_message_role_metadata",
    "20260517150000_add_session_meaningful_activity_at",
    "20260517173000_add_connected_service_auth_groups",
    "20260517190000_add_session_turns",
    "20260517200000_add_connected_service_auth_group_member_credential_fk",
    "20260519183000_add_session_system_records",
    "20260520110000_add_session_attention_projection_facts",
    "20260523154000_add_account_settings_snapshots",
    "20260624123000_add_pending_delivery_state",
    "20260630162000_add_provider_account_usage_records",
    "20260630170000_add_session_organization_models",
    quotaDropId,
    "20260701123000_add_session_runtime_activity_projection",
    "20260723210000_drop_public_share_blocked_users",
    "20260723220000_add_connected_service_auth_group_runtime_state_revision",
    "20260803201500_add_session_publisher_generation",
    "20260807120000_add_session_unread_since",
    "20260808120000_add_session_needs_attention",
    "20260810190000_add_session_message_row_revision",
    "20260810200000_expand_session_turn_anchor_projection",
    "20260816230000_add_manual_automation_triggers",
    "20260819120000_add_session_attention_standing",
    "20260902120000_add_pending_activation_authorization",
    "20260907190000_add_session_attention_reminder",
] as const;

const predecessorSqlDigests = {
    postgres: {
        "released-v0.2.1": "0a31526e800c3834ed539725130d7f15e71585045599ce59d019f7bef1594851",
        "released-v0.2.12": "900f876103c9a3bac7163a9a7cfbd7e4533083bd23838a6e860fb2904b6a61d7",
        "current-0.2": "e90632771ecf6c7852a14cb5a6d777415cbed3e041df182d97073e0597b2d0df",
    },
    mysql: {
        "released-v0.2.1": "f9c377792f5a8c3770ed9ab6ef24451a577c1b85454945de7ae1dd88a6ad36f5",
        "released-v0.2.12": "3d462a0f149abdc8d521f9f21d318b5e8d553ed7b1c425aff34c3af05110e2f0",
        "current-0.2": "90c4d37f701869a76ce36af4c7b541ee7b268d2da4669cc43d006fb541509ed9",
    },
} as const;

function migrationsRoot(provider: Provider): string {
    return provider === "postgres"
        ? join(serverRoot, "prisma", "migrations")
        : join(serverRoot, "prisma", "mysql", "migrations");
}

function prismaRoot(provider: Provider): string {
    return provider === "postgres"
        ? join(serverRoot, "prisma")
        : join(serverRoot, "prisma", "mysql");
}

async function currentMigrationIds(provider: Provider): Promise<string[]> {
    return (await readdir(migrationsRoot(provider), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

async function predecessorMigrationIds(provider: Provider, frontier: PredecessorFrontier): Promise<string[]> {
    const early = (await currentMigrationIds(provider)).filter((id) => id <= earlyPredecessorLastId);
    if (frontier === "released-v0.2.1") return early;
    const later = [
        ...early,
        ...(provider === "postgres" ? postgresOnlyPredecessorIds : []),
        ...laterPredecessorIds,
    ].sort((left, right) => left.localeCompare(right));
    return frontier === "released-v0.2.12"
        ? later.filter((id) => id <= latestReleasedPredecessorLastId)
        : later;
}

async function copyMigration(provider: Provider, id: string, targetRoot: string): Promise<void> {
    await cp(join(migrationsRoot(provider), id), join(targetRoot, id), { recursive: true });
}

async function digestMigrationSql(migrationsDir: string, ids: readonly string[]): Promise<string> {
    const hash = createHash("sha256");
    for (const id of ids) {
        hash.update(id);
        hash.update("\0");
        hash.update(await readFile(join(migrationsDir, id, "migration.sql")));
        hash.update("\0");
    }
    return hash.digest("hex");
}

async function createStagedPredecessor(
    provider: Provider,
    frontier: PredecessorFrontier,
): Promise<Readonly<{
    stageDir: string;
    stagedMigrationsDir: string;
}>> {
    const stageDir = await mkdtemp(join(tmpdir(), `happier-${provider}-predecessor-lineage-`));
    const stagedMigrationsDir = join(stageDir, "migrations");
    await mkdir(stagedMigrationsDir, { recursive: true });
    await copyFile(join(prismaRoot(provider), "schema.prisma"), join(stageDir, "schema.prisma"));
    await copyFile(
        join(migrationsRoot(provider), "migration_lock.toml"),
        join(stagedMigrationsDir, "migration_lock.toml"),
    );
    const migrationIds = await predecessorMigrationIds(provider, frontier);
    for (const id of migrationIds) {
        await copyMigration(provider, id, stagedMigrationsDir);
    }
    expect(await digestMigrationSql(stagedMigrationsDir, migrationIds)).toBe(predecessorSqlDigests[provider][frontier]);
    return { stageDir, stagedMigrationsDir };
}

async function replacePredecessorWithCurrentMigrations(
    provider: Provider,
    stagedMigrationsDir: string,
): Promise<void> {
    await rm(join(stagedMigrationsDir, quotaDropId), { recursive: true, force: true });
    for (const id of await currentMigrationIds(provider)) {
        const target = join(stagedMigrationsDir, id);
        await rm(target, { recursive: true, force: true });
        await cp(join(migrationsRoot(provider), id), target, { recursive: true });
    }
}

async function deploy(provider: Provider, stageDir: string, databaseUrl: string): Promise<void> {
    await runPrismaMigrateCli({
        serverRoot,
        schemaPath: join(stageDir, "schema.prisma"), args: ['deploy'],
        env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            HAPPIER_DB_PROVIDER: provider,
        },
        quiet: true,
    });
}

function providerDatabaseUrl(provider: Provider): string | null {
    const dedicated = provider === "postgres"
        ? process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        : process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
    if (dedicated?.trim()) return dedicated.trim();

    const configuredProvider = String(
        process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "",
    ).trim().toLowerCase();
    const providerMatches = provider === "postgres"
        ? configuredProvider === "postgres" || configuredProvider === "postgresql"
        : configuredProvider === "mysql";
    return providerMatches && process.env.DATABASE_URL?.trim()
        ? process.env.DATABASE_URL.trim()
        : null;
}

function postgresSchemaUrl(databaseUrl: string, schema: string): string {
    const url = new URL(databaseUrl);
    url.searchParams.set("schema", schema);
    return url.toString();
}

function mysqlDatabaseUrl(databaseUrl: string, database: string): string {
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    return url.toString();
}

const workflowEnvelopeFixture = JSON.stringify({
    t: "plain",
    v: "workflow-envelope-".repeat(40),
});

async function seedReleasedAutomation(
    provider: Provider,
    database: PrismaClientType,
): Promise<void> {
    const quote = provider === "postgres" ? '"' : "`";
    const now = provider === "postgres" ? "CURRENT_TIMESTAMP" : "CURRENT_TIMESTAMP(3)";
    await database.$executeRawUnsafe(
        `INSERT INTO ${quote}Account${quote} (${quote}id${quote}, ${quote}publicKey${quote}, ${quote}updatedAt${quote}) VALUES ('workflow-predecessor-account', 'workflow-predecessor-key', ${now})`,
    );
    await database.$executeRawUnsafe(
        `INSERT INTO ${quote}Automation${quote} (${quote}id${quote}, ${quote}accountId${quote}, ${quote}name${quote}, ${quote}scheduleKind${quote}, ${quote}targetType${quote}, ${quote}templateCiphertext${quote}, ${quote}updatedAt${quote}) VALUES ('workflow-predecessor-automation', 'workflow-predecessor-account', 'Released automation', 'manual', 'new_session', 'sealed-template', ${now})`,
    );
    await database.$executeRawUnsafe(
        `INSERT INTO ${quote}AutomationRun${quote} (${quote}id${quote}, ${quote}automationId${quote}, ${quote}accountId${quote}, ${quote}state${quote}, ${quote}scheduledAt${quote}, ${quote}dueAt${quote}, ${quote}updatedAt${quote}) VALUES ('workflow-predecessor-run', 'workflow-predecessor-automation', 'workflow-predecessor-account', 'succeeded', ${now}, ${now}, ${now})`,
    );
}

async function expectWorkflowUpgradeStorage(
    provider: Provider,
    database: PrismaClientType,
): Promise<void> {
    if (provider === "postgres") {
        await database.$executeRawUnsafe(
            `UPDATE "AutomationRun"
             SET "workflowAcceptedSnapshotEnvelope" = $1, "workflowCheckpointEnvelope" = $1,
                 "workflowCustodyState" = 'pending'
             WHERE "id" = 'workflow-predecessor-run'`,
            workflowEnvelopeFixture,
        );
        await database.$executeRawUnsafe(
            `INSERT INTO "WorkflowRunInvocation"
                ("id", "runId", "sequence", "memberOrdinal", "contentEnvelope", "updatedAt")
             VALUES ('workflow-predecessor-invocation', 'workflow-predecessor-run', 0, 0, $1, CURRENT_TIMESTAMP)`,
            workflowEnvelopeFixture,
        );
        const [run] = await database.$queryRawUnsafe<Array<{
            originKind: string;
            automationId: string;
            acceptedLength: unknown;
            checkpointLength: unknown;
        }>>(`
            SELECT "originKind", "automationId",
                   char_length("workflowAcceptedSnapshotEnvelope") AS "acceptedLength",
                   char_length("workflowCheckpointEnvelope") AS "checkpointLength"
            FROM "AutomationRun" WHERE "id" = 'workflow-predecessor-run'
        `);
        expect(run).toMatchObject({
            originKind: "automation",
            automationId: "workflow-predecessor-automation",
        });
        expect(Number(run?.acceptedLength)).toBe(workflowEnvelopeFixture.length);
        expect(Number(run?.checkpointLength)).toBe(workflowEnvelopeFixture.length);
        const [invocation] = await database.$queryRawUnsafe<Array<{ contentLength: unknown }>>(`
            SELECT char_length("contentEnvelope") AS "contentLength"
            FROM "WorkflowRunInvocation" WHERE "id" = 'workflow-predecessor-invocation'
        `);
        expect(Number(invocation?.contentLength)).toBe(workflowEnvelopeFixture.length);
        return;
    }

    await database.$executeRawUnsafe(
        "UPDATE `AutomationRun` SET `workflowAcceptedSnapshotEnvelope` = ?, `workflowCheckpointEnvelope` = ?, `workflowCustodyState` = 'pending' WHERE `id` = 'workflow-predecessor-run'",
        workflowEnvelopeFixture,
        workflowEnvelopeFixture,
    );
    await database.$executeRawUnsafe(
        "INSERT INTO `WorkflowRunInvocation` (`id`, `runId`, `sequence`, `memberOrdinal`, `contentEnvelope`, `updatedAt`) VALUES ('workflow-predecessor-invocation', 'workflow-predecessor-run', 0, 0, ?, CURRENT_TIMESTAMP(3))",
        workflowEnvelopeFixture,
    );
    const [run] = await database.$queryRawUnsafe<Array<{
        originKind: string;
        automationId: string;
        acceptedLength: unknown;
        checkpointLength: unknown;
    }>>(`
        SELECT \`originKind\`, \`automationId\`,
               CHAR_LENGTH(\`workflowAcceptedSnapshotEnvelope\`) AS \`acceptedLength\`,
               CHAR_LENGTH(\`workflowCheckpointEnvelope\`) AS \`checkpointLength\`
        FROM \`AutomationRun\` WHERE \`id\` = 'workflow-predecessor-run'
    `);
    expect(run).toMatchObject({
        originKind: "automation",
        automationId: "workflow-predecessor-automation",
    });
    expect(Number(run?.acceptedLength)).toBe(workflowEnvelopeFixture.length);
    expect(Number(run?.checkpointLength)).toBe(workflowEnvelopeFixture.length);
    const [invocation] = await database.$queryRawUnsafe<Array<{ contentLength: unknown }>>(`
        SELECT CHAR_LENGTH(\`contentEnvelope\`) AS \`contentLength\`
        FROM \`WorkflowRunInvocation\` WHERE \`id\` = 'workflow-predecessor-invocation'
    `);
    expect(Number(invocation?.contentLength)).toBe(workflowEnvelopeFixture.length);
}

async function expectPostgresMachinePoolContract(database: PrismaClientType): Promise<void> {
    const longPoolName = `Unicode 池 🚀 ${"n".repeat(512)}`;
    await expect(database.$queryRawUnsafe<Array<{ indexname: string }>>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'TeamCredentialResource'
           AND indexname = 'TeamCredentialResource_brokerPoolId_idx'`,
    )).resolves.toEqual([{ indexname: "TeamCredentialResource_brokerPoolId_idx" }]);
    await expect(database.$queryRawUnsafe<Array<{ deleteRule: string; updateRule: string }>>(
        `SELECT rc.delete_rule AS "deleteRule", rc.update_rule AS "updateRule"
         FROM information_schema.referential_constraints rc
         WHERE rc.constraint_schema = current_schema()
           AND rc.constraint_name = 'TeamCredentialResource_brokerPoolId_fkey'`,
    )).resolves.toEqual([{ deleteRule: "SET NULL", updateRule: "CASCADE" }]);
    await database.$executeRawUnsafe(`INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES
        ('pool-owner', 'pool-owner-key', CURRENT_TIMESTAMP),
        ('pool-owner-cascade', 'pool-owner-cascade-key', CURRENT_TIMESTAMP)`);
    await database.$executeRawUnsafe(`INSERT INTO "Team" ("id", "name", "updatedAt")
        VALUES ('pool-team', 'Pool team', CURRENT_TIMESTAMP)`);
    await database.$executeRawUnsafe(`INSERT INTO "Machine" ("id", "accountId", "metadata", "updatedAt") VALUES
        ('pool-machine-a', 'pool-owner', '{}', CURRENT_TIMESTAMP),
        ('pool-machine-b', 'pool-owner', '{}', CURRENT_TIMESTAMP)`);

    await expect(database.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO "MachinePool" ("id", "accountId", "name", "updatedAt")
            VALUES ('pool-atomic', 'pool-owner', 'must roll back', CURRENT_TIMESTAMP)`);
        await tx.$executeRawUnsafe(`INSERT INTO "MachinePoolMember" ("poolId", "machineId", "priorityTier")
            VALUES ('pool-atomic', 'missing-machine', 0)`);
    })).rejects.toThrow();
    expect(await database.$queryRawUnsafe(`SELECT "id" FROM "MachinePool" WHERE "id"='pool-atomic'`)).toEqual([]);

    await database.$executeRawUnsafe(`INSERT INTO "MachinePool" ("id", "accountId", "name", "description", "updatedAt") VALUES
        ('pool-machine-delete', 'pool-owner', 'Same name', 'first', CURRENT_TIMESTAMP),
        ('pool-direct-delete', 'pool-owner', 'Same name', 'second', CURRENT_TIMESTAMP),
        ('pool-account-delete', 'pool-owner-cascade', $1, 'owned by account', CURRENT_TIMESTAMP)`, longPoolName);
    await database.$executeRawUnsafe(`INSERT INTO "MachinePoolMember" ("poolId", "machineId", "priorityTier", "enabled") VALUES
        ('pool-machine-delete', 'pool-machine-a', 0, true),
        ('pool-direct-delete', 'pool-machine-b', 7, false)`);
    await database.$executeRawUnsafe(`INSERT INTO "TeamCredentialResource"
        ("id", "teamId", "custodianAccountId", "displayName", "disclosureCeiling",
         "sessionUsePolicy", "sourceBindingJson", "brokerPoolId", "updatedAt")
        VALUES ('pool-resource', 'pool-team', 'pool-owner', 'Pool resource', 'brokered_only',
                'personal_allowed', '{}', 'pool-direct-delete', CURRENT_TIMESTAMP)`);
    expect(await database.$queryRawUnsafe(`SELECT "id", "accountId", "name", "description", "revision"
        FROM "MachinePool" ORDER BY "id"`)).toEqual([
        { id: "pool-account-delete", accountId: "pool-owner-cascade", name: longPoolName, description: "owned by account", revision: 0 },
        { id: "pool-direct-delete", accountId: "pool-owner", name: "Same name", description: "second", revision: 0 },
        { id: "pool-machine-delete", accountId: "pool-owner", name: "Same name", description: "first", revision: 0 },
    ]);

    await database.$executeRawUnsafe(`DELETE FROM "Machine" WHERE "id"='pool-machine-a'`);
    expect(await database.$queryRawUnsafe(`SELECT "poolId" FROM "MachinePoolMember" WHERE "poolId"='pool-machine-delete'`)).toEqual([]);
    expect(await database.$queryRawUnsafe(`SELECT "id" FROM "MachinePool" WHERE "id"='pool-machine-delete'`)).toEqual([{ id: "pool-machine-delete" }]);
    await database.$executeRawUnsafe(`DELETE FROM "MachinePool" WHERE "id"='pool-direct-delete'`);
    expect(await database.$queryRawUnsafe(`SELECT "poolId" FROM "MachinePoolMember" WHERE "poolId"='pool-direct-delete'`)).toEqual([]);
    expect(await database.$queryRawUnsafe(`SELECT "brokerPoolId", "revision" FROM "TeamCredentialResource"
        WHERE "id"='pool-resource'`)).toEqual([{ brokerPoolId: null, revision: 0 }]);
    await expect(database.$executeRawUnsafe(`UPDATE "TeamCredentialResource" SET "brokerPoolId"='missing-pool'
        WHERE "id"='pool-resource'`)).rejects.toThrow();
    await database.$executeRawUnsafe(`DELETE FROM "Account" WHERE "id"='pool-owner-cascade'`);
    expect(await database.$queryRawUnsafe(`SELECT "id" FROM "MachinePool" WHERE "id"='pool-account-delete'`)).toEqual([]);
}

async function expectMysqlMachinePoolContract(database: PrismaClientType): Promise<void> {
    const longPoolName = `Unicode 池 🚀 ${"n".repeat(512)}`;
    await expect(database.$queryRawUnsafe<Array<{ INDEX_NAME: string }>>(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'TeamCredentialResource'
           AND INDEX_NAME = 'TeamCredentialResource_brokerPoolId_idx'`,
    )).resolves.toEqual([{ INDEX_NAME: "TeamCredentialResource_brokerPoolId_idx" }]);
    await expect(database.$queryRawUnsafe<Array<{ deleteRule: string; updateRule: string }>>(
        `SELECT DELETE_RULE AS \`deleteRule\`, UPDATE_RULE AS \`updateRule\`
         FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND CONSTRAINT_NAME = 'TeamCredentialResource_brokerPoolId_fkey'`,
    )).resolves.toEqual([{ deleteRule: "SET NULL", updateRule: "CASCADE" }]);
    await database.$executeRawUnsafe(`INSERT INTO \`Account\` (\`id\`, \`publicKey\`, \`updatedAt\`) VALUES
        ('pool-owner', 'pool-owner-key', CURRENT_TIMESTAMP(3)),
        ('pool-owner-cascade', 'pool-owner-cascade-key', CURRENT_TIMESTAMP(3))`);
    await database.$executeRawUnsafe(`INSERT INTO \`Team\` (\`id\`, \`name\`, \`updatedAt\`)
        VALUES ('pool-team', 'Pool team', CURRENT_TIMESTAMP(3))`);
    await database.$executeRawUnsafe(`INSERT INTO \`Machine\` (\`id\`, \`accountId\`, \`metadata\`, \`updatedAt\`) VALUES
        ('pool-machine-a', 'pool-owner', '{}', CURRENT_TIMESTAMP(3)),
        ('pool-machine-b', 'pool-owner', '{}', CURRENT_TIMESTAMP(3))`);

    await expect(database.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO \`MachinePool\` (\`id\`, \`accountId\`, \`name\`, \`updatedAt\`)
            VALUES ('pool-atomic', 'pool-owner', 'must roll back', CURRENT_TIMESTAMP(3))`);
        await tx.$executeRawUnsafe(`INSERT INTO \`MachinePoolMember\` (\`poolId\`, \`machineId\`, \`priorityTier\`)
            VALUES ('pool-atomic', 'missing-machine', 0)`);
    })).rejects.toThrow();
    expect(await database.$queryRawUnsafe(`SELECT \`id\` FROM \`MachinePool\` WHERE \`id\`='pool-atomic'`)).toEqual([]);

    await database.$executeRawUnsafe(`INSERT INTO \`MachinePool\` (\`id\`, \`accountId\`, \`name\`, \`description\`, \`updatedAt\`) VALUES
        ('pool-machine-delete', 'pool-owner', 'Same name', 'first', CURRENT_TIMESTAMP(3)),
        ('pool-direct-delete', 'pool-owner', 'Same name', 'second', CURRENT_TIMESTAMP(3)),
        ('pool-account-delete', 'pool-owner-cascade', ?, 'owned by account', CURRENT_TIMESTAMP(3))`, longPoolName);
    await database.$executeRawUnsafe(`INSERT INTO \`MachinePoolMember\` (\`poolId\`, \`machineId\`, \`priorityTier\`, \`enabled\`) VALUES
        ('pool-machine-delete', 'pool-machine-a', 0, true),
        ('pool-direct-delete', 'pool-machine-b', 7, false)`);
    await database.$executeRawUnsafe(`INSERT INTO \`TeamCredentialResource\`
        (\`id\`, \`teamId\`, \`custodianAccountId\`, \`displayName\`, \`disclosureCeiling\`,
         \`sessionUsePolicy\`, \`sourceBindingJson\`, \`brokerPoolId\`, \`updatedAt\`)
        VALUES ('pool-resource', 'pool-team', 'pool-owner', 'Pool resource', 'brokered_only',
                'personal_allowed', '{}', 'pool-direct-delete', CURRENT_TIMESTAMP(3))`);
    expect(await database.$queryRawUnsafe(`SELECT \`id\`, \`accountId\`, \`name\`, \`description\`, \`revision\`
        FROM \`MachinePool\` ORDER BY \`id\``)).toEqual([
        { id: "pool-account-delete", accountId: "pool-owner-cascade", name: longPoolName, description: "owned by account", revision: 0 },
        { id: "pool-direct-delete", accountId: "pool-owner", name: "Same name", description: "second", revision: 0 },
        { id: "pool-machine-delete", accountId: "pool-owner", name: "Same name", description: "first", revision: 0 },
    ]);

    await database.$executeRawUnsafe(`DELETE FROM \`Machine\` WHERE \`id\`='pool-machine-a'`);
    expect(await database.$queryRawUnsafe(`SELECT \`poolId\` FROM \`MachinePoolMember\` WHERE \`poolId\`='pool-machine-delete'`)).toEqual([]);
    expect(await database.$queryRawUnsafe(`SELECT \`id\` FROM \`MachinePool\` WHERE \`id\`='pool-machine-delete'`)).toEqual([{ id: "pool-machine-delete" }]);
    await database.$executeRawUnsafe(`DELETE FROM \`MachinePool\` WHERE \`id\`='pool-direct-delete'`);
    expect(await database.$queryRawUnsafe(`SELECT \`poolId\` FROM \`MachinePoolMember\` WHERE \`poolId\`='pool-direct-delete'`)).toEqual([]);
    expect(await database.$queryRawUnsafe(`SELECT \`brokerPoolId\`, \`revision\` FROM \`TeamCredentialResource\`
        WHERE \`id\`='pool-resource'`)).toEqual([{ brokerPoolId: null, revision: 0 }]);
    await expect(database.$executeRawUnsafe(`UPDATE \`TeamCredentialResource\` SET \`brokerPoolId\`='missing-pool'
        WHERE \`id\`='pool-resource'`)).rejects.toThrow();
    await database.$executeRawUnsafe(`DELETE FROM \`Account\` WHERE \`id\`='pool-owner-cascade'`);
    expect(await database.$queryRawUnsafe(`SELECT \`id\` FROM \`MachinePool\` WHERE \`id\`='pool-account-delete'`)).toEqual([]);
}

const predecessorCases = [
    { frontier: "released-v0.2.1", hasQuotaBeforeUpgrade: true },
    { frontier: "released-v0.2.12", hasQuotaBeforeUpgrade: false },
    { frontier: "current-0.2", hasQuotaBeforeUpgrade: false },
] as const satisfies ReadonlyArray<Readonly<{
    frontier: PredecessorFrontier;
    hasQuotaBeforeUpgrade: boolean;
}>>;

describe.each(predecessorCases)("$frontier migration lineage before Account Directory", ({
    frontier,
    hasQuotaBeforeUpgrade,
}) => {
    const temporaryPaths: string[] = [];

    afterEach(async () => {
        await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it.each(["postgres", "mysql"] as const)(
        "stages the provenance-pinned %s migration ledger and SQL",
        async (provider) => {
            const staged = await createStagedPredecessor(provider, frontier);
            temporaryPaths.push(staged.stageDir);
        },
    );

    const postgresUrl = providerDatabaseUrl("postgres");
    const postgresTest = postgresUrl ? it : it.skip;
    postgresTest(
        `upgrades PostgreSQL twice without losing supported predecessor state and enforces Machine Pool storage${
            postgresUrl ? "" : " [skipped: HAPPIER_TEST_POSTGRES_DATABASE_URL is absent]"
        }`,
        async () => {
            if (!postgresUrl) return;
            const schema = `lane02_lineage_${randomUUID().replace(/-/gu, "")}`;
            const admin = await createDbMaintenanceClient("postgres", postgresUrl);
            const databaseUrl = postgresSchemaUrl(postgresUrl, schema);
            const database = await createDbMaintenanceClient("postgres", databaseUrl);
            const staged = await createStagedPredecessor("postgres", frontier);
            temporaryPaths.push(staged.stageDir);
            try {
                await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
                await deploy("postgres", staged.stageDir, databaseUrl);
                const predecessorQuotaTables = await database.$queryRawUnsafe<Array<{ table_name: string }>>(
                    `SELECT table_name FROM information_schema.tables
                     WHERE table_schema = current_schema()
                       AND table_name = 'ServiceAccountQuotaSnapshot'`,
                );
                expect(predecessorQuotaTables).toHaveLength(hasQuotaBeforeUpgrade ? 1 : 0);
                if (hasQuotaBeforeUpgrade) {
                    await database.$executeRawUnsafe(
                        `INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
                        "preserved-quota-account",
                        "preserved-quota-public-key",
                    );
                    await database.$executeRawUnsafe(
                        `INSERT INTO "ServiceAccountQuotaSnapshot"
                            ("id", "accountId", "vendor", "profileId", "snapshot", "status", "updatedAt")
                         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
                        "preserved-quota-row",
                        "preserved-quota-account",
                        "anthropic",
                        "default",
                        Buffer.from("sealed-preserved-quota"),
                        "ok",
                    );
                } else {
                    await expect(database.$queryRawUnsafe(
                        `SELECT indexname FROM pg_indexes
                         WHERE schemaname = current_schema()
                           AND indexname = 'Session_accountId_needsAttention_meaningfulActivityAt_id_idx'`,
                    )).resolves.toHaveLength(1);
                }

                if (!hasQuotaBeforeUpgrade) {
                    // The pinned predecessor owns these shared fields; no recipient baseline is attributable.
                    await database.$executeRawUnsafe("INSERT INTO \"Account\" (\"id\", \"publicKey\", \"updatedAt\") VALUES ('read-owner', 'read-owner-key', CURRENT_TIMESTAMP), ('read-recipient', 'read-recipient-key', CURRENT_TIMESTAMP)");
                    await database.$executeRawUnsafe("INSERT INTO \"Session\" (\"id\", \"tag\", \"accountId\", \"metadata\", \"updatedAt\", \"seq\", \"lastViewedSessionSeq\", \"unreadSince\") VALUES ('read-never', 'read-never', 'read-owner', '{}', CURRENT_TIMESTAMP, 5, NULL, NULL), ('read-unread', 'read-unread', 'read-owner', '{}', CURRENT_TIMESTAMP, 5, 2, '2026-08-01 00:00:00')");
                }
                if (frontier === "released-v0.2.12") {
                    await seedReleasedAutomation("postgres", database);
                }

                await replacePredecessorWithCurrentMigrations("postgres", staged.stagedMigrationsDir);
                await deploy("postgres", staged.stageDir, databaseUrl);
                const ledgerBeforeSecondDeploy = await database.$queryRawUnsafe<Array<{ migration_name: string }>>(
                    `SELECT migration_name FROM "_prisma_migrations"
                     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
                );
                await deploy("postgres", staged.stageDir, databaseUrl);
                const ledgerAfterSecondDeploy = await database.$queryRawUnsafe<Array<{ migration_name: string }>>(
                    `SELECT migration_name FROM "_prisma_migrations"
                     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
                );

                expect(ledgerAfterSecondDeploy).toEqual(ledgerBeforeSecondDeploy);
                if (frontier === "released-v0.2.12") {
                    await expectWorkflowUpgradeStorage("postgres", database);
                }
                if (!hasQuotaBeforeUpgrade) {
                    expect(await database.$queryRawUnsafe("SELECT \"accountId\", \"sessionId\", \"lastViewedSessionSeq\", \"unreadSince\" FROM \"AccountSessionReadState\" ORDER BY \"sessionId\"")).toEqual([
                        { accountId: "read-owner", sessionId: "read-never", lastViewedSessionSeq: 0, unreadSince: null },
                        { accountId: "read-owner", sessionId: "read-unread", lastViewedSessionSeq: 2, unreadSince: new Date("2026-08-01T00:00:00.000Z") },
                    ]);
                    await database.$executeRawUnsafe(`UPDATE "Session" SET "lastViewedSessionSeq" = 4, "unreadSince" = NULL WHERE "id" = 'read-unread'`);
                    await expect(database.$queryRawUnsafe(`SELECT "lastViewedSessionSeq" FROM "AccountSessionReadState" WHERE "accountId" = 'read-owner' AND "sessionId" = 'read-unread'`))
                        .resolves.toEqual([{ lastViewedSessionSeq: 2 }]);
                }
                const quotaRows = await database.$queryRawUnsafe(
                    `SELECT "id", "status", encode("snapshot", 'hex') AS "snapshotHex"
                     FROM "ServiceAccountQuotaSnapshot" WHERE "id" = 'preserved-quota-row'`,
                );
                expect(quotaRows).toEqual([]);
                await expect(database.$queryRawUnsafe(
                    `SELECT indexname FROM pg_indexes
                     WHERE schemaname = current_schema()
                       AND indexname = 'Session_accountId_needsAttention_meaningfulActivityAt_id_idx'`,
                )).resolves.toHaveLength(1);
                await expect(database.$queryRawUnsafe<Array<{ column_name: string }>>(
                    `SELECT column_name FROM information_schema.columns
                     WHERE table_schema = current_schema()
                       AND table_name = 'Session'
                       AND column_name IN ('lastViewedSessionSeq', 'unreadSince', 'needsAttention')`,
                )).resolves.toHaveLength(3);
                await expectPostgresMachinePoolContract(database);
            } finally {
                await database.$disconnect();
                await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
                await admin.$disconnect();
            }
        },
        240_000,
    );

    const mysqlUrl = providerDatabaseUrl("mysql");
    const mysqlTest = mysqlUrl ? it : it.skip;
    mysqlTest(
        `upgrades MySQL twice without losing supported predecessor state and enforces Machine Pool storage${
            mysqlUrl ? "" : " [skipped: HAPPIER_TEST_MYSQL_DATABASE_URL is absent]"
        }`,
        async () => {
            if (!mysqlUrl) return;
            const databaseName = `lane02_lineage_${randomUUID().replace(/-/gu, "")}`;
            const admin = await createDbMaintenanceClient("mysql", mysqlUrl);
            const databaseUrl = mysqlDatabaseUrl(mysqlUrl, databaseName);
            const database = await createDbMaintenanceClient("mysql", databaseUrl);
            const staged = await createStagedPredecessor("mysql", frontier);
            temporaryPaths.push(staged.stageDir);
            try {
                await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\``);
                await deploy("mysql", staged.stageDir, databaseUrl);
                const predecessorQuotaTables = await database.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
                    `SELECT TABLE_NAME FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = DATABASE()
                       AND TABLE_NAME = 'ServiceAccountQuotaSnapshot'`,
                );
                expect(predecessorQuotaTables).toHaveLength(hasQuotaBeforeUpgrade ? 1 : 0);
                if (hasQuotaBeforeUpgrade) {
                    await database.$executeRawUnsafe(
                        "INSERT INTO `Account` (`id`, `publicKey`, `updatedAt`) VALUES (?, ?, CURRENT_TIMESTAMP(3))",
                        "preserved-quota-account",
                        "preserved-quota-public-key",
                    );
                    await database.$executeRawUnsafe(
                        `INSERT INTO \`ServiceAccountQuotaSnapshot\`
                            (\`id\`, \`accountId\`, \`vendor\`, \`profileId\`, \`snapshot\`, \`status\`, \`updatedAt\`)
                         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
                        "preserved-quota-row",
                        "preserved-quota-account",
                        "anthropic",
                        "default",
                        Buffer.from("sealed-preserved-quota"),
                        "ok",
                    );
                } else {
                    await expect(database.$queryRawUnsafe(
                        `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
                         WHERE TABLE_SCHEMA = DATABASE()
                           AND TABLE_NAME = 'Session'
                           AND INDEX_NAME = 'Session_accountId_needsAttention_meaningfulActivityAt_id_idx'`,
                    )).resolves.toHaveLength(1);
                }

                if (!hasQuotaBeforeUpgrade) {
                    // The pinned predecessor owns these shared fields; no recipient baseline is attributable.
                    await database.$executeRawUnsafe("INSERT INTO `Account` (`id`, `publicKey`, `updatedAt`) VALUES ('read-owner', 'read-owner-key', CURRENT_TIMESTAMP), ('read-recipient', 'read-recipient-key', CURRENT_TIMESTAMP)");
                    await database.$executeRawUnsafe("INSERT INTO `Session` (`id`, `tag`, `accountId`, `metadata`, `updatedAt`, `seq`, `lastViewedSessionSeq`, `unreadSince`) VALUES ('read-never', 'read-never', 'read-owner', '{}', CURRENT_TIMESTAMP, 5, NULL, NULL), ('read-unread', 'read-unread', 'read-owner', '{}', CURRENT_TIMESTAMP, 5, 2, '2026-08-01 00:00:00')");
                }
                if (frontier === "released-v0.2.12") {
                    await seedReleasedAutomation("mysql", database);
                }

                await replacePredecessorWithCurrentMigrations("mysql", staged.stagedMigrationsDir);
                await deploy("mysql", staged.stageDir, databaseUrl);
                const ledgerBeforeSecondDeploy = await database.$queryRawUnsafe<Array<{ migration_name: string }>>(
                    "SELECT `migration_name` FROM `_prisma_migrations` WHERE `finished_at` IS NOT NULL AND `rolled_back_at` IS NULL ORDER BY `migration_name`",
                );
                await deploy("mysql", staged.stageDir, databaseUrl);
                const ledgerAfterSecondDeploy = await database.$queryRawUnsafe<Array<{ migration_name: string }>>(
                    "SELECT `migration_name` FROM `_prisma_migrations` WHERE `finished_at` IS NOT NULL AND `rolled_back_at` IS NULL ORDER BY `migration_name`",
                );

                expect(ledgerAfterSecondDeploy).toEqual(ledgerBeforeSecondDeploy);
                if (frontier === "released-v0.2.12") {
                    await expectWorkflowUpgradeStorage("mysql", database);
                }
                if (!hasQuotaBeforeUpgrade) {
                    expect(await database.$queryRawUnsafe("SELECT `accountId`, `sessionId`, `lastViewedSessionSeq`, `unreadSince` FROM `AccountSessionReadState` ORDER BY `sessionId`")).toEqual([
                        { accountId: "read-owner", sessionId: "read-never", lastViewedSessionSeq: 0, unreadSince: null },
                        { accountId: "read-owner", sessionId: "read-unread", lastViewedSessionSeq: 2, unreadSince: new Date("2026-08-01T00:00:00.000Z") },
                    ]);
                    await database.$executeRawUnsafe("UPDATE `Session` SET `lastViewedSessionSeq` = 4, `unreadSince` = NULL WHERE `id` = 'read-unread'");
                    await expect(database.$queryRawUnsafe("SELECT `lastViewedSessionSeq` FROM `AccountSessionReadState` WHERE `accountId` = 'read-owner' AND `sessionId` = 'read-unread'"))
                        .resolves.toEqual([{ lastViewedSessionSeq: 2 }]);
                }

                const quotaRows = await database.$queryRawUnsafe(
                    "SELECT `id`, `status`, LOWER(HEX(`snapshot`)) AS `snapshotHex` FROM `ServiceAccountQuotaSnapshot` WHERE `id` = 'preserved-quota-row'",
                );
                expect(quotaRows).toEqual([]);
                await expect(database.$queryRawUnsafe(
                    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
                     WHERE TABLE_SCHEMA = DATABASE()
                       AND TABLE_NAME = 'Session'
                       AND INDEX_NAME = 'Session_accountId_needsAttention_meaningfulActivityAt_id_idx'`,
                )).resolves.toHaveLength(1);
                await expect(database.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
                    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE()
                       AND TABLE_NAME = 'Session'
                       AND COLUMN_NAME IN ('lastViewedSessionSeq', 'unreadSince', 'needsAttention')`,
                )).resolves.toHaveLength(3);
                await expectMysqlMachinePoolContract(database);
            } finally {
                await database.$disconnect();
                await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
                await admin.$disconnect();
            }
        },
        240_000,
    );
});
