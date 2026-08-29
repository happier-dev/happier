import { access, readFile, readdir } from "node:fs/promises";
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
    "20260701123000_add_session_runtime_activity_projection",
    "20260723210000_drop_public_share_blocked_users",
    "20260723220000_add_connected_service_auth_group_runtime_state_revision",
] as const;

const supersededMigrationIds = [
    "20260630223000_drop_service_account_quota_snapshots",
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

const retainedDevMigrationIds = [
    "20260410103000_add_usage_event",
    "20260503170000_add_account_live_activity_target",
    "20260606090000_add_review_comments",
    "20260606103000_add_plugin_permission_grants",
    "20260629103000_add_voice_lease_provider_binding",
    "20260713210000_add_session_subagent_custody",
    "20260725100000_activate_qualified_connected_accounts_v4",
    "20260725110000_reconcile_predecessor_migration_lineage",
] as const;

const supersededDevMigrationIds = [
    "20260410232500_add_usage_event_cost_metadata",
    "20260411080000_add_usage_event_idempotency_key",
    "20260607120500_add_plugin_permission_grant_active_identity_key",
    "20260607150000_add_plugin_permission_grant_authority_source",
    "20260607153000_add_plugin_permission_grant_request_active_identity_key",
    "20260629110000_add_voice_lease_provider_binding_nonce",
    "20260629111000_normalize_voice_lease_binding_index",
    "20260703070000_rename_account_live_activity_target_lookup_index",
    "20260703071000_rename_compact_runtime_indexes",
    "20260709100000_normalize_provider_account_usage_identifiers",
    "20260709101000_normalize_compact_runtime_indexes",
    "20260710120000_rename_agent_columns_to_agent_id",
    "20260710150000_rename_agent_turn_columns",
    "20260711100000_add_usage_event_cost_breakdown",
    "20260713090000_add_review_comment_create_idempotency",
    "20260713233000_add_session_subagent_custody_retirement",
    "20260714013000_add_qualified_connected_account_projections",
    "20260715140000_contract_qualified_connected_account_identity",
    "20260721133000_finalize_pending_requested_action",
    "20260724200000_prepare_qualified_connected_accounts_v4",
    "20260724202000_contract_qualified_connected_account_projection",
    "20260725103000_normalize_predecessor_mysql_schema",
] as const;

const consolidatedAuthMigrationId = "20260822150000_auth_hardening_and_api_tokens";

const supersededAuthMigrationIds = [
    "20260822150000_add_key_challenge_v2",
    "20260822160000_add_account_token_epoch",
    "20260822170000_add_account_api_tokens",
] as const;

const consolidatedAutomationMigrationId = "20260816231000_add_event_automations_v1";
const automationAccountSettingsMigrationId = "20260825130000_add_automation_account_settings";
const supersededAutomationMigrationIds = [
    "20260816233000_backfill_automation_execution_dispatch_state",
    "20260825130000_add_automation_account_settings_and_run_compaction",
    "20260829000000_add_automation_claim_currentness_witness",
] as const;

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

    it.each(providerRoots)("preserves released quota snapshots for bounded V2 reads in %s", async (providerRoot) => {
        const migrationRoot = join(serverRoot, providerRoot);
        const migrationIds = await readdir(migrationRoot);
        const sqlPaths = migrationIds.map((migrationId) =>
            join(migrationRoot, migrationId, "migration.sql")
        );
        const sql = (await Promise.all(
            sqlPaths.map(async (path) =>
                await exists(path) ? await readFile(path, "utf8") : null
            ),
        )).filter((value): value is string => value !== null);
        expect(sql.some((value) => /DROP TABLE\s+(?:IF EXISTS\s+)?["`]?ServiceAccountQuotaSnapshot["`]?/i.test(value))).toBe(false);
        expect(await migrationSql(providerRoot, "20260216143000_connected_services_quota_snapshots"))
            .toContain("ServiceAccountQuotaSnapshot");
    });

    it.each(providerRoots)("contracts Dev-only draft chains into their final transition owners for %s", async (providerRoot) => {
        for (const migrationId of retainedDevMigrationIds) {
            expect(
                await exists(join(serverRoot, providerRoot, migrationId, "migration.sql")),
                `missing retained Dev migration ${providerRoot}/${migrationId}`,
            ).toBe(true);
        }
        for (const migrationId of supersededDevMigrationIds) {
            expect(
                await exists(join(serverRoot, providerRoot, migrationId, "migration.sql")),
                `superseded Dev migration remains ${providerRoot}/${migrationId}`,
            ).toBe(false);
        }
    });

    it.each(providerRoots)("creates the auth hardening and API-token schema from one unreleased migration for %s", async (providerRoot) => {
        expect(
            await exists(join(serverRoot, providerRoot, consolidatedAuthMigrationId, "migration.sql")),
            `missing consolidated auth migration ${providerRoot}/${consolidatedAuthMigrationId}`,
        ).toBe(true);

        for (const migrationId of supersededAuthMigrationIds) {
            expect(
                await exists(join(serverRoot, providerRoot, migrationId)),
                `superseded auth migration remains ${providerRoot}/${migrationId}`,
            ).toBe(false);
        }

        const sql = await migrationSql(providerRoot, consolidatedAuthMigrationId);
        expect(sql).toContain("KeyChallengeV2");
        expect(sql).toContain("tokenEpoch");
        expect(sql).toContain("AccountApiToken");
        expect(sql).toContain("secretDigest");
        expect(sql).toContain("AccountApiToken_accountId_fkey");
    });

    it.each(providerRoots)(
        "keeps final Automation transitions in their folded unreleased owners for %s",
        async (providerRoot) => {
            const sql = await migrationSql(providerRoot, consolidatedAutomationMigrationId);
            expect(sql).toContain("executionDispatchState");
            expect(sql).toContain("executionAttempt");
            expect(sql).toContain("executionDispatchCommittedAt");
            expect(sql).toContain("executionDispatchDueAt");

            const accountSettingsSql = await migrationSql(providerRoot, automationAccountSettingsMigrationId);
            expect(accountSettingsSql).toContain("automationMaxActiveRunsPerMachine");
            expect(accountSettingsSql).toContain("automationRunRetention");
            expect(accountSettingsSql).not.toContain("contentRemovedAt");

            for (const migrationId of supersededAutomationMigrationIds) {
                expect(
                    await exists(join(serverRoot, providerRoot, migrationId)),
                    `superseded Automation migration remains ${providerRoot}/${migrationId}`,
                ).toBe(false);
            }
        },
    );

    it.each(providerRoots)("creates the final Dev models directly for %s", async (providerRoot) => {
        const usageSql = await migrationSql(providerRoot, "20260410103000_add_usage_event");
        expect(usageSql).toContain("agentId");
        expect(usageSql).toContain("invoiceCostUsd");
        expect(usageSql).toContain("idempotencyKey");
        expect(usageSql).toContain("costBreakdown");
        expect(usageSql).not.toContain("providerId");

        const liveActivitySql = await migrationSql(providerRoot, "20260503170000_add_account_live_activity_target");
        expect(liveActivitySql).toContain("AccountLiveActivityTarget_lookup_active_idx");

        const reviewSql = await migrationSql(providerRoot, "20260606090000_add_review_comments");
        expect(reviewSql).toContain("create_client_mutation_id");
        expect(reviewSql).toContain("review_comments_account_create_mutation_key");

        const pluginGrantSql = await migrationSql(providerRoot, "20260606103000_add_plugin_permission_grants");
        expect(pluginGrantSql).toContain("authority_kind");
        expect(pluginGrantSql).toContain("active_identity_key");
        expect(pluginGrantSql).toContain("plugin_permission_requests_active_identity_key");
        expect(pluginGrantSql.match(/["`]subject_json["`]\s+(?:LONG)?TEXT(?:\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_bin)?\s+NOT NULL/gu))
            .toHaveLength(3);
        expect(pluginGrantSql).not.toContain("plugin-permission-active-identity-migration");
        expect(pluginGrantSql).not.toMatch(/ROW_NUMBER\(\)\s+OVER/iu);
        expect(pluginGrantSql).not.toMatch(/(?:CHAR|CHR)\(31\)/u);
        expect(pluginGrantSql).not.toMatch(/UPDATE\s+["`]plugin_permission_grants["`]/iu);

        const voiceSql = await migrationSql(providerRoot, "20260629103000_add_voice_lease_provider_binding");
        expect(voiceSql).toContain("providerBindingNonce");
        expect(voiceSql).not.toContain("providerId_providerConversationId_key");

        const custodySql = await migrationSql(providerRoot, "20260713210000_add_session_subagent_custody");
        expect(custodySql).toContain("immutableGenerationId");
        expect(custodySql).toContain("SessionSubagentCustodyRetiredGeneration");
    });

    it("creates MySQL plugin-permission indexes within the InnoDB key limit at their owning statements", async () => {
        const sql = await migrationSql(
            "prisma/mysql/migrations",
            "20260606103000_add_plugin_permission_grants",
        );
        expect(sql.match(/`subject_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/gu))
            .toHaveLength(3);
        const boundedInitialScopeIndex = [
            "`account_id`(64)",
            "`plugin_id`(64)",
            "`capability`(64)",
            "`scope_kind`(64)",
            "`scope_project_id`(64)",
            "`scope_workspace_id`(64)",
            "`status`(64)",
            "`updated_at`",
        ].join(", ");
        const boundedFinalScopeIndex = [
            "`account_id`(64)",
            "`plugin_id`(64)",
            "`capability`(64)",
            "`scope_kind`(64)",
            "`scope_project_id`(64)",
            "`scope_workspace_id`(64)",
            "`authority_kind`(64)",
            "`authority_machine_id`(64)",
            "`authority_installation_id`(64)",
            "`status`(64)",
            "`updated_at`",
        ].join(", ");

        expect(sql).toContain(
            `INDEX \`plugin_permission_requests_scope_idx\`(${boundedInitialScopeIndex})`,
        );
        expect(sql).toContain(
            `INDEX \`plugin_permission_grants_scope_idx\`(${boundedInitialScopeIndex})`,
        );
        expect(sql).toContain(
            "INDEX `plugin_permission_events_kind_idx`(`account_id`(64), `plugin_id`(64), `capability`(64), `event_kind`(64), `created_at`)",
        );
        expect(sql).toContain(
            `CREATE INDEX \`plugin_permission_grants_scope_idx\`\nON \`plugin_permission_grants\`(\n    ${boundedFinalScopeIndex.replaceAll(", ", ",\n    ")}\n);`,
        );
        expect(sql).toContain(
            `CREATE INDEX \`plugin_permission_requests_scope_idx\`\nON \`plugin_permission_grant_requests\`(\n    ${boundedFinalScopeIndex.replaceAll(", ", ",\n    ")}\n);`,
        );
        expect(sql.match(/DROP INDEX `plugin_permission_grants_scope_idx`/g))
            .toHaveLength(1);
        expect(sql.match(/DROP INDEX `plugin_permission_requests_scope_idx`/g))
            .toHaveLength(1);
        expect(sql).not.toContain(
            "DROP INDEX `plugin_permission_events_kind_idx`",
        );
    });

    it("keeps qualified Connected Accounts but removes the Bun-incompatible SQLite hash UDF", async () => {
        const activationSql = await migrationSql(
            "prisma/sqlite/migrations",
            "20260725100000_activate_qualified_connected_accounts_v4",
        );
        const migrationOwner = await readFile(
            join(serverRoot, "sources/flavors/light/sqliteMigrations.ts"),
            "utf8",
        );

        expect(activationSql).toContain("happier_prepare_qualified_connected_accounts_v4");
        expect(activationSql).not.toContain("happier_sha256_hex");
        expect(migrationOwner).not.toContain("db.function(");
        expect(migrationOwner).not.toContain("happier_sha256_hex");
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
                SELECT "sourceCreatedAt", "sourceUpdatedAt",
                    "transcriptObservationProvenance", "deliveryResolution"
                FROM "SessionMessage" WHERE "id" = 'message-1'
            `).get()).toEqual({
                sourceCreatedAt: null,
                sourceUpdatedAt: null,
                transcriptObservationProvenance: null,
                deliveryResolution: null,
            });
        } finally {
            db.close();
        }
    });
});
