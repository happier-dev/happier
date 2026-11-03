import { encodeBase64 } from 'privacy-kit';
import { MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1 } from '@happier-dev/protocol/changes';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { MachineAccessRecipientCensusResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/db';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { AccountStatus, TeamMembershipStatus } from '@/storage/enums.generated';
import { isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import { isEffectiveTeamGroupMembership } from '@/app/teams/groups/effectiveGroupMembership';
import { createAccountRecipientEnvelopeReadinessReadScope, deriveAccountRecipientEnvelopeReadinessFromRow,
    type AccountRecipientEnvelopeReadiness } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { projectRecipientContentKey, type RecipientReadinessRow } from '@/app/session/encryption/sessionDataKeyRecipientProjection';

type Recipient = MachineAccessRecipientCensusResponseV1['recipients'][number] & Readonly<{ current: boolean }>;
type RecipientWork = { cursor: number; recipients: Recipient[] };
type AudienceRow = Readonly<{
    machineId: string; custodianAccountId: string;
    source: 'account' | 'team' | 'group' | null;
    membershipStatus: TeamMembershipStatus | null;
    teamArchivedAt: Date | number | bigint | null; groupArchivedAt: Date | number | bigint | null;
    id: string | null; status: AccountStatus | null;
}>;
type RecipientRow = AudienceRow & Readonly<{
    cursor: number | bigint | null;
    publicKey: string | null; encryptionMode: string | null;
    contentPublicKey: Uint8Array | null; contentPublicKeySig: Uint8Array | null;
    encryptedDataKey: Uint8Array | null; machineOwnerEnvelopeFingerprint: string | null;
    recipientContentPublicKeyFingerprint: string | null;
}>;

/** One membership acquisition for structural and recipient-envelope projections. */
function machineAudienceQuery(ids: readonly string[], provider: ReturnType<typeof getDbProviderFromEnv>, custodianAccountId?: string) {
    const bind = (index: number) => provider === 'postgres' ? `$${index}` : '?';
    // PostgreSQL resolves the first two UNION arms before the third.
    const absentArchive = provider === 'postgres' ? 'CAST(NULL AS TIMESTAMP)' : 'NULL';
    const selection = custodianAccountId === undefined
        ? `SELECT "id", "accountId" FROM "Machine" WHERE "id" IN (${ids.map((_, index) => bind(index + 1)).join(',')})`
        : `SELECT ${bind(1)} AS "id", ${bind(2)} AS "accountId"`;
    const sql = `WITH selected AS (
        ${selection}
    ), audience AS (
        SELECT g."machineId", g."accountId", 'account' AS "source", NULL AS "membershipStatus",
            ${absentArchive} AS "teamArchivedAt", ${absentArchive} AS "groupArchivedAt"
        FROM "MachineAccountGrant" g JOIN selected s ON s."id" = g."machineId"
        UNION ALL
        SELECT g."machineId", tm."accountId", 'team', tm."status", t."archivedAt", ${absentArchive}
        FROM "MachineTeamGrant" g JOIN selected s ON s."id" = g."machineId"
        JOIN "Team" t ON t."id" = g."teamId" JOIN "TeamMembership" tm ON tm."teamId" = t."id"
        UNION ALL
        SELECT g."machineId", tm."accountId", 'group', tm."status", t."archivedAt", tg."archivedAt"
        FROM "MachineGroupGrant" g JOIN selected s ON s."id" = g."machineId"
        JOIN "TeamGroup" tg ON tg."id" = g."teamGroupId" JOIN "Team" t ON t."id" = tg."teamId"
        JOIN "TeamGroupMembership" gm ON gm."teamGroupId" = tg."id"
        JOIN "TeamMembership" tm ON tm."id" = gm."teamMembershipId"
    )`;
    return { sql, bind };
}

function isEffectiveAudienceRecipient<T extends AudienceRow>(row: T): row is T & { id: string; status: 'active' } {
    if (!row.id || row.id === row.custodianAccountId || row.status !== 'active') return false;
    const lifetime = { accountStatus: row.status, membershipStatus: row.membershipStatus ?? 'active',
        teamArchivedAt: row.teamArchivedAt === null ? null : new Date(Number(row.teamArchivedAt)) };
    if (row.source === 'team') return isEffectiveTeamMembership(lifetime);
    if (row.source === 'group') return isEffectiveTeamGroupMembership({ ...lifetime,
        groupArchivedAt: row.groupArchivedAt === null ? null : new Date(Number(row.groupArchivedAt)) });
    return true;
}

/** Notification/liveness reads need membership only, never content or wrapping material. */
export async function readMachineAudienceAccountIdsInTx(tx: Tx, machineId: string, custodianAccountId?: string): Promise<string[]> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    // A successful presence renewal already proved this Machine's custodian.
    // Acquire only current membership; do not read that Machine a second time.
    const { sql: membership } = machineAudienceQuery([machineId], provider, custodianAccountId);
    const sql = `${membership} SELECT s."id" AS "machineId", s."accountId" AS "custodianAccountId",
        r."source", r."membershipStatus", r."teamArchivedAt", r."groupArchivedAt", a."id", a."status"
        FROM selected s LEFT JOIN audience r ON r."machineId" = s."id"
        LEFT JOIN "Account" a ON a."id" = r."accountId"`;
    const rows = await tx.$queryRawUnsafe<AudienceRow[]>(provider === 'mysql' ? sql.replaceAll('"', '`') : sql,
        ...(custodianAccountId === undefined ? [machineId] : [machineId, custodianAccountId]));
    const accountIds = new Set<string>();
    for (const row of rows) {
        // Custody is structural even while its Account cannot execute work.
        accountIds.add(row.custodianAccountId);
        if (isEffectiveAudienceRecipient(row)) accountIds.add(row.id);
    }
    return [...accountIds].sort();
}

/** Shared by the compact Machine fact and the exact action_required page. */
export function isMachineRecipientWorkPending(recipient: Recipient): boolean {
    return !recipient.current;
}

/** One binding/envelope predicate for summary and paged recipient projections. */
export function projectMachineRecipientWork(account: RecipientReadinessRow, envelope: Readonly<{
    encryptedDataKey: Uint8Array | null;
    machineOwnerEnvelopeFingerprint: string | null;
    recipientContentPublicKeyFingerprint: string | null;
}> | null, ownerFingerprint: string | null,
readiness: AccountRecipientEnvelopeReadiness = deriveAccountRecipientEnvelopeReadinessFromRow(account)): Recipient {
    const publicFingerprint = readiness.status === 'available' ? readiness.binding.contentPublicKeyFingerprint : null;
    const current = readiness.status === 'available'
        && envelope !== null && envelope.machineOwnerEnvelopeFingerprint === ownerFingerprint
        && envelope.recipientContentPublicKeyFingerprint === publicFingerprint
        && envelope.encryptedDataKey !== null && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null;
    return { recipientAccountId: account.id, contentKey: projectRecipientContentKey(account, readiness),
        contentPublicKeyFingerprint: publicFingerprint, current,
        encryptedDataKey: current ? encodeBase64(new Uint8Array(envelope.encryptedDataKey!)) : null,
        recipientContentPublicKeyFingerprint: current ? envelope.recipientContentPublicKeyFingerprint : null };
}

/**
 * The Machine access owner supplies only its already-admitted Manage targets.
 * One relational acquisition per portable bind chunk gathers their audience,
 * bindings, tuples and existing recipient-change cursors. No per-Machine query
 * or new cursor/queue is introduced. Policy and signature checks remain in JS.
 */
export async function readMachineRecipientWorkInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    ownerFingerprints: ReadonlyMap<string, string | null>;
}>): Promise<ReadonlyMap<string, RecipientWork>> {
    const result = new Map<string, RecipientWork>();
    const readinessFor = createAccountRecipientEnvelopeReadinessReadScope();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    // One binding per selected ID, plus Account and change-kind equalities.
    for (const ids of portableQueryChunks({ values: [...input.ownerFingerprints.keys()], bindingsPerValue: 1, fixedBindings: 2 })) {
        const { sql: membership, bind } = machineAudienceQuery(ids, provider);
        const sql = `${membership} SELECT s."id" AS "machineId", s."accountId" AS "custodianAccountId", c."cursor",
            r."source", r."membershipStatus", r."teamArchivedAt", r."groupArchivedAt",
            a."id", a."status", a."publicKey", a."encryptionMode", a."contentPublicKey", a."contentPublicKeySig",
            e."encryptedDataKey", e."machineOwnerEnvelopeFingerprint", e."recipientContentPublicKeyFingerprint"
        FROM selected s LEFT JOIN audience r ON r."machineId" = s."id"
        LEFT JOIN "Account" a ON a."id" = r."accountId"
        LEFT JOIN "MachineKeyEnvelope" e ON e."machineId" = s."id" AND e."recipientAccountId" = a."id"
        LEFT JOIN "AccountChange" c ON c."entityId" = s."id" AND c."accountId" = ${bind(ids.length + 1)} AND c."kind" = ${bind(ids.length + 2)}`;
        const rows = await tx.$queryRawUnsafe<RecipientRow[]>(provider === 'mysql' ? sql.replaceAll('"', '`') : sql,
            ...ids, input.actorAccountId, MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1);
        const seen = new Map<string, Set<string>>();
        for (const row of rows) {
            let work = result.get(row.machineId);
            if (!work) {
                work = { cursor: row.cursor === null ? 0 : Number(row.cursor), recipients: [] };
                result.set(row.machineId, work);
            }
            if (!isEffectiveAudienceRecipient(row)) continue;
            const recipients = seen.get(row.machineId) ?? new Set<string>();
            if (recipients.has(row.id)) continue;
            recipients.add(row.id);
            seen.set(row.machineId, recipients);
            const account = { ...row, id: row.id };
            work.recipients.push(projectMachineRecipientWork(account, row,
                input.ownerFingerprints.get(row.machineId) ?? null, readinessFor(account)));
        }
    }
    for (const work of result.values()) work.recipients.sort((a, b) => a.recipientAccountId < b.recipientAccountId ? -1 : a.recipientAccountId > b.recipientAccountId ? 1 : 0);
    return result;
}
