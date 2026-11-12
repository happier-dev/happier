import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

async function advanceResourceRevisionsInTx(tx: Tx, teamId: string, resourceIds: readonly string[]): Promise<void> {
    for (const ids of portableQueryChunks({ values: [...new Set(resourceIds)], bindingsPerValue: 1, fixedBindings: 1 })) {
        await tx.teamCredentialResource.updateMany({
            where: { teamId, id: { in: [...ids] } },
            data: { revision: { increment: 1 } },
        });
    }
}

/** A removed or suspended membership withdraws every resource it could use. */
export async function advanceBrokerJobRevisionsForMembershipInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; teamMembershipId: string }>,
): Promise<void> {
    const [allMembers, directGrants, groupMemberships] = await Promise.all([
        tx.teamCredentialResource.findMany({
            where: { teamId: input.teamId, allMembersDeliveryMode: { not: null } }, select: { id: true },
        }),
        tx.teamCredentialMemberGrant.findMany({
            where: { teamMembershipId: input.teamMembershipId, resource: { teamId: input.teamId } },
            select: { resourceId: true },
        }),
        tx.teamGroupMembership.findMany({
            where: { teamId: input.teamId, teamMembershipId: input.teamMembershipId }, select: { teamGroupId: true },
        }),
    ]);
    const groupGrants = [] as Array<{ resourceId: string }>;
    for (const groupIds of portableQueryChunks({
        values: groupMemberships.map(row => row.teamGroupId), bindingsPerValue: 1, fixedBindings: 1,
    })) {
        groupGrants.push(...await tx.teamCredentialGroupGrant.findMany({
            where: { teamGroupId: { in: [...groupIds] }, resource: { teamId: input.teamId } },
            select: { resourceId: true },
        }));
    }
    await advanceResourceRevisionsInTx(tx, input.teamId, [
        ...allMembers.map(row => row.id),
        ...directGrants.map(row => row.resourceId),
        ...groupGrants.map(row => row.resourceId),
    ]);
}

/** Archiving a Group or ending its last roster contribution withdraws its grants. */
export async function advanceBrokerJobRevisionsForGroupInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; teamGroupId: string }>,
): Promise<void> {
    const grants = await tx.teamCredentialGroupGrant.findMany({
        where: { teamGroupId: input.teamGroupId, resource: { teamId: input.teamId } },
        select: { resourceId: true },
    });
    await advanceResourceRevisionsInTx(tx, input.teamId, grants.map(row => row.resourceId));
}

/** Team archive withdraws every admitted credential job in that Team. */
export async function advanceBrokerJobRevisionsForTeamInTx(tx: Tx, teamId: string): Promise<void> {
    await tx.teamCredentialResource.updateMany({
        where: { teamId }, data: { revision: { increment: 1 } },
    });
}
