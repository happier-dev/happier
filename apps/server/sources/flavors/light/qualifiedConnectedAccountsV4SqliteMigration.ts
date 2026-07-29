import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountServiceDigest,
    resolveLegacyQualifiedConnectedAccountService,
    resolveLegacyServiceAccountTokenIdentityFields,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";

import type { SqliteMigrationExecutor } from "./sqliteMigrations";

export const qualifiedConnectedAccountsV4MigrationName =
    "20260725100000_activate_qualified_connected_accounts_v4";
export const qualifiedConnectedAccountsV4PreparationDirective =
    "SELECT happier_prepare_qualified_connected_accounts_v4();";

type SqlRow = Readonly<Record<string, unknown>>;

function requiredString(
    row: SqlRow,
    field: string,
    family: string,
): string {
    const value = row[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(
            `[sqlite-migrations] qualified Connected Account ${family} has invalid ${field}`,
        );
    }
    return value;
}

function optionalString(row: SqlRow, field: string): string | null {
    const value = row[field];
    if (value == null) return null;
    if (typeof value !== "string") {
        throw new Error(
            `[sqlite-migrations] qualified Connected Account has invalid ${field}`,
        );
    }
    return value;
}

function credentialKind(metadata: unknown): "oauth" | "token" | null {
    if (metadata == null) return null;
    let parsed = metadata;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            throw new Error(
                "[sqlite-migrations] qualified Connected Account credential metadata is not valid JSON",
            );
        }
    }
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
        throw new Error(
            "[sqlite-migrations] qualified Connected Account credential metadata is not an object",
        );
    }
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind == null) return null;
    if (kind !== "oauth" && kind !== "token") {
        throw new Error(
            `[sqlite-migrations] unsupported legacy Connected Account credential kind: ${String(kind)}`,
        );
    }
    return kind;
}

function compositeKey(...parts: string[]): string {
    return JSON.stringify(parts);
}

function assertUnique(
    seen: Set<string>,
    key: string,
    family: string,
): void {
    if (seen.has(key)) {
        throw new Error(
            `[sqlite-migrations] qualified Connected Account ${family} identity collision`,
        );
    }
    seen.add(key);
}

async function prepareQualifiedConnectedAccountsV4(
    executor: SqliteMigrationExecutor,
): Promise<void> {
    if (!executor.queryRows || !executor.run) {
        throw new Error(
            "[sqlite-migrations] qualified Connected Accounts V4 requires query/run support from the canonical SQLite migration executor",
        );
    }

    await executor.exec(`
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "service_plugin_id" TEXT;
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "service_local_id" TEXT;
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "qualified_service_digest" TEXT;
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "connected_account_id" TEXT;
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "qualified_identity_digest" TEXT;
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "authentication_mode_id" TEXT;
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "configuration_revision" TEXT;
        ALTER TABLE "ServiceAccountToken" ADD COLUMN "configuration_content" BLOB
            CHECK (("configuration_revision" IS NULL) = ("configuration_content" IS NULL));

        ALTER TABLE "ConnectedServiceAuthGroup" ADD COLUMN "service_plugin_id" TEXT;
        ALTER TABLE "ConnectedServiceAuthGroup" ADD COLUMN "service_local_id" TEXT;
        ALTER TABLE "ConnectedServiceAuthGroup" ADD COLUMN "qualified_service_digest" TEXT;
        ALTER TABLE "ConnectedServiceAuthGroup" ADD COLUMN "qualified_group_digest" TEXT;
        ALTER TABLE "ConnectedServiceAuthGroup" ADD COLUMN "active_connected_account_id" TEXT;

        ALTER TABLE "ConnectedServiceAuthGroupMember" ADD COLUMN "credential_id" TEXT;
        ALTER TABLE "ConnectedServiceAuthGroupMember" ADD COLUMN "qualified_service_digest" TEXT;
        ALTER TABLE "ConnectedServiceAuthGroupMember" ADD COLUMN "qualified_group_digest" TEXT;
        ALTER TABLE "ConnectedServiceAuthGroupMember" ADD COLUMN "qualified_identity_digest" TEXT;

        ALTER TABLE "ConnectedServiceUsageSource" ADD COLUMN "service_plugin_id" TEXT;
        ALTER TABLE "ConnectedServiceUsageSource" ADD COLUMN "service_local_id" TEXT;
        ALTER TABLE "ConnectedServiceUsageSource" ADD COLUMN "qualified_service_digest" TEXT;
        ALTER TABLE "ConnectedServiceUsageSource" ADD COLUMN "connected_account_id" TEXT;
        ALTER TABLE "ConnectedServiceUsageSource" ADD COLUMN "qualified_identity_digest" TEXT;
        ALTER TABLE "ConnectedServiceUsageSource" ADD COLUMN "credential_id" TEXT;
    `);

    const credentialRows = await executor.queryRows(`
        SELECT "id", "accountId", "vendor", "profileId", "metadata"
        FROM "ServiceAccountToken"
    `);
    const groupRows = await executor.queryRows(`
        SELECT "id", "accountId", "vendor", "groupId", "activeProfileId"
        FROM "ConnectedServiceAuthGroup"
    `);
    const memberRows = await executor.queryRows(`
        SELECT "id", "groupDbId", "accountId", "vendor", "groupId", "profileId"
        FROM "ConnectedServiceAuthGroupMember"
    `);
    const usageRows = await executor.queryRows(`
        SELECT "id", "accountId", "serviceId", "profileId"
        FROM "ConnectedServiceUsageSource"
    `);

    const credentialsByLegacyIdentity = new Map<
        string,
        Readonly<{
            id: string;
            accountId: string;
            vendor: string;
            profileId: string;
            servicePluginId: string;
            serviceLocalId: string;
            qualifiedServiceDigest: string;
            connectedAccountId: string;
            qualifiedIdentityDigest: string;
            authenticationModeId: string;
        }>
    >();
    const credentialIdentityKeys = new Set<string>();
    for (const row of credentialRows) {
        const id = requiredString(row, "id", "credential");
        const accountId = requiredString(row, "accountId", "credential");
        const vendor = requiredString(row, "vendor", "credential");
        const profileId = requiredString(row, "profileId", "credential");
        const fields = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: vendor,
            profileId,
            credentialKind: credentialKind(row.metadata),
        });
        assertUnique(
            credentialIdentityKeys,
            compositeKey(accountId, fields.qualifiedIdentityDigest),
            "credential",
        );
        const prepared = {
            id,
            accountId,
            vendor,
            profileId,
            ...fields,
        };
        credentialsByLegacyIdentity.set(
            compositeKey(accountId, vendor, profileId),
            prepared,
        );
    }

    const groupsById = new Map<
        string,
        Readonly<{
            id: string;
            accountId: string;
            vendor: string;
            groupId: string;
            servicePluginId: string;
            serviceLocalId: string;
            qualifiedServiceDigest: string;
            qualifiedGroupDigest: string;
            activeConnectedAccountId: string | null;
        }>
    >();
    const groupIdentityKeys = new Set<string>();
    for (const row of groupRows) {
        const id = requiredString(row, "id", "group");
        const accountId = requiredString(row, "accountId", "group");
        const vendor = requiredString(row, "vendor", "group");
        const groupId = requiredString(row, "groupId", "group");
        const service = resolveLegacyQualifiedConnectedAccountService(vendor);
        const qualifiedServiceDigest =
            createQualifiedConnectedAccountServiceDigest(service);
        const qualifiedGroupDigest = createQualifiedConnectedAccountGroupDigest({
            service,
            groupId,
        });
        assertUnique(
            groupIdentityKeys,
            compositeKey(accountId, qualifiedGroupDigest),
            "group",
        );
        groupsById.set(id, {
            id,
            accountId,
            vendor,
            groupId,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest,
            qualifiedGroupDigest,
            activeConnectedAccountId: optionalString(row, "activeProfileId"),
        });
    }

    const preparedMembers: Array<Readonly<{
        id: string;
        group: NonNullable<ReturnType<typeof groupsById.get>>;
        credential: NonNullable<
            ReturnType<typeof credentialsByLegacyIdentity.get>
        >;
    }>> = [];
    const memberProfilesByGroup = new Map<string, Set<string>>();
    for (const row of memberRows) {
        const id = requiredString(row, "id", "member");
        const group = groupsById.get(requiredString(row, "groupDbId", "member"));
        if (
            !group
            || group.accountId !== requiredString(row, "accountId", "member")
            || group.vendor !== requiredString(row, "vendor", "member")
            || group.groupId !== requiredString(row, "groupId", "member")
        ) {
            throw new Error(
                "[sqlite-migrations] qualified Connected Account member does not match its group",
            );
        }
        const profileId = requiredString(row, "profileId", "member");
        const credential = credentialsByLegacyIdentity.get(
            compositeKey(group.accountId, group.vendor, profileId),
        );
        if (!credential) {
            throw new Error(
                "[sqlite-migrations] qualified Connected Account member credential is missing",
            );
        }
        preparedMembers.push({ id, group, credential });
        const profiles = memberProfilesByGroup.get(group.id) ?? new Set<string>();
        profiles.add(profileId);
        memberProfilesByGroup.set(group.id, profiles);
    }

    for (const group of groupsById.values()) {
        if (
            group.activeConnectedAccountId != null
            && !memberProfilesByGroup
                .get(group.id)
                ?.has(group.activeConnectedAccountId)
        ) {
            throw new Error(
                "[sqlite-migrations] qualified Connected Account active credential is not a member of its group",
            );
        }
    }

    const preparedUsageRows: Array<Readonly<{
        id: string;
        credential: NonNullable<
            ReturnType<typeof credentialsByLegacyIdentity.get>
        >;
    }>> = [];
    for (const row of usageRows) {
        const credential = credentialsByLegacyIdentity.get(
            compositeKey(
                requiredString(row, "accountId", "usage source"),
                requiredString(row, "serviceId", "usage source"),
                requiredString(row, "profileId", "usage source"),
            ),
        );
        if (!credential) {
            throw new Error(
                "[sqlite-migrations] qualified Connected Account usage source credential is missing",
            );
        }
        preparedUsageRows.push({
            id: requiredString(row, "id", "usage source"),
            credential,
        });
    }

    for (const credential of credentialsByLegacyIdentity.values()) {
        await executor.run(
            `UPDATE "ServiceAccountToken" SET
                "service_plugin_id" = ?,
                "service_local_id" = ?,
                "qualified_service_digest" = ?,
                "connected_account_id" = ?,
                "qualified_identity_digest" = ?,
                "authentication_mode_id" = ?
             WHERE "id" = ?`,
            [
                credential.servicePluginId,
                credential.serviceLocalId,
                credential.qualifiedServiceDigest,
                credential.connectedAccountId,
                credential.qualifiedIdentityDigest,
                credential.authenticationModeId,
                credential.id,
            ],
        );
    }
    for (const group of groupsById.values()) {
        await executor.run(
            `UPDATE "ConnectedServiceAuthGroup" SET
                "service_plugin_id" = ?,
                "service_local_id" = ?,
                "qualified_service_digest" = ?,
                "qualified_group_digest" = ?,
                "active_connected_account_id" = ?
             WHERE "id" = ?`,
            [
                group.servicePluginId,
                group.serviceLocalId,
                group.qualifiedServiceDigest,
                group.qualifiedGroupDigest,
                group.activeConnectedAccountId,
                group.id,
            ],
        );
    }
    for (const member of preparedMembers) {
        await executor.run(
            `UPDATE "ConnectedServiceAuthGroupMember" SET
                "credential_id" = ?,
                "qualified_service_digest" = ?,
                "qualified_group_digest" = ?,
                "qualified_identity_digest" = ?
             WHERE "id" = ?`,
            [
                member.credential.id,
                member.credential.qualifiedServiceDigest,
                member.group.qualifiedGroupDigest,
                member.credential.qualifiedIdentityDigest,
                member.id,
            ],
        );
    }
    for (const usage of preparedUsageRows) {
        await executor.run(
            `UPDATE "ConnectedServiceUsageSource" SET
                "service_plugin_id" = ?,
                "service_local_id" = ?,
                "qualified_service_digest" = ?,
                "connected_account_id" = ?,
                "qualified_identity_digest" = ?,
                "credential_id" = ?
             WHERE "id" = ?`,
            [
                usage.credential.servicePluginId,
                usage.credential.serviceLocalId,
                usage.credential.qualifiedServiceDigest,
                usage.credential.connectedAccountId,
                usage.credential.qualifiedIdentityDigest,
                usage.credential.id,
                usage.id,
            ],
        );
    }
}

export async function prepareSqliteMigration(
    migrationName: string,
    sql: string,
    executor: SqliteMigrationExecutor,
): Promise<string> {
    const trimmed = sql.trimStart();
    const hasDirective = trimmed.startsWith(
        qualifiedConnectedAccountsV4PreparationDirective,
    );
    if (migrationName !== qualifiedConnectedAccountsV4MigrationName) {
        if (sql.includes(qualifiedConnectedAccountsV4PreparationDirective)) {
            throw new Error(
                `[sqlite-migrations] qualified Connected Accounts preparation directive is not allowed in ${migrationName}`,
            );
        }
        return sql;
    }
    if (!hasDirective) {
        throw new Error(
            `[sqlite-migrations] ${qualifiedConnectedAccountsV4MigrationName} is missing its required preparation directive`,
        );
    }
    await prepareQualifiedConnectedAccountsV4(executor);
    return trimmed
        .slice(qualifiedConnectedAccountsV4PreparationDirective.length)
        .trimStart();
}
