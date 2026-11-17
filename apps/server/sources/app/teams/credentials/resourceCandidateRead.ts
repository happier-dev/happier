import type { TeamCredentialSourceLocatorV1, TeamCredentialResourcesCursorV1 } from '@happier-dev/protocol/teams';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { teamCredentialRecipientCatalogSql } from './resourceAccess';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';

type ResourceSelection = Readonly<
    | { kind: 'recipient'; accountId: string; teamIds: readonly string[]; resourceId?: string }
    | { kind: 'custodian'; accountId: string; source?: TeamCredentialSourceLocatorV1; directOnly?: true }
>;

/** Administration and custodian selection use the same stored audience routes. */
export function teamCredentialAudienceDeliveryWhere(mode: 'direct' | 'brokered') {
    const deliveryModes = [mode, 'both'];
    return { OR: [
        { allMembersDeliveryMode: { in: deliveryModes } },
        { allMembersDeliveryMode: { contains: JSON.stringify(mode) } },
        { groupGrants: { some: { OR: [{ deliveryMode: { in: deliveryModes } }, { deliveryMode: { contains: JSON.stringify(mode) } }] } } },
        { memberGrants: { some: { OR: [{ deliveryMode: { in: deliveryModes } }, { deliveryMode: { contains: JSON.stringify(mode) } }] } } },
    ] };
}

/** One candidate-window owner for exact recipient, source and custodian reads.
 * Callers retain their existing authorization and current-source projections. */
export async function readTeamCredentialResourceCandidatesInTx(tx: Tx, input: Readonly<{
    selection: ResourceSelection;
    after: TeamCredentialResourcesCursorV1 | null;
    limit: number;
}>) {
    const after = input.after;
    // Labels are recipient-scoped opaque envelopes. Database ordering and
    // keysets intentionally use the public structural identifier only; the
    // client sorts/searches labels after opening its loaded projections.
    const keyset = after ? [{ id: { gt: after.id } }] : [];
    const selection = input.selection;
    if (selection.kind === 'custodian') {
        const source = selection.source;
        const sourceIdentityNeedle = !source ? undefined : source.kind === 'provider_connection'
            ? `"connectionId":${JSON.stringify(source.connectionId)}`
            : source.kind === 'connected_pool'
                ? `"groupId":${JSON.stringify(source.target.groupId)}`
                : `"accountId":${JSON.stringify(source.target.account.accountId)}`;
        return tx.teamCredentialResource.findMany({
            where: {
                custodianAccountId: selection.accountId,
                ...(sourceIdentityNeedle ? { sourceBindingJson: { contains: sourceIdentityNeedle } } : {}),
                ...(selection.directOnly ? {
                    enabled: true,
                    team: { archivedAt: null, memberships: { some: { accountId: selection.accountId, status: 'active' } } },
                } : {}),
                AND: [...keyset, ...(selection.directOnly ? [
                    { OR: [{ disclosureCeiling: 'direct_allowed' }, { disclosureCeiling: { contains: '"direct"' } }] },
                    teamCredentialAudienceDeliveryWhere('direct'),
                ] : [])],
            },
            orderBy: { id: 'asc' }, take: input.limit + 1,
        });
    }
    const sql = prismaRuntime.sql;
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const resourceTable = prismaRuntime.raw(provider === 'mysql' ? '`TeamCredentialResource`' : '"TeamCredentialResource"');
    const idColumn = prismaRuntime.raw(provider === 'mysql' ? '`a`.`id`' : '"a"."id"');
    let candidateIds: string[] = [];
    // Derive the actual fixed bind cost from the one eligibility owner, retaining
    // room for the previous top page, the keyset and SQL LIMIT.
    const fixedBindings = teamCredentialRecipientCatalogSql({ accountId: selection.accountId,
        teamIds: [''], resourceId: selection.resourceId }).values.length - 1
        + input.limit + 1 + (after ? 1 : 0) + 1;
    for (const teamIds of portableQueryChunks({ values: selection.teamIds, bindingsPerValue: 1, fixedBindings })) {
        const eligible = teamCredentialRecipientCatalogSql({ accountId: selection.accountId,
            teamIds, resourceId: selection.resourceId });
        const rows = await tx.$queryRaw<{ id: string }[]>(sql`
            SELECT ${idColumn} AS id FROM ${resourceTable} a
            WHERE (${eligible} ${candidateIds.length === 0 ? sql`` : sql`OR ${idColumn} IN (${prismaRuntime.join(candidateIds)})`})
                ${after ? sql`AND ${idColumn} > ${after.id}` : sql``}
            ORDER BY ${idColumn} ASC LIMIT ${input.limit + 1}
        `);
        candidateIds = rows.map(row => row.id);
    }
    if (candidateIds.length === 0) return [];
    return tx.teamCredentialResource.findMany({ where: { id: { in: candidateIds } }, orderBy: { id: 'asc' } });
}
