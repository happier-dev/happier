import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
} from "../../sources/app/api/routes/connect/qualifiedConnectedAccounts/identity";

const service = {
    pluginId: "happier.agent.codex",
    localId: "openai-codex",
} as const;
const geminiService = {
    pluginId: "happier.agent.gemini",
    localId: "gemini-account",
} as const;

async function createPreparedDatabase(): Promise<PGlite> {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(`
        CREATE TABLE "Account" (
            "id" TEXT NOT NULL PRIMARY KEY
        );
        CREATE TABLE "ConnectedServiceAuthGroup" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "vendor" TEXT NOT NULL,
            "groupId" TEXT NOT NULL,
            "displayName" TEXT,
            "policyJson" TEXT NOT NULL,
            "activeProfileId" TEXT,
            "generation" INTEGER NOT NULL DEFAULT 0,
            "runtimeStateRevision" INTEGER NOT NULL DEFAULT 0,
            "stateJson" TEXT,
            "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP NOT NULL,
            CONSTRAINT "ConnectedServiceAuthGroup_accountId_fkey"
                FOREIGN KEY ("accountId") REFERENCES "Account" ("id")
                ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "ConnectedServiceAuthGroup_accountId_vendor_groupId_key"
            ON "ConnectedServiceAuthGroup"("accountId", "vendor", "groupId");
        CREATE INDEX "ConnectedServiceAuthGroup_accountId_vendor_idx"
            ON "ConnectedServiceAuthGroup"("accountId", "vendor");

        CREATE TABLE "ServiceAccountToken" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "vendor" TEXT NOT NULL,
            "token" BYTEA NOT NULL,
            "metadata" JSONB,
            "lastUsedAt" TIMESTAMP,
            "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP NOT NULL,
            "profileId" TEXT NOT NULL DEFAULT 'default',
            "expiresAt" TIMESTAMP,
            "refreshLeaseOwnerMachineId" TEXT,
            "refreshLeaseExpiresAt" TIMESTAMP,
            CONSTRAINT "ServiceAccountToken_accountId_fkey"
                FOREIGN KEY ("accountId") REFERENCES "Account" ("id")
                ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE INDEX "ServiceAccountToken_accountId_idx"
            ON "ServiceAccountToken"("accountId");
        CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_profileId_key"
            ON "ServiceAccountToken"("accountId", "vendor", "profileId");

        CREATE TABLE "ConnectedServiceAuthGroupMember" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "groupDbId" TEXT NOT NULL,
            "accountId" TEXT NOT NULL,
            "vendor" TEXT NOT NULL,
            "groupId" TEXT NOT NULL,
            "profileId" TEXT NOT NULL,
            "priority" INTEGER NOT NULL DEFAULT 100,
            "enabled" BOOLEAN NOT NULL DEFAULT true,
            "stateJson" TEXT,
            "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP NOT NULL,
            CONSTRAINT "ConnectedServiceAuthGroupMember_groupDbId_fkey"
                FOREIGN KEY ("groupDbId")
                REFERENCES "ConnectedServiceAuthGroup" ("id")
                ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_fkey"
                FOREIGN KEY ("accountId", "vendor", "profileId")
                REFERENCES "ServiceAccountToken"
                    ("accountId", "vendor", "profileId")
                ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "csagm_account_vendor_group_profile_key"
            ON "ConnectedServiceAuthGroupMember"
                ("accountId", "vendor", "groupId", "profileId");
        CREATE INDEX "ConnectedServiceAuthGroupMember_groupDbId_idx"
            ON "ConnectedServiceAuthGroupMember"("groupDbId");
        CREATE INDEX "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx"
            ON "ConnectedServiceAuthGroupMember"
                ("accountId", "vendor", "profileId");

        CREATE TABLE "ProviderAccountUsageRecord" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "recordId" TEXT NOT NULL,
            CONSTRAINT "ProviderAccountUsageRecord_accountId_fkey"
                FOREIGN KEY ("accountId") REFERENCES "Account" ("id")
                ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "ProviderAccountUsageRecord_accountId_recordId_key"
            ON "ProviderAccountUsageRecord"("accountId", "recordId");

        CREATE TABLE "ConnectedServiceUsageSource" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "accountId" TEXT NOT NULL,
            "serviceId" TEXT NOT NULL,
            "profileId" TEXT NOT NULL,
            "sourceKey" TEXT NOT NULL,
            "providerAccountUsageRecordId" TEXT NOT NULL,
            "bindingKind" TEXT NOT NULL,
            "groupId" TEXT,
            "groupGeneration" INTEGER,
            "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP NOT NULL,
            CONSTRAINT "csus_record_fkey"
                FOREIGN KEY ("accountId", "providerAccountUsageRecordId")
                REFERENCES "ProviderAccountUsageRecord"
                    ("accountId", "recordId")
                ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "ConnectedServiceUsageSource_accountId_sourceKey_key"
            ON "ConnectedServiceUsageSource"("accountId", "sourceKey");
        CREATE INDEX "csus_account_service_profile_idx"
            ON "ConnectedServiceUsageSource"
                ("accountId", "serviceId", "profileId");
        CREATE INDEX "csus_record_idx"
            ON "ConnectedServiceUsageSource"
                ("accountId", "providerAccountUsageRecordId");
    `);
    return db;
}

describe("qualified Connected Accounts V4 PostgreSQL activation", () => {
    let db: PGlite;

    beforeEach(async () => {
        db = await createPreparedDatabase();
    }, 60_000);

    afterEach(async () => {
        await db.close();
    });

    it("executes the exact migration, preserves legacy rows, and enforces same-service ownership", async () => {
        await db.exec(`
            INSERT INTO "Account" ("id") VALUES ('account-1');
            INSERT INTO "ServiceAccountToken" (
                "id", "accountId", "vendor", "profileId",
                "token", "metadata", "updatedAt"
            ) VALUES (
                'credential-1', 'account-1', 'openai-codex', 'work',
                decode('01', 'hex'), '{"v":3,"kind":"oauth"}'::jsonb,
                CURRENT_TIMESTAMP
            ), (
                'credential-gemini-oauth', 'account-1', 'gemini', 'old-oauth',
                decode('02', 'hex'), '{"v":2,"kind":"oauth","source":"legacy"}'::jsonb,
                CURRENT_TIMESTAMP
            ), (
                'credential-gemini-token', 'account-1', 'gemini', 'api-token',
                decode('03', 'hex'), '{"v":2,"kind":"token","source":"legacy"}'::jsonb,
                CURRENT_TIMESTAMP
            );
            INSERT INTO "ConnectedServiceAuthGroup" (
                "id", "accountId", "vendor", "groupId", "policyJson",
                "activeProfileId", "updatedAt"
            ) VALUES (
                'group-1', 'account-1', 'openai-codex', 'primary', '{}',
                'work', CURRENT_TIMESTAMP
            );
            INSERT INTO "ConnectedServiceAuthGroupMember" (
                "id", "groupDbId", "accountId", "vendor", "groupId",
                "profileId", "updatedAt"
            ) VALUES (
                'member-1', 'group-1', 'account-1', 'openai-codex',
                'primary', 'work', CURRENT_TIMESTAMP
            );
            INSERT INTO "ProviderAccountUsageRecord" (
                "id", "accountId", "recordId"
            ) VALUES ('usage-1', 'account-1', 'usage-record-1');
            INSERT INTO "ConnectedServiceUsageSource" (
                "id", "accountId", "serviceId", "profileId", "sourceKey",
                "providerAccountUsageRecordId", "bindingKind", "updatedAt"
            ) VALUES (
                'source-1', 'account-1', 'openai-codex', 'work', 'source-1',
                'usage-record-1', 'profile', CURRENT_TIMESTAMP
            );
        `);
        const activation = await readFile(
            new URL(
                "../../prisma/migrations/20260725100000_activate_qualified_connected_accounts_v4/migration.sql",
                import.meta.url,
            ),
            "utf8",
        );

        await db.exec("BEGIN");
        try {
            await db.exec(activation);
            await db.exec("COMMIT");
        } catch (error) {
            await db.exec("ROLLBACK");
            throw error;
        }

        expect((await db.query(`
            SELECT "indexname"
            FROM "pg_indexes"
            WHERE "tablename" = 'ConnectedServiceAuthGroupMember'
              AND "indexname" IN (
                'csagm_account_vendor_group_profile_key',
                'ConnectedServiceAuthGroupMember_group_profile_key'
              )
        `)).rows).toEqual([{
            indexname: "csagm_account_vendor_group_profile_key",
        }]);

        const accountDigest =
            createQualifiedConnectedAccountIdentityDigest({
                service,
                accountId: "work",
            });
        const serviceDigest =
            createQualifiedConnectedAccountServiceDigest(service);
        const groupDigest =
            createQualifiedConnectedAccountGroupDigest({
                service,
                groupId: "primary",
            });
        expect((await db.query(`
            SELECT
                "vendor",
                "profileId",
                "service_plugin_id" AS "servicePluginId",
                "service_local_id" AS "serviceLocalId",
                "qualified_service_digest" AS "qualifiedServiceDigest",
                "connected_account_id" AS "connectedAccountId",
                "qualified_identity_digest" AS "qualifiedIdentityDigest",
                "authentication_mode_id" AS "authenticationModeId"
            FROM "ServiceAccountToken"
            WHERE "id" = 'credential-1'
        `)).rows).toEqual([{
            vendor: "openai-codex",
            profileId: "work",
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: serviceDigest,
            connectedAccountId: "work",
            qualifiedIdentityDigest: accountDigest,
            authenticationModeId: "oauth",
        }]);
        const geminiServiceDigest =
            createQualifiedConnectedAccountServiceDigest(geminiService);
        expect((await db.query(`
            SELECT
                "id",
                encode("token", 'hex') AS "tokenHex",
                "metadata"->>'kind' AS "metadataKind",
                "metadata"->>'source' AS "metadataSource",
                "service_plugin_id" AS "servicePluginId",
                "service_local_id" AS "serviceLocalId",
                "qualified_service_digest" AS "qualifiedServiceDigest",
                "connected_account_id" AS "connectedAccountId",
                "qualified_identity_digest" AS "qualifiedIdentityDigest",
                "authentication_mode_id" AS "authenticationModeId"
            FROM "ServiceAccountToken"
            WHERE "vendor" = 'gemini'
            ORDER BY "id"
        `)).rows).toEqual([
            {
                id: "credential-gemini-oauth",
                tokenHex: "02",
                metadataKind: "oauth",
                metadataSource: "legacy",
                servicePluginId: geminiService.pluginId,
                serviceLocalId: geminiService.localId,
                qualifiedServiceDigest: geminiServiceDigest,
                connectedAccountId: "old-oauth",
                qualifiedIdentityDigest:
                    createQualifiedConnectedAccountIdentityDigest({
                        service: geminiService,
                        accountId: "old-oauth",
                    }),
                authenticationModeId: "legacy-oauth-unsupported",
            },
            {
                id: "credential-gemini-token",
                tokenHex: "03",
                metadataKind: "token",
                metadataSource: "legacy",
                servicePluginId: geminiService.pluginId,
                serviceLocalId: geminiService.localId,
                qualifiedServiceDigest: geminiServiceDigest,
                connectedAccountId: "api-token",
                qualifiedIdentityDigest:
                    createQualifiedConnectedAccountIdentityDigest({
                        service: geminiService,
                        accountId: "api-token",
                    }),
                authenticationModeId: "api-key",
            },
        ]);
        expect((await db.query(`
            SELECT
                "credential_id" AS "credentialId",
                "qualified_service_digest" AS "qualifiedServiceDigest",
                "qualified_group_digest" AS "qualifiedGroupDigest",
                "qualified_identity_digest" AS "qualifiedIdentityDigest"
            FROM "ConnectedServiceAuthGroupMember"
        `)).rows).toEqual([{
            credentialId: "credential-1",
            qualifiedServiceDigest: serviceDigest,
            qualifiedGroupDigest: groupDigest,
            qualifiedIdentityDigest: accountDigest,
        }]);
        expect((await db.query(`
            SELECT
                "credential_id" AS "credentialId",
                "qualified_service_digest" AS "qualifiedServiceDigest",
                "qualified_identity_digest" AS "qualifiedIdentityDigest"
            FROM "ConnectedServiceUsageSource"
        `)).rows).toEqual([{
            credentialId: "credential-1",
            qualifiedServiceDigest: serviceDigest,
            qualifiedIdentityDigest: accountDigest,
        }]);

        const otherService = {
            pluginId: "happier.voice.openai",
            localId: "openai",
        };
        const otherServiceDigest =
            createQualifiedConnectedAccountServiceDigest(otherService);
        const otherAccountDigest =
            createQualifiedConnectedAccountIdentityDigest({
                service: otherService,
                accountId: "other",
            });
        await db.query(
            `INSERT INTO "ServiceAccountToken" (
                "id", "accountId", "vendor", "profileId",
                "token", "metadata", "updatedAt",
                "service_plugin_id", "service_local_id",
                "qualified_service_digest", "connected_account_id",
                "qualified_identity_digest", "authentication_mode_id"
            ) VALUES (
                'credential-other', 'account-1', NULL, NULL,
                decode('02', 'hex'), '{"v":4}'::jsonb, CURRENT_TIMESTAMP,
                $1, $2, $3, 'other', $4, 'api-key'
            )`,
            [
                otherService.pluginId,
                otherService.localId,
                otherServiceDigest,
                otherAccountDigest,
            ],
        );
        await expect(db.query(
            `INSERT INTO "ConnectedServiceAuthGroupMember" (
                "id", "groupDbId", "accountId", "credential_id",
                "qualified_service_digest", "qualified_group_digest",
                "qualified_identity_digest", "updatedAt"
            ) VALUES (
                'cross-service-member', 'group-1', 'account-1',
                'credential-other', $1, $2, $3, CURRENT_TIMESTAMP
            )`,
            [serviceDigest, groupDigest, otherAccountDigest],
        )).rejects.toThrow(/foreign key/i);
    }, 60_000);
});
