import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const providerRoots = [
    "prisma/migrations",
    "prisma/sqlite/migrations",
    "prisma/mysql/migrations",
] as const;

const retainedMigrationIds = [
    "20260624123000_add_pending_delivery_state",
    "20260630162000_add_provider_account_usage_records",
    "20260630170000_add_session_organization_models",
    "20260630223000_drop_service_account_quota_snapshots",
    "20260701123000_add_session_runtime_activity_projection",
    "20260723210000_drop_public_share_blocked_users",
    "20260723220000_add_connected_service_auth_group_runtime_state_revision",
] as const;

const supersededMigrationIds = [
    "20260624143000_add_session_pending_blocked_count",
    "20260709090000_drop_connected_service_usage_source_profile_unique",
    "20260711194500_add_session_runtime_activity_v2",
    "20260712141000_add_session_runtime_activity_writer_connection",
    "20260712151500_add_session_runtime_activity_owner_observation",
    "20260712183000_add_pending_delivery_attempt_v1",
    "20260713112000_add_pending_runtime_activity_unknown_episode",
    "20260713124500_replace_pending_claim_verifier",
    "20260713143000_remove_pending_runtime_incarnation",
    "20260713220000_simplify_session_runtime_activity_projection",
    "20260714183000_contract_pending_delivery_attempt_v1",
    "20260715100000_add_pending_settlement_prepare",
    "20260715183000_add_pending_dispatch_intent",
    "20260717120000_add_pending_provider_action",
    "20260717150000_finalize_session_runtime_activity_projection",
    "20260720180000_add_session_message_delivery_resolution",
    "20260721130000_contract_pending_persistence",
    "20260724160000_drop_machine_supervisor_authority",
] as const;

const sessionMessageRowRevisionMigrationId = "20260810190000_add_session_message_row_revision";

async function exists(path: string): Promise<boolean> {
    return await access(path).then(() => true, () => false);
}

async function migrationSql(providerRoot: string, migrationId: string): Promise<string> {
    return await readFile(join(serverRoot, providerRoot, migrationId, "migration.sql"), "utf8");
}

describe("unreleased migration contraction", () => {
    it.each(providerRoots)("keeps only final unreleased transition identities for %s", async (providerRoot) => {
        for (const migrationId of retainedMigrationIds) {
            expect(
                await exists(join(serverRoot, providerRoot, migrationId, "migration.sql")),
                `missing retained migration ${providerRoot}/${migrationId}`,
            ).toBe(true);
        }
        for (const migrationId of supersededMigrationIds) {
            expect(
                await exists(join(serverRoot, providerRoot, migrationId, "migration.sql")),
                `superseded migration remains ${providerRoot}/${migrationId}`,
            ).toBe(false);
        }
    });

    it.each(providerRoots)("creates the final Pending shape directly for %s", async (providerRoot) => {
        const sql = await migrationSql(providerRoot, "20260624123000_add_pending_delivery_state");
        expect(sql).toContain("pendingBlockedCount");
        expect(sql).toContain("requestedAction");
        expect(sql).toContain("providerAction");
        expect(sql).toContain("deliveryResolution");
        expect(sql).toContain("transcriptObservationProvenance");
        expect(sql).not.toMatch(/SessionPendingDeliveryAttempt|dispatchIntent|providerAcceptance|settlementNextAt|deliveryLineage/);
    });

    it.each(providerRoots)("creates only the final runtime-activity projection for %s", async (providerRoot) => {
        const sql = await migrationSql(providerRoot, "20260701123000_add_session_runtime_activity_projection");
        expect(sql).toContain("runtimeActivityState");
        expect(sql).toContain("runtimeActivityActiveCount");
        expect(sql).toContain("runtimeActivityObservedAt");
        expect(sql).toContain("runtimeActivityRevision");
        expect(sql).not.toMatch(/WriterCapability|OwnerObservation|MachineSupervisor|runtimeActivityExpiresAt|runtimeActivitySourceClass/);
    });

    it.each(providerRoots)("creates provider usage with the final non-unique profile lookup for %s", async (providerRoot) => {
        const sql = await migrationSql(providerRoot, "20260630162000_add_provider_account_usage_records");
        expect(sql).toContain("csus_account_service_profile_idx");
        expect(sql).not.toContain("ConnectedServiceUsageSource_accountId_serviceId_profileId_key");
    });

    it.each(providerRoots)("adds a private SessionMessage row revision with a zero default for %s", async (providerRoot) => {
        const sql = await migrationSql(providerRoot, sessionMessageRowRevisionMigrationId);
        expect(sql).toMatch(/\browRevision\b/);
        expect(sql).toMatch(/\bBIGINT\b/i);
        expect(sql).toMatch(/\bDEFAULT\s+0\b/i);
    });

    it("does not retain local checksum aliases in the SQLite migration owner", async () => {
        const source = await readFile(join(serverRoot, "sources/flavors/light/sqliteMigrations.ts"), "utf8");
        expect(source).not.toContain("compatibleAppliedChecksumsByMigration");
        expect(source).not.toContain("isKnownCompatibleAppliedChecksum");
    });

    it("migrates the released SQLite baseline directly while preserving existing session and pending rows", async () => {
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys=ON;
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Session" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "active" BOOLEAN NOT NULL DEFAULT true
                );
                CREATE TABLE "SessionMessage" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "sessionId" TEXT NOT NULL,
                    "localId" TEXT,
                    "sidechainId" TEXT,
                    "seq" INTEGER NOT NULL,
                    "messageRole" TEXT,
                    "content" JSONB NOT NULL,
                    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" DATETIME NOT NULL,
                    CONSTRAINT "SessionMessage_sessionId_fkey"
                        FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
                );
                CREATE TABLE "SessionPendingMessage" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "sessionId" TEXT NOT NULL,
                    "authorAccountId" TEXT,
                    "localId" TEXT NOT NULL,
                    "messageRole" TEXT,
                    "content" JSONB NOT NULL,
                    "status" TEXT NOT NULL DEFAULT 'queued',
                    "position" INTEGER NOT NULL,
                    "discardedAt" DATETIME,
                    "discardedReason" TEXT,
                    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" DATETIME NOT NULL,
                    CONSTRAINT "SessionPendingMessage_sessionId_fkey"
                        FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
                    CONSTRAINT "SessionPendingMessage_authorAccountId_fkey"
                        FOREIGN KEY ("authorAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
                );
                CREATE UNIQUE INDEX "SessionPendingMessage_sessionId_localId_key"
                    ON "SessionPendingMessage"("sessionId", "localId");
                CREATE INDEX "SessionPendingMessage_sessionId_status_position_idx"
                    ON "SessionPendingMessage"("sessionId", "status", "position");
                CREATE INDEX "SessionPendingMessage_sessionId_authorAccountId_idx"
                    ON "SessionPendingMessage"("sessionId", "authorAccountId");
                CREATE INDEX "SessionPendingMessage_sessionId_status_updatedAt_idx"
                    ON "SessionPendingMessage"("sessionId", "status", "updatedAt");

                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Session" ("id", "active") VALUES ('session-1', true);
                INSERT INTO "SessionMessage" (
                    "id", "sessionId", "localId", "seq", "content", "updatedAt"
                ) VALUES ('message-1', 'session-1', 'message-local-1', 1, '{}', CURRENT_TIMESTAMP);
                INSERT INTO "SessionPendingMessage" (
                    "id", "sessionId", "authorAccountId", "localId", "content", "position", "updatedAt"
                ) VALUES (
                    'pending-1', 'session-1', 'account-1', 'pending-local-1', '{}', 1, CURRENT_TIMESTAMP
                );
            `);

            db.exec(await migrationSql(
                "prisma/sqlite/migrations",
                "20260624123000_add_pending_delivery_state",
            ));
            db.exec(await migrationSql(
                "prisma/sqlite/migrations",
                "20260701123000_add_session_runtime_activity_projection",
            ));
            db.exec(await migrationSql(
                "prisma/sqlite/migrations",
                sessionMessageRowRevisionMigrationId,
            ));

            expect(db.prepare(`
                SELECT "active", "pendingBlockedCount", "runtimeActivityState",
                    "runtimeActivityActiveCount", "runtimeActivityObservedAt", "runtimeActivityRevision"
                FROM "Session" WHERE "id" = 'session-1'
            `).get()).toEqual({
                active: 1,
                pendingBlockedCount: 0,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 0,
            });
            expect(db.prepare(`
                SELECT "localId", "deliveryState", "deliveryBlockedReason",
                    json("requestedAction") AS "requestedAction", "providerAction"
                FROM "SessionPendingMessage" WHERE "id" = 'pending-1'
            `).get()).toEqual({
                localId: "pending-local-1",
                deliveryState: null,
                deliveryBlockedReason: null,
                requestedAction: '{"v":1,"kind":"enqueue"}',
                providerAction: null,
            });
            expect(db.prepare(`
                SELECT "sourceCreatedAt", "sourceUpdatedAt", "rowRevision",
                    "transcriptObservationProvenance", "deliveryResolution"
                FROM "SessionMessage" WHERE "id" = 'message-1'
            `).get()).toEqual({
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                rowRevision: 0,
                transcriptObservationProvenance: null,
                deliveryResolution: null,
            });
        } finally {
            db.close();
        }
    });
});
