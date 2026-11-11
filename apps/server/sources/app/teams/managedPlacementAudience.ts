import type { ManagedSessionPlacementV1 } from "@happier-dev/protocol/teams";
import { isTeamPrincipalRoleV1 } from "@happier-dev/protocol/teams";
import type { Tx } from "@/storage/inTx";
import { AccountStatus, TeamMembershipStatus } from "@/storage/enums.generated";
import { resolveEffectiveMachineAccessForMachinesInTx } from "@/app/machines/machineAccess";

/** Managed Machine defaults are prospective, but their target must be usable by
 * every member receiving the layer. This is the same Machine access owner used
 * by Session admission, so Action/MCP writes cannot bypass the picker rule. */
export async function managedPlacementAudienceInTx(tx: Tx,
    audience: Readonly<{ kind: "home" }> | Readonly<{ kind: "team"; teamId: string }> | Readonly<{ kind: "group"; groupId: string }>,
    placement: ManagedSessionPlacementV1 | undefined): Promise<boolean> {
    if (!placement || placement.kind !== "machine") return true;
    const memberships = audience.kind === "home"
        ? []
        : audience.kind === "group"
        ? await tx.teamGroupMembership.findMany({
            where: { teamGroupId: audience.groupId, teamMembership: { status: TeamMembershipStatus.active,
                account: { status: AccountStatus.active } } },
            select: { teamMembership: { select: { accountId: true, role: true } } },
        })
        : await tx.teamMembership.findMany({
            where: { teamId: audience.teamId, status: TeamMembershipStatus.active, account: { status: AccountStatus.active } },
            select: { accountId: true, role: true },
        });
    const accountIds = audience.kind === "home"
        ? (await tx.account.findMany({ where: { status: AccountStatus.active }, select: { id: true } })).map(account => account.id)
        : memberships
        .map(member => "teamMembership" in member ? member.teamMembership : member)
        .filter(member => isTeamPrincipalRoleV1(member.role))
        .map(member => member.accountId);
    if (accountIds.length === 0) return true;
    const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
        machineIds: [placement.target.machineId], accountIds,
    });
    return accountIds.every(accountId => access.get(placement.target.machineId)?.get(accountId) !== null);
}

