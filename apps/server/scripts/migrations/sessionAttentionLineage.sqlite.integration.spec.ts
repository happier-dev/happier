import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/sqlite-client/index.js";
import { applySqliteMigrations } from "../prismaMigrations";

const serverRoot = join(import.meta.dirname, "..", "..");
const sqliteMigrationsRoot = join(serverRoot, "prisma", "sqlite", "migrations");
const quotaDropId = "20260630223000_drop_service_account_quota_snapshots";
const releasedPredecessorLastId = "20260326130000_add_pending_queue_seq";
const latestReleasedPredecessorLastId = "20260902120000_add_pending_activation_authorization";
// Immutable server-v0.2.1 at 4913c1e533c872a0712ba1c25b3104fd470aacc2
// ends at `releasedPredecessorLastId`. The current predecessor owns the quota
// DROP on its independent line. The exact released DROP remains in 0.3 and is
// copied from the canonical migration below.
// Immutable server-v0.2.12 at a357c65536ba89669422977d6f7daf9aa0d17e73
// ends at `latestReleasedPredecessorLastId`; every included SQLite SQL file is
// byte-identical to the retained current migration with the same identity.
// Current predecessor basis: ../0.2 at ac30c50856abd2265c14459e77ee3384da1698ad
// (branch `dev`, clean).
// Its relevant migration tree is clean through 20260907190000. The aggregate hashes below pin
// every migration ID and SQL byte so this fixture cannot silently borrow changed 0.3 history.
const currentPredecessorLaterIds = [
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
    "released-v0.2.1": "e8727e472791d7de236f2cfa1ef7e8da7c179cbc97c3e137df2eb00b3b9873e5",
    "released-v0.2.12": "22a64155dbbc987ebb8bb1fbfbcf1f82fad8065bb37c935fd5c03e953f458227",
    "current-0.2": "0890d61c09138618af0fa2d1a1152cea38a349fbe8fae2c1b7bc11807be3b6e5",
} as const;
type PredecessorFrontier = "released-v0.2.1" | "released-v0.2.12" | "current-0.2";
const workflowEnvelopeFixture = JSON.stringify({
    t: "plain",
    v: "workflow-envelope-".repeat(40),
});

async function copyMigration(sourceId: string, targetRoot: string): Promise<void> {
    await cp(join(sqliteMigrationsRoot, sourceId), join(targetRoot, sourceId), {
        recursive: true,
    });
}

async function listCurrentMigrationIds(): Promise<string[]> {
    return (await readdir(sqliteMigrationsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

async function preparePredecessorLedger(
    migrationsDir: string,
    frontier: PredecessorFrontier,
): Promise<string[]> {
    const predecessorMigrationIds = (await listCurrentMigrationIds())
        .filter((id) => id <= releasedPredecessorLastId);
    for (const id of predecessorMigrationIds) {
        await copyMigration(id, migrationsDir);
    }
    if (frontier === "released-v0.2.1") return predecessorMigrationIds;

    const laterIds = frontier === "released-v0.2.12"
        ? currentPredecessorLaterIds.filter((id) => id <= latestReleasedPredecessorLastId)
        : currentPredecessorLaterIds;
    for (const id of laterIds) {
        await copyMigration(id, migrationsDir);
    }
    return [...predecessorMigrationIds, ...laterIds].sort((left, right) => left.localeCompare(right));
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

async function appendCurrentMigrations(
    migrationsDir: string,
    frontier: PredecessorFrontier,
): Promise<string[]> {
    await rm(join(migrationsDir, quotaDropId), { recursive: true, force: true });
    const currentMigrationIds = await listCurrentMigrationIds();
    for (const id of currentMigrationIds) {
        await copyMigration(id, migrationsDir);
    }
    const predecessorIds = currentMigrationIds.filter((id) => id <= releasedPredecessorLastId);
    if (frontier !== "released-v0.2.1") {
        predecessorIds.push(...(frontier === "released-v0.2.12"
            ? currentPredecessorLaterIds.filter((id) => id <= latestReleasedPredecessorLastId)
            : currentPredecessorLaterIds));
    }
    const predecessorIdSet = new Set(predecessorIds);
    return currentMigrationIds.filter((id) => !predecessorIdSet.has(id));
}

async function seedReleasedQuotaRow(databasePath: string): Promise<void> {
    const database = new DatabaseSync(databasePath);
    try {
        database.prepare('INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)')
            .run("preserved-quota-account", "preserved-quota-public-key");
        database.prepare(`
            INSERT INTO "ServiceAccountQuotaSnapshot" (
                "id", "accountId", "vendor", "profileId", "snapshot", "status",
                "fetchedAt", "staleAfterMs", "metadata", "updatedAt"
            ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            "preserved-quota-row",
            "preserved-quota-account",
            "anthropic",
            "default",
            new TextEncoder().encode("sealed-preserved-quota"),
            "ok",
            60_000,
            JSON.stringify({ v: 1, format: "account_scoped_v1" }),
        );
    } finally {
        database.close();
    }
}

describe("SQLite 0.2 migration lineage before Account Directory", () => {
    const temporaryPaths: string[] = [];

    afterEach(async () => {
        await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    async function createPredecessorDatabase(frontier: PredecessorFrontier): Promise<Readonly<{
        databasePath: string;
        migrationsDir: string;
    }>> {
        const migrationsDir = await mkdtemp(join(tmpdir(), "happier-account-directory-lineage-migrations-"));
        const dataDir = await mkdtemp(join(tmpdir(), "happier-account-directory-lineage-db-"));
        temporaryPaths.push(migrationsDir, dataDir);
        const databasePath = join(dataDir, "lineage.sqlite");

        const predecessorMigrationIds = await preparePredecessorLedger(migrationsDir, frontier);
        expect(await digestMigrationSql(migrationsDir, predecessorMigrationIds)).toBe(predecessorSqlDigests[frontier]);
        const predecessorResult = await applySqliteMigrations({ databasePath, migrationsDir });
        expect(predecessorResult.applied).toEqual(predecessorMigrationIds);

        const predecessor = new DatabaseSync(databasePath);
        try {
            const quotaTable =
                predecessor.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
                    .get("ServiceAccountQuotaSnapshot");
            if (frontier === "released-v0.2.1") {
                expect(quotaTable).toEqual({ name: "ServiceAccountQuotaSnapshot" });
            } else {
                expect(quotaTable).toBeUndefined();
            }
        } finally {
            predecessor.close();
        }

        return { databasePath, migrationsDir };
    }

    it("upgrades retained three-field Session pins to list-only without changing their saved identity or order", async () => {
        const pinMigration = "20261008130000_add_session_pin_surfaces";
        const migrationsDir = await mkdtemp(join(tmpdir(), "happier-pin-surfaces-migrations-"));
        const dataDir = await mkdtemp(join(tmpdir(), "happier-pin-surfaces-db-"));
        temporaryPaths.push(migrationsDir, dataDir);
        const databasePath = join(dataDir, "pins.sqlite");
        for (const id of await listCurrentMigrationIds()) {
            if (id < pinMigration) await copyMigration(id, migrationsDir);
        }
        await applySqliteMigrations({ databasePath, migrationsDir });
        const database = new DatabaseSync(databasePath);
        try {
            database.exec(`INSERT INTO "Account" ("id", "publicKey", "updatedAt")
                VALUES ('pin-account', 'pin-public-key', CURRENT_TIMESTAMP);
                INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
                VALUES ('pin-session', 'pin-session-tag', 'pin-account', '{}', CURRENT_TIMESTAMP);
                INSERT INTO "SessionPin" ("id", "accountId", "sessionId", "sortKey", "pinnedAt", "updatedAt")
                VALUES ('retained-pin', 'pin-account', 'pin-session', 'saved-rank', 1234, CURRENT_TIMESTAMP);`);
            expect(database.prepare('PRAGMA table_info("SessionPin")').all().map((column) => column.name))
                .not.toContain("railPinned");
            await copyMigration(pinMigration, migrationsDir);
            await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [pinMigration] });
            await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [] });
            expect(database.prepare('SELECT "id", "sessionId", "sortKey", "pinnedAt", "listPinned", "railPinned" FROM "SessionPin"').all())
                .toEqual([{ id: "retained-pin", sessionId: "pin-session", sortKey: "saved-rank", pinnedAt: 1234, listPinned: 1, railPinned: 0 }]);
            expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
            expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("backfills owner Session and current Discussion tracking baselines without enrolling recipients", async () => {
        const migrationsDir = await mkdtemp(join(tmpdir(), "happier-private-read-migrations-"));
        const dataDir = await mkdtemp(join(tmpdir(), "happier-private-read-db-"));
        temporaryPaths.push(migrationsDir, dataDir);
        const databasePath = join(dataDir, "read.sqlite");
        const readMigration = "20260905235000_add_account_session_read_state";
        for (const id of await listCurrentMigrationIds()) {
            if (id < readMigration) await copyMigration(id, migrationsDir);
        }
        await applySqliteMigrations({ databasePath, migrationsDir });
        const database = new DatabaseSync(databasePath);
        try {
            database.exec(`INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES
                ('owner', 'owner-key', CURRENT_TIMESTAMP), ('recipient', 'recipient-key', CURRENT_TIMESTAMP)`);
            const insert = database.prepare(`INSERT INTO "Session"
                ("id", "tag", "accountId", "metadata", "updatedAt", "seq", "lastViewedSessionSeq", "unreadSince",
                 "currentStorageState", "acceptedThroughServerSeq", "materializationPublicationId", "materializedThroughSourceAt", "publishedThroughServerSeq")
                VALUES (?, ?, 'owner', '{}', CURRENT_TIMESTAMP, 5, ?, ?, ?, ?, ?, ?, ?)`);
            insert.run('never', 'never', null, null, 'hosted', null, null, null, null);
            insert.run('unread', 'unread', 2, 1234, 'hosted', null, null, null, null);
            insert.run('caught', 'caught', 8, 1234, 'hosted', null, null, null, null);
            insert.run('partial', 'partial', 5, 1234, 'server_partial', 3, null, null, null);
            insert.run('snapshot', 'snapshot', 5, 1234, 'snapshot_complete', null, 'publication', 1000, 4);
            insert.run('unpublished', 'unpublished', 5, 1234, 'snapshot_complete', null, null, null, 4);
            database.exec(`INSERT INTO "SessionDiscussion"
                ("id", "sessionId", "creationLocalId", "creationEqualityEvidenceV1", "createdByAccountId",
                 "titleContent", "messageSeq", "lastMessageAt", "updatedAt") VALUES
                ('discussion-unread-a', 'unread', 'create-unread-a', '{}', 'owner', '{}', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                ('discussion-unread-b', 'unread', 'create-unread-b', '{}', 'owner', '{}', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
            await copyMigration(readMigration, migrationsDir);
            await applySqliteMigrations({ databasePath, migrationsDir });
            expect(database.prepare('SELECT "accountId", "sessionId", "lastViewedSessionSeq", "unreadSince" FROM "AccountSessionReadState" ORDER BY "sessionId"').all()).toEqual([
                { accountId: 'owner', sessionId: 'caught', lastViewedSessionSeq: 5, unreadSince: null },
                { accountId: 'owner', sessionId: 'never', lastViewedSessionSeq: 0, unreadSince: null },
                { accountId: 'owner', sessionId: 'partial', lastViewedSessionSeq: 3, unreadSince: null },
                { accountId: 'owner', sessionId: 'snapshot', lastViewedSessionSeq: 4, unreadSince: null },
                { accountId: 'owner', sessionId: 'unpublished', lastViewedSessionSeq: 0, unreadSince: null },
                { accountId: 'owner', sessionId: 'unread', lastViewedSessionSeq: 2, unreadSince: 1234 },
            ]);
            expect(database.prepare('SELECT "discussionId", "accountId", "lastReadSeq" FROM "SessionDiscussionReadState" ORDER BY "discussionId"').all()).toEqual([
                { discussionId: 'discussion-unread-a', accountId: 'owner', lastReadSeq: 3 },
                { discussionId: 'discussion-unread-b', accountId: 'owner', lastReadSeq: 7 },
            ]);
            expect(database.prepare('SELECT COUNT(*) AS "count" FROM "SessionDiscussionReadState" WHERE "accountId" = ?').get('recipient')).toEqual({ count: 0 });
            await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [] });
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        } finally {
            database.close();
        }
    });

    it("recreates quota storage after the current 0.2 DROP and deploys current migrations twice", async () => {
        const { databasePath, migrationsDir } = await createPredecessorDatabase("current-0.2");
        const predecessor = new DatabaseSync(databasePath);
        try {
            predecessor.exec(`
                INSERT INTO "Account" ("id", "publicKey", "updatedAt")
                VALUES ('read-owner', 'read-owner-key', CURRENT_TIMESTAMP);
                INSERT INTO "Session" (
                    "id", "tag", "accountId", "metadata", "updatedAt", "seq",
                    "lastViewedSessionSeq", "unreadSince"
                ) VALUES (
                    'read-session', 'read-session', 'read-owner', '{}', CURRENT_TIMESTAMP,
                    5, 2, 1000
                );
            `);
        } finally {
            predecessor.close();
        }
        const currentMigrationIds = await appendCurrentMigrations(migrationsDir, "current-0.2");

        await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({
            applied: currentMigrationIds,
        });
        await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [] });

        const deployed = new DatabaseSync(databasePath);
        try {
            const sessionSql = deployed
                .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'Session'")
                .get() as { sql?: string } | undefined;
            expect(sessionSql?.sql).toContain('"lastViewedSessionSeq"');
            expect(sessionSql?.sql).toContain('"unreadSince"');
            expect(sessionSql?.sql).toContain('"needsAttention"');
            expect(deployed.prepare(
                "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?",
            ).get("Session_accountId_needsAttention_meaningfulActivityAt_id_idx")).toEqual({
                name: "Session_accountId_needsAttention_meaningfulActivityAt_id_idx",
            });
            expect(deployed.prepare(`
                SELECT "lastViewedSessionSeq" FROM "AccountSessionReadState"
                WHERE "accountId" = 'read-owner' AND "sessionId" = 'read-session'
            `).get()).toEqual({ lastViewedSessionSeq: 2 });
            deployed.exec(`
                UPDATE "Session" SET "lastViewedSessionSeq" = 4, "unreadSince" = NULL
                WHERE "id" = 'read-session'
            `);
            expect(deployed.prepare(`
                SELECT "lastViewedSessionSeq" FROM "AccountSessionReadState"
                WHERE "accountId" = 'read-owner' AND "sessionId" = 'read-session'
            `).get()).toEqual({ lastViewedSessionSeq: 2 });
        } finally {
            deployed.close();
        }

        const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
        try {
            const account = await prisma.account.create({
                data: { publicKey: "quota-compatibility-query-account" },
                select: { id: true },
            });
            await prisma.serviceAccountQuotaSnapshot.create({
                data: {
                    accountId: account.id,
                    vendor: "anthropic",
                    profileId: "default",
                    snapshot: new TextEncoder().encode("sealed-quota"),
                    status: "ok",
                },
            });
            await expect(prisma.serviceAccountQuotaSnapshot.findUnique({
                where: {
                    accountId_vendor_profileId: {
                        accountId: account.id,
                        vendor: "anthropic",
                        profileId: "default",
                    },
                },
                select: { snapshot: true, status: true },
            })).resolves.toEqual({
                snapshot: new TextEncoder().encode("sealed-quota"),
                status: "ok",
            });
        } finally {
            await prisma.$disconnect();
        }
    });

    it("upgrades the exact immutable server-v0.2.12 SQLite lineage twice and preserves current storage contracts", async () => {
        const { databasePath, migrationsDir } = await createPredecessorDatabase("released-v0.2.12");

        const predecessor = new DatabaseSync(databasePath);
        try {
            predecessor.exec(`
                INSERT INTO "Account" ("id", "publicKey", "updatedAt")
                VALUES ('released-account', 'released-account-key', CURRENT_TIMESTAMP);
                INSERT INTO "Session" (
                    "id", "tag", "accountId", "metadata", "updatedAt", "seq",
                    "lastViewedSessionSeq", "unreadSince"
                ) VALUES (
                    'released-session', 'released-session', 'released-account', '{}', CURRENT_TIMESTAMP,
                    5, 2, 1000
                );
                INSERT INTO "Automation" (
                    "id", "accountId", "name", "scheduleKind", "targetType",
                    "templateCiphertext", "updatedAt"
                ) VALUES (
                    'workflow-predecessor-automation', 'released-account', 'Released automation',
                    'manual', 'new_session', 'sealed-template', CURRENT_TIMESTAMP
                );
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES (
                    'workflow-predecessor-run', 'workflow-predecessor-automation', 'released-account',
                    'succeeded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            `);
        } finally {
            predecessor.close();
        }

        const currentMigrationIds = await appendCurrentMigrations(migrationsDir, "released-v0.2.12");
        await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({
            applied: currentMigrationIds,
        });
        await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [] });

        const deployed = new DatabaseSync(databasePath);
        try {
            deployed.prepare(`
                UPDATE "AutomationRun"
                SET "workflowAcceptedSnapshotEnvelope" = ?, "workflowCheckpointEnvelope" = ?,
                    "workflowCustodyState" = 'pending'
                WHERE "id" = 'workflow-predecessor-run'
            `).run(workflowEnvelopeFixture, workflowEnvelopeFixture);
            deployed.prepare(`
                INSERT INTO "WorkflowRunInvocation" (
                    "id", "runId", "sequence", "memberOrdinal", "contentEnvelope", "updatedAt"
                ) VALUES ('workflow-predecessor-invocation', 'workflow-predecessor-run', 0, 0, ?, CURRENT_TIMESTAMP)
            `).run(workflowEnvelopeFixture);
            expect(deployed.prepare(`
                SELECT "originKind", "automationId",
                       length("workflowAcceptedSnapshotEnvelope") AS "acceptedLength",
                       length("workflowCheckpointEnvelope") AS "checkpointLength"
                FROM "AutomationRun" WHERE "id" = 'workflow-predecessor-run'
            `).get()).toEqual({
                originKind: "automation",
                automationId: "workflow-predecessor-automation",
                acceptedLength: workflowEnvelopeFixture.length,
                checkpointLength: workflowEnvelopeFixture.length,
            });
            expect(deployed.prepare(`
                SELECT length("contentEnvelope") AS "contentLength"
                FROM "WorkflowRunInvocation" WHERE "id" = 'workflow-predecessor-invocation'
            `).get()).toEqual({ contentLength: workflowEnvelopeFixture.length });
            expect(deployed.prepare('SELECT "publicKey" FROM "Account" WHERE "id" = ?')
                .get("released-account")).toEqual({ publicKey: "released-account-key" });
            expect(deployed.prepare(`
                SELECT "lastViewedSessionSeq" FROM "AccountSessionReadState"
                WHERE "accountId" = ? AND "sessionId" = ?
            `).get("released-account", "released-session")).toEqual({ lastViewedSessionSeq: 2 });

            expect(deployed.prepare(`
                SELECT name FROM sqlite_schema
                WHERE type = 'table' AND name = 'ServiceAccountQuotaSnapshot'
            `).get()).toEqual({ name: "ServiceAccountQuotaSnapshot" });
            expect(deployed.prepare('SELECT COUNT(*) AS "count" FROM "ServiceAccountQuotaSnapshot"').get())
                .toEqual({ count: 0 });
            expect(deployed.prepare('PRAGMA table_info("ServiceAccountQuotaSnapshot")').all()
                .map((column) => (column as { name: string }).name)).toEqual([
                "id",
                "accountId",
                "vendor",
                "profileId",
                "snapshot",
                "status",
                "fetchedAt",
                "staleAfterMs",
                "metadata",
                "createdAt",
                "updatedAt",
            ]);
            expect(deployed.prepare(`
                SELECT name FROM sqlite_schema
                WHERE type = 'index' AND tbl_name = 'ServiceAccountQuotaSnapshot'
                ORDER BY name
            `).all()).toEqual([
                { name: "ServiceAccountQuotaSnapshot_accountId_idx" },
                { name: "ServiceAccountQuotaSnapshot_accountId_vendor_profileId_key" },
                { name: "sqlite_autoindex_ServiceAccountQuotaSnapshot_1" },
            ]);
            expect(deployed.prepare('PRAGMA foreign_key_list("ServiceAccountQuotaSnapshot")').all())
                .toEqual([expect.objectContaining({
                    table: "Account",
                    from: "accountId",
                    to: "id",
                    on_update: "CASCADE",
                    on_delete: "CASCADE",
                })]);

            const ledger = deployed.prepare(`
                SELECT "migration_name", "checksum" FROM "_prisma_migrations"
                WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
                ORDER BY "migration_name"
            `).all() as Array<{ migration_name: string; checksum: string }>;
            expect(ledger.map((row) => row.migration_name)).toEqual(await listCurrentMigrationIds());
            for (const row of ledger) {
                expect(row.checksum).toBe(createHash("sha256")
                    .update(await readFile(join(migrationsDir, row.migration_name, "migration.sql"), "utf8"))
                    .digest("hex"));
            }
            expect(deployed.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
            expect(deployed.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            deployed.close();
        }
    });

    it("applies the released quota DROP after 0.2.1 and recreates empty storage across two current deploys", async () => {
        const { databasePath, migrationsDir } = await createPredecessorDatabase("released-v0.2.1");
        await seedReleasedQuotaRow(databasePath);
        await appendCurrentMigrations(migrationsDir, "released-v0.2.1");

        await applySqliteMigrations({ databasePath, migrationsDir });
        await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [] });

        const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
        try {
            await expect(prisma.serviceAccountQuotaSnapshot.findUnique({
                where: {
                    accountId_vendor_profileId: {
                        accountId: "preserved-quota-account",
                        vendor: "anthropic",
                        profileId: "default",
                    },
                },
                select: { id: true, snapshot: true, status: true },
            })).resolves.toBeNull();
        } finally {
            await prisma.$disconnect();
        }
    });
});
