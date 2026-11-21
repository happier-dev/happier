import { getDbProviderFromEnv, resolveDbSqlDialect } from '@/config/databaseProvider';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';

/** Select owed IDs in storage. Prepared launches and recipient rosters stay in the database. */
export async function readOwedMachinePresetIdsInTx(tx: Tx, input: Readonly<{
    homeId: string;
    actorAccountId: string;
    candidates: readonly { teamId: string; accountId: string; fingerprint: string }[];
}>): Promise<readonly string[]> {
    if (input.candidates.length === 0) return [];
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const { sql, raw } = prismaRuntime;
    const id = (name: string) => raw(dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
    const json = JSON.stringify(input.candidates);
    const ready = dialect === 'postgres'
        ? sql`SELECT "teamId" AS team_id, "accountId" AS account_id, fingerprint
            FROM jsonb_to_recordset(CAST(${json} AS jsonb)) AS c("teamId" text, "accountId" text, fingerprint text)`
        : dialect === 'mysql'
            ? sql`SELECT team_id COLLATE utf8mb4_unicode_ci AS team_id,
                account_id COLLATE utf8mb4_unicode_ci AS account_id, fingerprint
                FROM JSON_TABLE(${json}, '$[*]' COLUMNS (
                    team_id VARCHAR(191) PATH '$.teamId', account_id VARCHAR(191) PATH '$.accountId',
                    fingerprint VARCHAR(191) PATH '$.fingerprint'
                )) AS c`
            : sql`SELECT json_extract(value, '$.teamId') AS team_id, json_extract(value, '$.accountId') AS account_id,
                json_extract(value, '$.fingerprint') AS fingerprint FROM json_each(${json})`;

    const mode = dialect === 'postgres' ? sql`p.launch->>'contentEncryptionMode'`
        : dialect === 'mysql' ? sql`JSON_UNQUOTE(JSON_EXTRACT(p.launch, '$.contentEncryptionMode'))`
            : sql`json_extract(p.launch, '$.contentEncryptionMode')`;
    const tag = dialect === 'postgres' ? sql`p.launch->'content'->>'t'`
        : dialect === 'mysql' ? sql`JSON_UNQUOTE(JSON_EXTRACT(p.launch, '$.content.t'))`
            : sql`json_extract(p.launch, '$.content.t')`;
    // An older plain carrier may have arbitrary JSON. Only an admitted E2EE array can describe recipients.
    const stored = dialect === 'postgres'
        ? sql`jsonb_to_recordset(CASE WHEN jsonb_typeof(p.launch->'recipients') = 'array'
            THEN p.launch->'recipients' ELSE '[]'::jsonb END) AS e("accountId" text, envelope jsonb)`
        : dialect === 'mysql'
            ? sql`JSON_TABLE(p.launch, '$.recipients[*]' COLUMNS (
                account_id VARCHAR(191) PATH '$.accountId',
                fingerprint VARCHAR(191) PATH '$.envelope.recipientContentPublicKeyFingerprint',
                data_key TEXT PATH '$.envelope.encryptedDataKey'
            )) AS e`
            : sql`json_each(p.launch, '$.recipients') AS e`;
    const accountId = dialect === 'postgres' ? sql`e."accountId"`
        : dialect === 'mysql' ? sql`e.account_id COLLATE utf8mb4_unicode_ci`
            : sql`json_extract(e.value, '$.accountId')`;
    const fingerprint = dialect === 'postgres' ? sql`e.envelope->>'recipientContentPublicKeyFingerprint'`
        : dialect === 'mysql' ? sql`e.fingerprint`
            : sql`json_extract(e.value, '$.envelope.recipientContentPublicKeyFingerprint')`;
    const dataKey = dialect === 'postgres' ? sql`e.envelope->>'encryptedDataKey'`
        : dialect === 'mysql' ? sql`e.data_key`
            : sql`json_extract(e.value, '$.envelope.encryptedDataKey')`;
    const prepared = dialect === 'mysql' ? sql`CAST(${fingerprint} AS BINARY) = CAST(ready.fingerprint AS BINARY)`
        : sql`${fingerprint} = ready.fingerprint`;

    const rows = await tx.$queryRaw<{ id: string }[]>(sql`
        WITH ready AS (${ready}), audience_counts AS (
            SELECT team_id, COUNT(*) AS expected FROM ready GROUP BY team_id
        )
        SELECT p.id FROM ${id('ManagedMachinePreset')} p
        JOIN audience_counts a ON a.team_id = p.${id('teamId')}
        WHERE p.${id('homeId')} = ${input.homeId} AND p.${id('archivedAt')} IS NULL
            AND ${mode} = 'e2ee' AND ${tag} = 'encrypted'
            AND EXISTS (
                SELECT 1 FROM ${stored}
                WHERE ${accountId} = ${input.actorAccountId} AND ${dataKey} <> ''
            )
            AND (SELECT COUNT(*) FROM ${stored}
                JOIN ready ON ready.team_id = a.team_id AND ready.account_id = ${accountId}
                WHERE ${dataKey} <> '' AND ${prepared}
            ) < a.expected
        ORDER BY p.id`);
    return rows.map(row => row.id);
}
