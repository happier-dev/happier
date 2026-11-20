import { TEAM_PRINCIPAL_ROLES_V1 } from "@happier-dev/protocol/teams";

import { getDbProviderFromEnv, resolveDbSqlDialect } from "@/config/databaseProvider";
import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { prismaRuntime } from "@/storage/prisma";

/**
 * One set of persisted grant arms serves publication, the exact census, and the
 * owed read. The owed read joins active recipient candidates before selecting
 * work, so neither the prepared envelopes nor the per-resource roster leave SQL.
 */
function savedSecretAudienceQuery() {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres"));
    const { sql, raw, join } = prismaRuntime;
    // Every identifier originates from a static Prisma schema name below.
    const id = (name: string) => raw(dialect === "mysql" ? `\`${name}\`` : `"${name}"`);
    const roles = join(TEAM_PRINCIPAL_ROLES_V1.map(role =>
        dialect === "postgres" ? sql`CAST(${role} AS ${id("TeamRole")})` : sql`${role}`));
    const audience = (filter?: "candidates" | "ready") => {
        const restrict = (recipient: ReturnType<typeof sql>) => filter === undefined
            ? prismaRuntime.empty : sql`JOIN ${id(filter)} selected ON selected.recipient_id = ${recipient}`;
        return sql`
        SELECT r.id AS resource_id, r.owner_id AS recipient_id FROM resources r
        ${restrict(sql`r.owner_id`)}
        UNION ALL
        SELECT r.id, g.${id("accountId")}
        FROM resources r JOIN ${id("SavedSecretAccountGrant")} g ON g.${id("resourceId")} = r.id
        ${restrict(sql`g.${id("accountId")}`)}
        UNION ALL
        SELECT r.id, m.${id("accountId")}
        FROM resources r
        JOIN ${id("SavedSecretTeamGrant")} g ON g.${id("resourceId")} = r.id
        JOIN ${id("Team")} t ON t.id = g.${id("teamId")} AND t.${id("archivedAt")} IS NULL
        JOIN ${id("TeamMembership")} m ON m.${id("teamId")} = t.id AND m.status = 'active' AND m.role IN (${roles})
        JOIN ${id("Account")} a ON a.id = m.${id("accountId")} AND a.status = 'active'
        ${restrict(sql`m.${id("accountId")}`)}
        UNION ALL
        SELECT r.id, m.${id("accountId")}
        FROM resources r
        JOIN ${id("SavedSecretGroupGrant")} grant_row ON grant_row.${id("resourceId")} = r.id
        JOIN ${id("TeamGroup")} g ON g.id = grant_row.${id("teamGroupId")} AND g.${id("archivedAt")} IS NULL
        JOIN ${id("Team")} t ON t.id = g.${id("teamId")} AND t.${id("archivedAt")} IS NULL
        JOIN ${id("TeamGroupMembership")} gm ON gm.${id("teamGroupId")} = g.id AND gm.${id("teamId")} = t.id
        JOIN ${id("TeamMembership")} m ON m.id = gm.${id("teamMembershipId")}
            AND m.${id("teamId")} = t.id AND m.status = 'active'
        JOIN ${id("Account")} a ON a.id = m.${id("accountId")} AND a.status = 'active'
        ${restrict(sql`m.${id("accountId")}`)}`;
    };
    const ownedEncrypted = (accountId: string) => sql`
        SELECT id, revision, ${id("ownerAccountId")} AS owner_id
        FROM ${id("SavedSecretResource")}
        WHERE ${id("ownerAccountId")} = ${accountId} AND ${id("encryptionMode")} = 'e2ee'`;
    return { dialect, id, audience, ownedEncrypted };
}

export async function readSavedSecretAuthorizedAccountIdsInTx(
    tx: Tx,
    resourceIds: readonly string[],
): Promise<readonly string[]> {
    const { id, audience } = savedSecretAudienceQuery();
    const { sql, join } = prismaRuntime;
    const accounts = new Set<string>();
    for (const ids of portableQueryChunks({ values: [...new Set(resourceIds)], bindingsPerValue: 1, fixedBindings: TEAM_PRINCIPAL_ROLES_V1.length })) {
        const rows = await tx.$queryRaw<{ recipient_id: string }[]>(sql`
            WITH resources AS (
                SELECT id, ${id("ownerAccountId")} AS owner_id FROM ${id("SavedSecretResource")} WHERE id IN (${join([...ids])})
            ), audience AS (${audience()})
            SELECT DISTINCT recipient_id FROM audience`);
        for (const row of rows) accounts.add(row.recipient_id);
    }
    return [...accounts];
}

export async function readOwedSavedSecretCandidateAccountIdsInTx(tx: Tx, accountId: string): Promise<readonly string[]> {
    const { id, audience, ownedEncrypted } = savedSecretAudienceQuery();
    const rows = await tx.$queryRaw<{ recipient_id: string }[]>(prismaRuntime.sql`
        WITH resources AS (${ownedEncrypted(accountId)}), candidates AS (
            SELECT id AS recipient_id FROM ${id("Account")}
            WHERE status = 'active' AND ${id("encryptionMode")} = 'e2ee'
                AND ${id("contentPublicKey")} IS NOT NULL AND ${id("contentPublicKeySig")} IS NOT NULL
        ), audience AS (${audience("candidates")})
        SELECT DISTINCT recipient_id FROM audience`);
    return rows.map(row => row.recipient_id);
}

export type OwedSavedSecretRecipient = Readonly<{
    resource_id: string;
    revision: number;
    recipient_id: string;
    current_fingerprint: string | null;
}>;

export async function readOwedSavedSecretRecipientsInTx(
    tx: Tx,
    accountId: string,
    candidates: readonly { accountId: string; fingerprint: string }[],
): Promise<readonly OwedSavedSecretRecipient[]> {
    const { dialect, id, audience, ownedEncrypted } = savedSecretAudienceQuery();
    const { sql } = prismaRuntime;
    const bindings = JSON.stringify(candidates);
    const ready = dialect === "postgres"
        ? sql`SELECT "accountId" AS recipient_id, fingerprint
            FROM jsonb_to_recordset(CAST(${bindings} AS jsonb)) AS candidates("accountId" text, fingerprint text)`
        : dialect === "mysql"
            ? sql`SELECT recipient_id COLLATE utf8mb4_unicode_ci AS recipient_id, fingerprint
                FROM JSON_TABLE(${bindings}, '$[*]' COLUMNS (
                    recipient_id VARCHAR(191) PATH '$.accountId', fingerprint VARCHAR(191) PATH '$.fingerprint'
                )) AS candidates`
            : sql`SELECT json_extract(value, '$.accountId') AS recipient_id,
                json_extract(value, '$.fingerprint') AS fingerprint FROM json_each(${bindings})`;
    const fingerprint = sql`e.${id("recipientContentPublicKeyFingerprint")}`;
    const sameFingerprint = dialect === "mysql"
        ? sql`CAST(${fingerprint} AS BINARY) = CAST(ready.fingerprint AS BINARY)`
        : sql`${fingerprint} = ready.fingerprint`;
    return await tx.$queryRaw<OwedSavedSecretRecipient[]>(sql`
        WITH resources AS (${ownedEncrypted(accountId)}), ready AS (${ready}), audience AS (${audience("ready")})
        SELECT DISTINCT audience.resource_id, resources.revision, audience.recipient_id, ${fingerprint} AS current_fingerprint
        FROM audience
        JOIN ready ON ready.recipient_id = audience.recipient_id
        JOIN resources ON resources.id = audience.resource_id
        LEFT JOIN ${id("SavedSecretResourceKeyEnvelope")} e
            ON e.${id("resourceId")} = audience.resource_id AND e.${id("recipientAccountId")} = audience.recipient_id
        WHERE ${fingerprint} IS NULL OR NOT (${sameFingerprint})
        ORDER BY audience.resource_id, audience.recipient_id`);
}
