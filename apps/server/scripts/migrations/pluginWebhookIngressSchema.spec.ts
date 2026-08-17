import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260810130000_add_plugin_webhook_ingress_v1";

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

function model(schema: string, name: string): string {
    const match = schema.match(new RegExp(`model\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`, "m"));
    if (!match?.[1]) {
        throw new Error(`model ${name} not found`);
    }
    return match[1];
}

function optionalScalarPattern(field: string, scalar: string): RegExp {
    return new RegExp(
        `^\\s*${field}\\s+${scalar}\\?(?:\\s+@db\\.[^\\s]+)?\\s*$`,
        "m",
    );
}

function uniqueScalarPattern(field: string): RegExp {
    return new RegExp(
        `^\\s*${field}\\s+String(?:\\s+@db\\.[^\\s]+)?\\s+@unique\\s*$`,
        "m",
    );
}

function uniqueOptionalScalarPattern(field: string): RegExp {
    return new RegExp(
        `^\\s*${field}\\s+String\\?(?:\\s+@db\\.[^\\s]+)?\\s+@unique\\s*$`,
        "m",
    );
}

function mysqlMigrationIdentifierNames(sql: string): string[] {
    return Array.from(
        sql.matchAll(/^\s*(?:(?:UNIQUE\s+)?INDEX|CONSTRAINT)\s+`([^`]+)`/gm),
        ([, name]) => name,
    );
}

function foreignKeyClause(sql: string, foreignKey: string): string {
    const match = sql.match(new RegExp(`${foreignKey}[^\\n]*\\n\\s*FOREIGN KEY[^\\n]*`));
    if (!match?.[0]) {
        throw new Error(`foreign key ${foreignKey} not found`);
    }
    return match[0];
}

describe("plugin webhook ingress persistence contract", () => {
    const schemaPaths = [
        "prisma/schema.prisma",
        "prisma/sqlite/schema.prisma",
        "prisma/mysql/schema.prisma",
    ] as const;

    it.each(schemaPaths)("keeps exactly the five webhook custody models in %s", async (schemaPath) => {
        const schema = await read(schemaPath);
        const route = model(schema, "PluginWebhookRoute");
        const endpoint = model(schema, "PluginWebhookEndpoint");
        const operation = model(schema, "PluginWebhookEndpointOperation");
        const credential = model(schema, "PluginWebhookCredential");
        const delivery = model(schema, "PluginWebhookDelivery");

        expect(route).toMatch(uniqueScalarPattern("opaqueRouteId"));
        expect(route).toMatch(/^\s*verifierKind\s+String\b/m);
        expect(route).toMatch(/^\s*routingKind\s+String\b/m);
        expect(route).toMatch(optionalScalarPattern("operatorPluginId", "String"));
        expect(route).toMatch(optionalScalarPattern("operatorWebhookContributionId", "String"));
        expect(route).toMatch(uniqueOptionalScalarPattern("currentCredentialId"));
        expect(route).toMatch(uniqueOptionalScalarPattern("previousCredentialId"));
        expect(route).toMatch(/^\s*currentCredential\s+PluginWebhookCredential\?\s+@relation\("PluginWebhookRouteCurrentCredential", fields: \[currentCredentialId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)\s*$/m);
        expect(route).toMatch(/^\s*previousCredential\s+PluginWebhookCredential\?\s+@relation\("PluginWebhookRoutePreviousCredential", fields: \[previousCredentialId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)\s*$/m);
        expect(route).not.toMatch(/^\s*accountId\s+/m);
        expect(route).not.toMatch(/^\s*providerInstallationId\s+/m);
        expect(route).toContain(
            "@@unique([operatorPluginId, operatorWebhookContributionId], map: \"plugin_webhook_route_operator_contribution_key\")",
        );

        expect(endpoint).toMatch(/^\s*id\s+String(?:\s+@db\.[^\s]+)?\s+@id\b/m);
        for (const field of [
            "accountId",
            "pluginId",
            "webhookContributionId",
            "handlerActionId",
            "sourceInstanceId",
            "ensureIdempotencyKey",
            "ensureRequestFingerprint",
            "setupKind",
            "targetMachineId",
            "targetMachineInstallationId",
            "targetMaterializationId",
            "targetPluginVersion",
        ]) {
            expect(endpoint).toMatch(optionalScalarPattern(field, "String"));
        }
        for (const field of [
            "previousTargetMachineId",
            "previousTargetMachineInstallationId",
            "previousTargetMaterializationId",
            "previousTargetPluginVersion",
        ]) {
            expect(endpoint).toMatch(optionalScalarPattern(field, "String"));
        }
        expect(endpoint).toMatch(/^\s*routeId\s+String\b/m);
        expect(endpoint).toMatch(optionalScalarPattern("providerInstallationId", "String"));
        expect(endpoint).toMatch(optionalScalarPattern("releasedAt", "DateTime"));
        expect(endpoint).toMatch(optionalScalarPattern("tombstoneExpiresAt", "DateTime"));
        // Detachment is the canonical Account-deletion owner's transaction, never an FK side effect.
        expect(endpoint).toMatch(/^\s*account\s+Account\?\s+@relation\(fields: \[accountId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)\s*$/m);
        expect(endpoint).toContain("@@unique([accountId, ensureIdempotencyKey])");
        expect(endpoint).toContain(
            "@@unique([accountId, pluginId, webhookContributionId, sourceInstanceId], map: \"plugin_webhook_endpoint_account_contribution_source_key\")",
        );
        expect(endpoint).toContain("@@unique([routeId, providerInstallationId])");
        expect(endpoint).toContain("@@index([tombstoneExpiresAt])");
        expect(endpoint).toMatch(/^\s*operations\s+PluginWebhookEndpointOperation\[\]\s*$/m);

        expect(operation).toMatch(/^\s*id\s+String(?:\s+@db\.[^\s]+)?\s+@id\b/m);
        expect(operation).toMatch(/^\s*accountId\s+String\b/m);
        expect(operation).toMatch(/^\s*endpointId\s+String\b/m);
        expect(operation).toMatch(/^\s*operationKind\s+String\b/m);
        expect(operation).toMatch(/^\s*idempotencyKey\s+String\b/m);
        expect(operation).toMatch(/^\s*expectedRevision\s+Int\b/m);
        for (const field of [
            "requestTargetMachineId",
            "requestTargetMaterializationId",
            "requestTargetPluginId",
            "resultPreviousTargetMachineId",
            "resultPreviousTargetMaterializationId",
            "resultPreviousTargetPluginId",
            "resultTargetMachineId",
            "resultTargetMaterializationId",
            "resultTargetPluginId",
        ]) {
            expect(operation).toMatch(optionalScalarPattern(field, "String"));
        }
        expect(operation).toMatch(/^\s*resultKind\s+String\b/m);
        expect(operation).toMatch(/^\s*resultRevision\s+Int\b/m);
        expect(operation).toMatch(/^\s*account\s+Account\s+@relation\(fields: \[accountId\], references: \[id\], onDelete: Cascade\)\s*$/m);
        expect(operation).toMatch(/^\s*endpoint\s+PluginWebhookEndpoint\s+@relation\(fields: \[endpointId\], references: \[id\], onDelete: Cascade\)\s*$/m);
        expect(operation).toContain("@@unique([endpointId, idempotencyKey])");
        expect(operation).toContain("@@index([accountId])");
        expect(operation).not.toMatch(/^\s*(?:actionKind|requestFingerprint)\s+/m);
        expect(operation).not.toMatch(/^\s*result\s+Json\b/m);
        expect(operation).not.toContain("@@unique([endpointId, actionKind, idempotencyKey])");
        expect(operation).not.toMatch(/^\s*(?:request|result(?:Previous)?)Target(?:ServerIdentity|MachineInstallation|PluginVersion)Id\s+/m);
        if (schemaPath === "prisma/mysql/schema.prisma") {
            expect(operation).toMatch(/^\s*id\s+String\s+@db\.VarChar\(25\)\s+@id\b/m);
            expect(operation).toMatch(/^\s*endpointId\s+String\s+@db\.VarChar\(28\)(?:\s|$)/m);
            expect(operation).toMatch(/^\s*idempotencyKey\s+String\s+@db\.VarChar\(128\)(?:\s|$)/m);
            expect(operation).toMatch(/^\s*resultKind\s+String\s+@db\.VarChar\(32\)(?:\s|$)/m);
            expect(operation).toMatch(/^\s*resultTargetMaterializationId\s+String\?\s+@db\.VarChar\(256\)(?:\s|$)/m);
        }

        expect(credential).toMatch(uniqueScalarPattern("credentialVersionId"));
        expect(credential).toMatch(/^\s*encryptedSecret\s+Bytes\b/m);
        expect(credential).toMatch(/^\s*state\s+String\b/m);
        expect(credential).toMatch(optionalScalarPattern("acceptUntil", "DateTime"));

        expect(delivery).toMatch(uniqueScalarPattern("deliveryIdentityDigest"));
        expect(endpoint).not.toMatch(/^\s*(?:previous)?targetServerIdentityId\s+/mi);
        expect(delivery).not.toMatch(/^\s*targetServerIdentityId\s+/m);
        expect(delivery).toMatch(optionalScalarPattern("payload", "Json"));
        expect(delivery).toMatch(optionalScalarPattern("automationAdmissionUnresolved", "Json"));
        expect(delivery).toMatch(/^\s*payloadBytes\s+BigInt\b/m);
        expect(delivery).toMatch(/^\s*state\s+String\b/m);
        expect(delivery).toMatch(/^\s*metadataDeleteAt\s+DateTime\b/m);
        if (schemaPath === "prisma/mysql/schema.prisma") {
            expect(delivery).toContain(
                "@@index([targetMachineId(length: 64), targetMachineInstallationId(length: 64), targetMaterializationId(length: 64), state(length: 32), nextAttemptAt], map: \"plugin_webhook_delivery_target_claim_idx\")",
            );
        } else {
            expect(delivery).toContain(
                "@@index([targetMachineId, targetMachineInstallationId, targetMaterializationId, state, nextAttemptAt], map: \"plugin_webhook_delivery_target_claim_idx\")",
            );
        }
        expect(delivery).toContain("@@index([state, leaseExpiresAt])");
        expect(delivery).toContain("@@index([endpointId, state])");
        expect(delivery).toContain("@@index([accountId, state])");
        expect(delivery).toContain("@@index([payloadPurgeAt])");
        expect(delivery).toContain("@@index([metadataDeleteAt])");

        // PEP1 remains unapproved: webhook ingress owns no transition participant or stage row.
        expect(schema).not.toMatch(/PluginWebhook(?:Delivery|Endpoint|Route).*Stage/);
        // Ingress custody has no scan cursor, provider recovery owner, or second queue table.
        expect(schema).not.toMatch(/PluginWebhook(?:Scan|Recovery|Cursor|Queue)/);
    });

    it.each([
        ["prisma/migrations", '"'],
        ["prisma/sqlite/migrations", '"'],
        ["prisma/mysql/migrations", "`"],
    ] as const)("adds the five-model additive migration for %s", async (migrationRoot, quote) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);

        for (const table of [
            "PluginWebhookRoute",
            "PluginWebhookEndpoint",
            "PluginWebhookEndpointOperation",
            "PluginWebhookCredential",
            "PluginWebhookDelivery",
        ]) {
            expect(sql).toContain(`${quote}${table}${quote}`);
        }
        expect(sql).toContain("deliveryIdentityDigest");
        expect(sql).toContain("providerInstallationId");
        expect(sql).toContain("automationAdmissionUnresolved");
        expect(sql).toContain("PluginWebhookEndpoint_detached_tombstone_check");
        expect(foreignKeyClause(sql, "PluginWebhookEndpoint_accountId_fkey")).toContain(
            "ON DELETE RESTRICT ON UPDATE RESTRICT",
        );
        expect(sql).toMatch(
            /PluginWebhookEndpoint_detached_tombstone_check[\s\S]*?["`]enabled["`]\s*=\s*(?:FALSE|0)[\s\S]*?["`]revokedAt["`]\s+IS NULL[\s\S]*?["`]releasedAt["`]\s+IS NOT NULL[\s\S]*?["`]tombstoneExpiresAt["`]\s+IS NOT NULL/i,
        );
        expect(sql).toContain("PluginWebhookEndpoint_tombstoneExpiresAt_idx");
        expect(sql).not.toContain("targetServerIdentityId");
        expect(sql).not.toContain("previousTargetServerIdentityId");
        expect(sql).not.toMatch(/PluginWebhook(?:Scan|Recovery|Cursor|Queue|.*Stage)/);
    });

    it.each([
        "prisma/migrations",
        "prisma/sqlite/migrations",
        "prisma/mysql/migrations",
    ] as const)("keeps every CHECK/FK intersection non-cascading in %s", async (migrationRoot) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);

        for (const foreignKey of [
            "PluginWebhookEndpoint_accountId_fkey",
            "PluginWebhookRoute_currentCredentialId_fkey",
            "PluginWebhookRoute_previousCredentialId_fkey",
        ]) {
            expect(foreignKeyClause(sql, foreignKey)).toContain(
                "ON DELETE RESTRICT ON UPDATE RESTRICT",
            );
        }
        expect(sql).toContain("PluginWebhookEndpoint_detached_tombstone_check");
        expect(sql).toContain("PluginWebhookRoute_distinct_credential_check");
        expect(sql).toMatch(/["`]accountId["`]\s+IS NOT NULL/);
        expect(sql).toMatch(/["`]currentCredentialId["`]\s+IS NULL/);
        expect(sql).toMatch(/["`]previousCredentialId["`]\s+IS NULL/);
    });

    it("maps every Webhook physical identifier below the MySQL native limit", async () => {
        const routeKey = "plugin_webhook_route_operator_contribution_key";
        const endpointKey = "plugin_webhook_endpoint_account_contribution_source_key";
        const deliveryKey = "plugin_webhook_delivery_target_claim_idx";
        const [postgresMigration, sqliteMigration, mysqlMigration] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);
        const identifierNames = mysqlMigrationIdentifierNames(mysqlMigration);

        for (const migration of [postgresMigration, sqliteMigration]) {
            expect(migration).toContain(`CREATE UNIQUE INDEX "${routeKey}"`);
            expect(migration).toContain(`CREATE UNIQUE INDEX "${endpointKey}"`);
            expect(migration).toContain(`CREATE INDEX "${deliveryKey}"`);
        }
        expect(mysqlMigration).toContain(`UNIQUE INDEX \`${routeKey}\``);
        expect(mysqlMigration).toContain(`UNIQUE INDEX \`${endpointKey}\``);
        expect(mysqlMigration).toContain(`INDEX \`${deliveryKey}\``);
        expect(identifierNames).toEqual(expect.arrayContaining([routeKey, endpointKey, deliveryKey]));
        expect(identifierNames.every((name) => name.length <= 64)).toBe(true);
    });

    it("materializes only server-scoped target facts in the SQLite migration", async () => {
        const sqliteMigration = await read(
            `prisma/sqlite/migrations/${migrationId}/migration.sql`,
        );
        const db = new DatabaseSync(":memory:");
        try {
            db.exec('PRAGMA foreign_keys = ON; CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);');
            db.exec(sqliteMigration);

            const endpointColumns = db.prepare(
                'PRAGMA table_info("PluginWebhookEndpoint")',
            ).all().map((column) => (column as { name: string }).name);
            const deliveryColumns = db.prepare(
                'PRAGMA table_info("PluginWebhookDelivery")',
            ).all().map((column) => (column as { name: string }).name);
            const operationColumns = db.prepare(
                'PRAGMA table_info("PluginWebhookEndpointOperation")',
            ).all().map((column) => (column as { name: string }).name);

            expect(endpointColumns).not.toContain("targetServerIdentityId");
            expect(endpointColumns).not.toContain("previousTargetServerIdentityId");
            expect(deliveryColumns).not.toContain("targetServerIdentityId");
            expect(deliveryColumns).toContain("automationAdmissionUnresolved");
            expect(operationColumns).toEqual(expect.arrayContaining([
                "endpointId",
                "idempotencyKey",
                "operationKind",
                "expectedRevision",
                "resultKind",
                "resultRevision",
            ]));
            expect(operationColumns).not.toEqual(expect.arrayContaining([
                "requestTargetServerIdentityId",
                "resultTargetServerIdentityId",
                "requestTargetMachineInstallationId",
                "resultTargetPluginVersion",
            ]));

            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "PluginWebhookRoute" (
                    "id", "opaqueRouteId", "verifierKind", "routingKind",
                    "operatorPluginId", "operatorWebhookContributionId", "enabled", "policyVersion",
                    "createdAt", "updatedAt"
                ) VALUES (
                    'route-1', 'route-opaque-1', 'github_hmac_sha256_v1', 'providerInstallation',
                    'io.happier.github', 'github-events', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                INSERT INTO "PluginWebhookEndpoint" (
                    "id", "accountId", "pluginId", "webhookContributionId", "handlerActionId",
                    "sourceInstanceId", "ensureIdempotencyKey", "ensureRequestFingerprint", "setupKind",
                    "routeId", "routingKind", "providerInstallationId", "enabled", "revision",
                    "targetMachineId", "targetMachineInstallationId",
                    "targetMaterializationId", "targetPluginVersion",
                    "createdAt", "updatedAt"
                ) VALUES (
                    'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', 'account-1', 'io.happier.github', 'github-events', 'handle',
                    'source-1', 'ensure-1', 'request-1', 'githubSharedInstallationV1',
                    'route-1', 'providerInstallation', '123', 1, 1,
                    'machine-1', 'machine-install-1', 'materialization-1', '1.0.0',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                INSERT INTO "PluginWebhookEndpointOperation" (
                    "id", "accountId", "endpointId", "operationKind", "idempotencyKey", "expectedRevision",
                    "requestTargetMachineId", "requestTargetMaterializationId", "requestTargetPluginId",
                    "resultKind", "resultRevision",
                    "resultPreviousTargetMachineId", "resultPreviousTargetMaterializationId", "resultPreviousTargetPluginId",
                    "resultTargetMachineId", "resultTargetMaterializationId", "resultTargetPluginId", "createdAt"
                ) VALUES (
                    'endpoint-operation-1', 'account-1', 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', 'retarget', 'retarget-1', 1,
                    'machine-2', 'materialization-2', 'io.happier.github',
                    'retargeted', 2,
                    'machine-1', 'materialization-1', 'io.happier.github',
                    'machine-2', 'materialization-2', 'io.happier.github', CURRENT_TIMESTAMP
                );
                INSERT INTO "PluginWebhookDelivery" (
                    "id", "endpointId", "accountId", "routeId", "deliveryIdentityDigest", "verifierKind",
                    "targetMachineId", "targetMachineInstallationId",
                    "targetMaterializationId", "targetPluginId", "targetPluginVersion", "payloadKind", "payload",
                    "endpointRevision", "endpointWebhookContributionId", "endpointHandlerActionId", "endpointSourceInstanceId",
                    "payloadBytes", "wireVersion", "payloadVersion", "state", "nextAttemptAt", "metadataDeleteAt",
                    "receivedAt", "updatedAt"
                ) VALUES (
                    'delivery-1', 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', 'account-1', 'route-1',
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'github_hmac_sha256_v1',
                    'machine-1', 'machine-install-1', 'materialization-1', 'io.happier.github', '1.0.0',
                    'plain', '{}', 1, 'github-events', 'handle', 'source-1', 2, 1, 1, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            `);
            expect(db.prepare(`
                SELECT "targetMachineId", "targetMaterializationId", "targetPluginId"
                FROM "PluginWebhookDelivery" WHERE "id" = 'delivery-1'
            `).get()).toEqual({
                targetMachineId: "machine-1",
                targetMaterializationId: "materialization-1",
                targetPluginId: "io.happier.github",
            });
            expect(db.prepare(`
                SELECT "resultKind", "resultRevision", "resultTargetMaterializationId"
                FROM "PluginWebhookEndpointOperation" WHERE "id" = 'endpoint-operation-1'
            `).get()).toEqual({
                resultKind: "retargeted",
                resultRevision: 2,
                resultTargetMaterializationId: "materialization-2",
            });
            expect(() => db.exec(`
                INSERT INTO "PluginWebhookEndpointOperation" (
                    "id", "accountId", "endpointId", "operationKind", "idempotencyKey", "expectedRevision",
                    "resultKind", "resultRevision", "createdAt"
                ) VALUES (
                    'endpoint-operation-duplicate', 'account-1', 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', 'revoke', 'retarget-1', 2,
                    'revoked', 3, CURRENT_TIMESTAMP
                );
            `)).toThrow();
            expect(() => db.exec(`
                INSERT INTO "PluginWebhookEndpointOperation" (
                    "id", "accountId", "endpointId", "operationKind", "idempotencyKey", "expectedRevision",
                    "requestTargetMachineId", "requestTargetMaterializationId", "requestTargetPluginId",
                    "resultKind", "resultRevision", "createdAt"
                ) VALUES (
                    'endpoint-operation-invalid', 'account-1', 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', 'revoke', 'revoke-1', 2,
                    'machine-2', 'materialization-2', 'io.happier.github',
                    'revoked', 3, CURRENT_TIMESTAMP
                );
            `)).toThrow();
        } finally {
            db.close();
        }
    });

    it("applies the additive PostgreSQL contract and preserves a shared tombstone on Account deletion", async () => {
        const db = new PGlite();
        try {
            await db.exec('CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);');
            await db.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));

            await db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "PluginWebhookRoute" (
                    "id", "opaqueRouteId", "verifierKind", "routingKind",
                    "operatorPluginId", "operatorWebhookContributionId", "enabled", "policyVersion",
                    "createdAt", "updatedAt"
                ) VALUES (
                    'route-1', 'route-opaque-1', 'github_hmac_sha256_v1', 'providerInstallation',
                    'io.happier.github', 'github-events', TRUE, 1, NOW(), NOW()
                );
                INSERT INTO "PluginWebhookEndpoint" (
                    "id", "accountId", "pluginId", "webhookContributionId", "handlerActionId",
                    "sourceInstanceId", "ensureIdempotencyKey", "ensureRequestFingerprint", "setupKind",
                    "routeId", "routingKind", "providerInstallationId", "enabled", "revision",
                    "targetMachineId", "targetMachineInstallationId",
                    "targetMaterializationId", "targetPluginVersion", "createdAt", "updatedAt"
                ) VALUES (
                    'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', 'account-1', 'io.happier.github', 'github-events', 'handle',
                    'source-1', 'ensure-1', 'request-1', 'githubSharedInstallationV1',
                    'route-1', 'providerInstallation', '123', TRUE, 1,
                    'machine-1', 'machine-install-1', 'materialization-1', '1.0.0', NOW(), NOW()
                );
                INSERT INTO "PluginWebhookEndpointOperation" (
                    "id", "accountId", "endpointId", "operationKind", "idempotencyKey", "expectedRevision",
                    "requestTargetMachineId", "requestTargetMaterializationId", "requestTargetPluginId",
                    "resultKind", "resultRevision",
                    "resultPreviousTargetMachineId", "resultPreviousTargetMaterializationId", "resultPreviousTargetPluginId",
                    "resultTargetMachineId", "resultTargetMaterializationId", "resultTargetPluginId", "createdAt"
                ) VALUES (
                    'endpoint-operation-1', 'account-1', 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', 'retarget', 'retarget-1', 1,
                    'machine-2', 'materialization-2', 'io.happier.github',
                    'retargeted', 2,
                    'machine-1', 'materialization-1', 'io.happier.github',
                    'machine-2', 'materialization-2', 'io.happier.github', NOW()
                );
            `);
            // A direct Account deletion cannot detach an active binding behind the owner's back.
            await expect(db.exec(`
                DELETE FROM "Account" WHERE "id" = 'account-1';
            `)).rejects.toThrow();

            // The Account deletion owner scrubs Account/plugin/target facts in the same
            // transaction before deleting the Account through the restrictive FK.
            await db.exec(`
                UPDATE "PluginWebhookEndpoint"
                SET
                    "accountId" = NULL,
                    "pluginId" = NULL,
                    "webhookContributionId" = NULL,
                    "handlerActionId" = NULL,
                    "sourceInstanceId" = NULL,
                    "ensureIdempotencyKey" = NULL,
                    "ensureRequestFingerprint" = NULL,
                    "setupKind" = NULL,
                    "targetMachineId" = NULL,
                    "targetMachineInstallationId" = NULL,
                    "targetMaterializationId" = NULL,
                    "targetPluginVersion" = NULL,
                    "previousTargetMachineId" = NULL,
                    "previousTargetMachineInstallationId" = NULL,
                    "previousTargetMaterializationId" = NULL,
                    "previousTargetPluginVersion" = NULL,
                    "enabled" = FALSE,
                    "revokedAt" = NULL,
                    "releasedAt" = NOW(),
                    "tombstoneExpiresAt" = NOW() + INTERVAL '7 days'
                WHERE "id" = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
                DELETE FROM "Account" WHERE "id" = 'account-1';
            `);

            const tombstone = await db.query<{
                accountId: string | null;
                routeId: string;
                providerInstallationId: string | null;
            }>(`
                SELECT "accountId", "routeId", "providerInstallationId"
                FROM "PluginWebhookEndpoint"
                WHERE "id" = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA'
            `);
            expect(tombstone.rows).toEqual([
                {
                    accountId: null,
                    routeId: "route-1",
                    providerInstallationId: "123",
                },
            ]);
            expect((await db.query(`
                SELECT "id" FROM "PluginWebhookEndpointOperation"
                WHERE "id" = 'endpoint-operation-1'
            `)).rows).toEqual([]);

            await expect(db.exec(`
                INSERT INTO "PluginWebhookEndpoint" (
                    "id", "routeId", "routingKind", "providerInstallationId", "enabled", "revision",
                    "createdAt", "updatedAt"
                ) VALUES (
                    'wh_ep_BBBBBBBBBBBBBBBBBBBBBB', 'route-1', 'providerInstallation', '123', FALSE, 1, NOW(), NOW()
                );
            `)).rejects.toThrow();
        } finally {
            await db.close();
        }
    });
});
