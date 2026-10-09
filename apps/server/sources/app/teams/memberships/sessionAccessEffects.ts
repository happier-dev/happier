import { afterTx, type Tx } from "@/storage/inTx";
import { notifySessionHumanPresenceAccessChanged } from "@/app/session/humanPresence/sessionHumanPresenceService";
import { markCurrentSessionReadersChanged } from "@/app/session/changeTracking/markCurrentSessionReadersChanged";
import {
    captureMachineAccessImpactsInTx,
    applyMachineAccessImpactsInTx,
    type MachineAccessImpact,
} from "@/app/machines/machineAccessEffects";
import {
    captureSessionAccessMembershipImpactsInTx,
    applySessionAccessMembershipImpactsInTx,
    mergeSessionAccessMembershipImpactOrigin,
    type SessionAccessMembershipChange,
    type SessionAccessMembershipImpact,
    type SessionAccessMembershipOrigin,
} from "@/app/session/access/sessionAccessMembershipImpact";

/** Before-state captured by an enclosing atomic mutation of this Team. */
export type TeamSessionAccessImpacts = ReadonlyMap<string, Readonly<{
    session: SessionAccessMembershipImpact;
    machine: MachineAccessImpact;
}>>;

/**
 * Publish a credential-context transition for Sessions whose collective access
 * depends on one of the affected Teams.
 *
 * Authentication policy and provider/connection currentness do not change
 * structural membership, grants, or collaborator-owned personal state. They
 * only invalidate the ordinary Session projection and ask the existing
 * presence owner to re-evaluate each exact socket credential after commit.
 */
export async function applyTeamSessionAuthenticationContextEffectsInTx(
    tx: Tx,
    input: Readonly<{ teamIds: readonly string[] }>,
): Promise<void> {
    const teamIds = [...new Set(input.teamIds.filter(Boolean))];
    if (teamIds.length === 0) return;

    const sessions = await tx.session.findMany({
        where: {
            OR: [
                { teamGrants: { some: { teamId: { in: teamIds } } } },
                { groupGrants: { some: { teamGroup: { teamId: { in: teamIds } } } } },
            ],
        },
        select: { id: true },
        orderBy: { id: "asc" },
    });
    for (const session of sessions) {
        await markCurrentSessionReadersChanged({ tx, sessionId: session.id });
        afterTx(tx, () => notifySessionHumanPresenceAccessChanged({ sessionId: session.id }));
    }
}

/**
 * Compose native facts with the Session and Machine owners' before/after effects. Bulk
 * directory changes capture their complete Account set first and pass it to
 * nested mutations, so an intermediate access loss cannot clear personal state.
 * This helper neither evaluates access nor writes personal Session state.
 *
 * `origin` is the mutation owner's authoritative statement about whether this
 * transition can create a genuinely new relationship. A reversible lifecycle
 * mutation states `retained_lifecycle`, so restoring retained Team, Group, or
 * membership state cannot subscribe an opted-in Account to work it never chose.
 */
export async function withTeamSessionAccessEffectsInTx<T>(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        origin: SessionAccessMembershipOrigin;
        accountIds?: readonly string[];
        teamGroupId?: string;
        change?: SessionAccessMembershipChange;
        sessionAccessImpacts?: TeamSessionAccessImpacts;
    }>,
    mutate: (impacts: TeamSessionAccessImpacts) => Promise<T>,
): Promise<T> {
    const accountIds = input.accountIds ?? (await tx.teamMembership.findMany({
        where: {
            teamId: input.teamId,
            ...(input.teamGroupId ? { groupMemberships: { some: { teamGroupId: input.teamGroupId } } } : {}),
        },
        select: { accountId: true },
    })).map(member => member.accountId);
    const uniqueAccountIds = [...new Set(accountIds)];
    const impacts = new Map(input.sessionAccessImpacts);
    const ownedAccountIds = uniqueAccountIds.filter(accountId => !impacts.has(accountId));
    const change = input.change ?? (input.teamGroupId
        ? { kind: "teamGroupMembership" as const, teamId: input.teamId, teamGroupIds: [input.teamGroupId] }
        : { kind: "teamMembership" as const, teamId: input.teamId });
    const captured = await captureSessionAccessMembershipImpactsInTx(tx, {
        accountIds: ownedAccountIds,
        changes: [change],
        origin: input.origin,
    });
    const machines = ownedAccountIds.length === 0 ? [] : await tx.machine.findMany({
        where: change.kind === "teamGroupMembership"
            ? { groupGrants: { some: { teamGroupId: { in: [...change.teamGroupIds] }, teamGroup: { teamId: change.teamId } } } }
            : { OR: [
                { teamGrants: { some: { teamId: change.teamId } } },
                { groupGrants: { some: { teamGroup: { teamId: change.teamId } } } },
            ] },
        select: { id: true },
    });
    const machineImpacts = await captureMachineAccessImpactsInTx(tx, {
        accountIds: ownedAccountIds,
        machineIds: machines.map(machine => machine.id),
    });
    const owned: SessionAccessMembershipImpact[] = [];
    for (const [accountId, impact] of captured) {
        const machine = machineImpacts.get(accountId);
        if (!machine) throw new Error("Machine membership before-state must be captured with Session before-state");
        impacts.set(accountId, { session: impact, machine });
        owned.push(impact);
    }
    for (const accountId of uniqueAccountIds) {
        const impact = impacts.get(accountId);
        if (impact) mergeSessionAccessMembershipImpactOrigin(impact.session, input.origin);
    }
    const result = await mutate(impacts);
    await applySessionAccessMembershipImpactsInTx(tx, { impacts: owned });
    await applyMachineAccessImpactsInTx(tx, { impacts: machineImpacts.values() });
    return result;
}
