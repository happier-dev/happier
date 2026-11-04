import type { TeamCredentialSourceLocatorV1, TeamCredentialResourcesCursorV1 } from '@happier-dev/protocol/teams';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

type ResourceSelection = Readonly<
    | { kind: 'recipient'; teamIds: readonly string[]; resourceId?: string }
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
    const keyset = after ? [{ OR: [
        { displayName: { gt: after.displayName } },
        { displayName: after.displayName, id: { gt: after.id } },
    ] }] : [];
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
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: input.limit + 1,
        });
    }
    let candidates: Awaited<ReturnType<Tx['teamCredentialResource']['findMany']>> = [];
    // The database orders the union of bind chunks, retaining only its leading
    // page. The portable bind budget includes the optional exact-id predicate.
    for (const teamIds of portableQueryChunks({ values: selection.teamIds, bindingsPerValue: 1,
        fixedBindings: input.limit + 1 + 5 + (selection.resourceId ? 1 : 0) })) {
        candidates = await tx.teamCredentialResource.findMany({
            where: { AND: [
                { OR: [{ teamId: { in: [...teamIds] } },
                    ...(candidates.length > 0 ? [{ id: { in: candidates.map(row => row.id) } }] : [])] },
                ...(selection.resourceId ? [{ id: selection.resourceId }] : []),
                ...keyset,
            ] },
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: input.limit + 1,
        });
    }
    return candidates;
}
