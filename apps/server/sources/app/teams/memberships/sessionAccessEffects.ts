import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { afterTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { readTeamChangePublicationAudienceInTx } from "../teamChanges";
import { notifySessionHumanPresenceAccessChanged } from "@/app/session/humanPresence/sessionHumanPresenceService";
import { markCurrentSessionReadersChanged } from "@/app/session/changeTracking/markCurrentSessionReadersChanged";
import { readSessionAccountCursorAudienceInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import {
    captureMachineAccessImpactsInTx,
    applyMachineAccessImpactsInTx,
    readMachineAccessImpactPublicationAudienceInTx,
    type MachineAccessImpact,
} from "@/app/machines/machineAccessEffects";
import {
    readSessionAccessMembershipChangeSessionIdsInTx,
    captureSessionAccessMembershipImpactsInTx,
    readSessionAccessMembershipChangeAudienceInTx,
    applySessionAccessMembershipImpactsInTx,
    type SessionAccessMembershipChange,
    type SessionAccessMembershipImpact,
} from "@/app/session/access/sessionAccessMembershipImpact";

/** Before-state captured by an enclosing atomic mutation of this Team. */
export type TeamSessionAccessImpacts = ReadonlyMap<string, Readonly<{
    session: SessionAccessMembershipImpact;
    machine: MachineAccessImpact;
}>>;

export type TeamMutationAdmissionScope = Readonly<{
    teamId: string;
    accountIds: readonly string[];
    membershipChange?: SessionAccessMembershipChange;
    affectedAccountIds?: readonly string[];
    intent?: AccountAdmissionIntent;
}>;

async function readTeamMembershipEffectMachinesInTx(tx: Tx, change: SessionAccessMembershipChange, accountIds: readonly string[]) {
    if (accountIds.length === 0) return [];
    const machineIds = new Set<string>();
    if (change.kind !== "teamGroupMembership") {
        const grants = await tx.machineTeamGrant.findMany({ where: { teamId: change.teamId }, select: { machineId: true } });
        for (const grant of grants) machineIds.add(grant.machineId);
    }
    const groups = await tx.teamGroup.findMany({ where: { teamId: change.teamId,
        ...(change.kind === "teamGroupMembership" ? { id: { in: [...change.teamGroupIds] } } : {}) }, select: { id: true } });
    for (const ids of portableQueryChunks({ values: groups.map(group => group.id), bindingsPerValue: 1 })) {
        const grants = await tx.machineGroupGrant.findMany({ where: { teamGroupId: { in: [...ids] } }, select: { machineId: true } });
        for (const grant of grants) machineIds.add(grant.machineId);
    }
    return [...machineIds].map(id => ({ id }));
}

export async function readTeamMutationAdmissionAccountIdsInTx(tx: Tx, input: TeamMutationAdmissionScope): Promise<readonly string[]> {
    const teamPublicationAccountIds = await readTeamChangePublicationAudienceInTx(tx, { teamIds: [input.teamId] });
    if (!input.membershipChange) return [...new Set([...input.accountIds, ...teamPublicationAccountIds])].sort();
    const change = input.membershipChange;
    const affectedAccountIds = input.affectedAccountIds ?? (await tx.teamMembership.findMany({
        where: { teamId: input.teamId, ...(change.kind === "teamGroupMembership"
            ? { groupMemberships: { some: { teamGroupId: { in: [...change.teamGroupIds] } } } } : {}) },
        select: { accountId: true },
    })).map(member => member.accountId);
    const sessionAudience = await readSessionAccessMembershipChangeAudienceInTx(tx, {
        accountIds: affectedAccountIds, changes: [change], additionalAdmissionAccountIds: input.accountIds,
    });
    const machines = await readTeamMembershipEffectMachinesInTx(tx, change, affectedAccountIds);
    const machineAccountIds = await readMachineAccessImpactPublicationAudienceInTx(tx, {
        machineIds: machines.map(machine => machine.id), accountIds: affectedAccountIds,
    });
    return [...new Set([...input.accountIds, ...affectedAccountIds, ...sessionAudience.accountIds,
        ...machineAccountIds, ...teamPublicationAccountIds])].sort();
}

/** Admit the complete resource-effect scope before authority reads or resource
 * locks. Call the returned recheck after a later Team lock, before effects. */
export async function acquireTeamMutationAccountAdmissionInTx(
    tx: Tx, input: TeamMutationAdmissionScope,
): Promise<() => Promise<void>> {
    const accountIds = await readTeamMutationAdmissionAccountIdsInTx(tx, input);
    await acquireAccountChangePublicationLocksInTx(tx, accountIds, { includeSingleAccount: true, intent: input.intent ?? "content" });
    const admitted = new Set(accountIds);
    const recheck = async () => {
        const current = await readTeamMutationAdmissionAccountIdsInTx(tx, input);
        if (current.some(accountId => !admitted.has(accountId))) {
            throw new TransactionReplayRequiredError("transaction-account-audience-changed");
        }
    };
    await recheck();
    return recheck;
}

/**
 * Publish a credential-context transition for Sessions whose collective access
 * depends on one of the affected Teams.
 *
 * Authentication policy and provider/connection currentness do not change
 * structural membership, grants, or collaborator-owned personal state. They
 * only invalidate the ordinary Session projection and ask the existing
 * presence owner to re-evaluate each exact socket credential after commit.
 */
async function readTeamAuthenticationContextSessionIdsInTx(tx: Tx, teamIds: readonly string[]): Promise<readonly string[]> {
    return readSessionAccessMembershipChangeSessionIdsInTx(tx,
        teamIds.map(teamId => ({ kind: "teamMembership", teamId })));
}

/** Pure recipient census for provider/policy changes before their first admission lock. */
export async function readTeamSessionAuthenticationContextChangeAudienceInTx(
    tx: Tx, input: Readonly<{ teamIds: readonly string[] }>,
): Promise<readonly string[]> {
    const sessionIds = await readTeamAuthenticationContextSessionIdsInTx(tx, [...new Set(input.teamIds.filter(Boolean))]);
    return (await readSessionAccountCursorAudienceInTx(tx, sessionIds, [])).accountIds;
}

export async function applyTeamSessionAuthenticationContextEffectsInTx(
    tx: Tx,
    input: Readonly<{ teamIds: readonly string[] }>,
): Promise<void> {
    const sessionIds = await readTeamAuthenticationContextSessionIdsInTx(tx, [...new Set(input.teamIds.filter(Boolean))]);
    for (const sessionId of sessionIds) {
        await markCurrentSessionReadersChanged({ tx, sessionId });
        afterTx(tx, () => notifySessionHumanPresenceAccessChanged({ sessionId }));
    }
}

/**
 * Compose native facts with the Session and Machine owners' before/after effects. Bulk
 * directory changes capture their complete Account set first and pass it to
 * nested mutations, so an intermediate access loss cannot clear personal state.
 * This helper neither evaluates access nor writes personal Session state.
 */
export async function withTeamSessionAccessEffectsInTx<T>(
    tx: Tx,
    input: Readonly<{
        teamId: string;
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
    const recheckAdmission = await acquireTeamMutationAccountAdmissionInTx(tx, {
        teamId: input.teamId,
        accountIds: uniqueAccountIds,
        membershipChange: change,
        affectedAccountIds: uniqueAccountIds,
    });
    await recheckAdmission();
    const captured = await captureSessionAccessMembershipImpactsInTx(tx, {
        accountIds: ownedAccountIds,
        changes: [change],
    });
    const machines = await readTeamMembershipEffectMachinesInTx(tx, change, ownedAccountIds);
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
    const result = await mutate(impacts);
    await applySessionAccessMembershipImpactsInTx(tx, { impacts: owned });
    await applyMachineAccessImpactsInTx(tx, { impacts: machineImpacts.values() });
    return result;
}
