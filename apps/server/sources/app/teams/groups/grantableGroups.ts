import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { resolveGrantableTeamsForActorInTx } from "../queries";

/** Selected Group identities and labels, admitted by the same Team membership owner. */
export async function resolveGrantableTeamGroupsForActorInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        groups: readonly Readonly<{ teamId: string; groupId: string }>[];
        /** Only the canonical Team reader's result for this actor in this exact operation/transaction. */
        grantableTeamIds?: ReadonlySet<string>;
    }>,
): Promise<ReadonlyMap<string, Readonly<{ teamId: string; groupId: string; name: string }>>> {
    if (input.groups.length === 0) return new Map();
    const grantableTeamIds = input.grantableTeamIds ?? await resolveGrantableTeamsForActorInTx(tx, {
        actorAccountId: input.actorAccountId, teamIds: input.groups.map(group => group.teamId),
    });
    const groupIds = [...new Set(input.groups.filter(group => grantableTeamIds.has(group.teamId)).map(group => group.groupId))];
    if (groupIds.length === 0) return new Map();
    const groups = (await Promise.all(portableQueryChunks({ values: groupIds, bindingsPerValue: 1, fixedBindings: 1 }).map(ids => tx.teamGroup.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, teamId: true, name: true, archivedAt: true },
    })))).flat();
    return new Map(groups.filter(group => group.archivedAt === null && grantableTeamIds.has(group.teamId))
        .map(group => [group.id, { teamId: group.teamId, groupId: group.id, name: group.name }]));
}
