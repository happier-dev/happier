import type { Tx } from "@/storage/inTx";
import { acquireTeamMembershipAccountAdmissionInTx } from "../memberships/membershipService";
import {
    withTeamSessionAccessEffectsInTx,
    type TeamSessionAccessImpacts,
} from "../memberships/sessionAccessEffects";
import type { SessionHistoryAccess } from "@/storage/enums.generated";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { mintSessionAccessStartsAt } from "../memberships/sessionHistory";
import { advanceBrokerJobRevisionsForGroupInTx } from '../credentials/brokerJobWithdrawal';

/**
 * The one owner of effective Group membership.
 *
 * A Group roster is a plain set union: one optional native contribution plus any
 * number of exact directory contributions. Because it is a union there is no
 * source precedence, no deny rule, and no overwrite — which is precisely why
 * every writer, native or external, must come through this function. Two writers
 * with their own idea of "is this person still in the Group" is the split-brain
 * the contribution rows exist to prevent.
 *
 * The horizon is minted by the *first* contribution and then retained: a second
 * source arriving later, or a native contribution added on top of a directory
 * one, must never widen or reset history that has already been granted. Only the
 * disappearance of the last contribution ends the membership, and a later rejoin
 * mints a genuinely new horizon.
 */
export type TeamGroupContribution =
    | Readonly<{ kind: "native" }>
    | Readonly<{ kind: "external"; externalGroupBindingId: string }>;

/**
 * The truthful outcome of one contribution change.
 *
 * `contribution_removed` is deliberately not `removed`: when another source
 * still contributes, the person keeps Group access, and reporting a removal that
 * did not happen is exactly what the roster must never do.
 */
export type TeamGroupContributionOutcome =
    | "added"
    | "contribution_added"
    | "unchanged"
    | "contribution_removed"
    | "removed";

export type TeamGroupContributionResult = Readonly<{
    outcome: TeamGroupContributionOutcome;
    /** True while an effective membership row survives this change. */
    membershipRetained: boolean;
}>;

type ContributionState = Readonly<{
    nativeContribution: boolean;
    externalBindingIds: readonly string[];
}> | null;

async function readContributionStateInTx(
    tx: Tx,
    key: Readonly<{ teamGroupId: string; teamMembershipId: string }>,
): Promise<ContributionState> {
    const row = await tx.teamGroupMembership.findUnique({
        where: { teamGroupId_teamMembershipId: key },
        select: {
            nativeContribution: true,
            externalContributions: { select: { externalGroupBindingId: true } },
        },
    });
    if (!row) return null;
    return {
        nativeContribution: row.nativeContribution,
        externalBindingIds: row.externalContributions.map((c) => c.externalGroupBindingId),
    };
}


export async function applyTeamGroupContributionInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        teamGroupId: string;
        teamMembershipId: string;
        contribution: TeamGroupContribution;
        desired: "present" | "absent";
        /** Consumed only when the first contribution mints the horizon. */
        historyAccess: SessionHistoryAccess;
        sessionAccessImpacts?: TeamSessionAccessImpacts;
    }>,
): Promise<TeamGroupContributionResult> {
    await acquireTeamMembershipAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [], membershipIds: [input.teamMembershipId],
        membershipChange: { kind: "teamGroupMembership", teamId: input.teamId, teamGroupIds: [input.teamGroupId] } });
    const key = { teamGroupId: input.teamGroupId, teamMembershipId: input.teamMembershipId };
    const existing = await readContributionStateInTx(tx, key);
    const member = await tx.teamMembership.findUnique({ where: { id: input.teamMembershipId }, select: { accountId: true } });
    return withTeamSessionAccessEffectsInTx(tx, {
        teamId: input.teamId,
        teamGroupId: input.teamGroupId,
        accountIds: member ? [member.accountId] : [], sessionAccessImpacts: input.sessionAccessImpacts,
    }, async () => {
        if (input.desired === "present") {
            if (!existing) {
                // The horizon comes from this transaction attempt's database clock,
                // read after the state above: a process clock on a skewed replica
                // would mint a cutoff that disagrees with the grant timestamps it is
                // later compared against.
                const activationNow = await readTransactionDatabaseTime(tx);
                await tx.teamGroupMembership.upsert({
                    where: { teamGroupId_teamMembershipId: key },
                    create: {
                        teamId: input.teamId,
                        teamGroupId: input.teamGroupId,
                        teamMembershipId: input.teamMembershipId,
                        nativeContribution: input.contribution.kind === "native",
                        sessionAccessStartsAt: mintSessionAccessStartsAt(input.historyAccess, activationNow),
                    },
                    update: input.contribution.kind === "native"
                        ? { nativeContribution: true }
                        : {},
                });
                if (input.contribution.kind === "external") {
                    await tx.teamGroupMembershipExternalContribution.upsert({
                        where: {
                            teamGroupId_teamMembershipId_externalGroupBindingId: {
                                teamGroupId: input.teamGroupId,
                                teamMembershipId: input.teamMembershipId,
                                externalGroupBindingId: input.contribution.externalGroupBindingId,
                            },
                        },
                        create: {
                            teamGroupId: input.teamGroupId,
                            teamMembershipId: input.teamMembershipId,
                            externalGroupBindingId: input.contribution.externalGroupBindingId,
                        },
                        update: {},
                    });
                }
                return { outcome: "added", membershipRetained: true };
            }

            if (input.contribution.kind === "native") {
                const current = existing ?? await readContributionStateInTx(tx, key);
                if (current?.nativeContribution) return { outcome: "unchanged", membershipRetained: true };
                await tx.teamGroupMembership.update({
                    where: { teamGroupId_teamMembershipId: key },
                    data: { nativeContribution: true },
                });
                return { outcome: "contribution_added", membershipRetained: true };
            }

            const bindingId = input.contribution.externalGroupBindingId;
            const current = existing ?? await readContributionStateInTx(tx, key);
            if (current?.externalBindingIds.includes(bindingId)) {
                return { outcome: "unchanged", membershipRetained: true };
            }
            await tx.teamGroupMembershipExternalContribution.upsert({
                where: {
                    teamGroupId_teamMembershipId_externalGroupBindingId: {
                        teamGroupId: input.teamGroupId,
                        teamMembershipId: input.teamMembershipId,
                        externalGroupBindingId: bindingId,
                    },
                },
                create: {
                    teamGroupId: input.teamGroupId,
                    teamMembershipId: input.teamMembershipId,
                    externalGroupBindingId: bindingId,
                },
                update: {},
            });
            return { outcome: "contribution_added", membershipRetained: true };
        }

        if (!existing) return { outcome: "unchanged", membershipRetained: false };

        let nativeRemains = existing.nativeContribution;
        let externalRemains = [...existing.externalBindingIds];
        let changed = false;

        if (input.contribution.kind === "native") {
            if (nativeRemains) {
                await tx.teamGroupMembership.update({
                    where: { teamGroupId_teamMembershipId: key },
                    data: { nativeContribution: false },
                });
                nativeRemains = false;
                changed = true;
            }
        } else {
            const bindingId = input.contribution.externalGroupBindingId;
            if (externalRemains.includes(bindingId)) {
                await tx.teamGroupMembershipExternalContribution.delete({
                    where: {
                        teamGroupId_teamMembershipId_externalGroupBindingId: {
                            teamGroupId: input.teamGroupId,
                            teamMembershipId: input.teamMembershipId,
                            externalGroupBindingId: bindingId,
                        },
                    },
                });
                externalRemains = externalRemains.filter((id) => id !== bindingId);
                changed = true;
            }
        }

        if (nativeRemains || externalRemains.length > 0) {
            return {
                outcome: changed ? "contribution_removed" : "unchanged",
                membershipRetained: true,
            };
        }

        // The last contribution disappeared, so the effective membership ends. An
        // empty row must never survive: a zero-contribution membership would still
        // grant Group access with nothing left justifying it.
        await tx.teamGroupMembership.delete({ where: { teamGroupId_teamMembershipId: key } });
        await advanceBrokerJobRevisionsForGroupInTx(tx, {
            teamId: input.teamId, teamGroupId: input.teamGroupId,
        });
        return { outcome: "removed", membershipRetained: false };
    });
}
