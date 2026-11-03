import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import {
    AccountStatus,
    TeamMembershipStatus,
    type SessionHistoryAccess,
} from "@/storage/enums.generated";
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE, isEffectiveTeamMembership } from "../memberships/effectiveMembership";
import { sessionHistoryAccessOf } from "../memberships/sessionHistory";

/**
 * One resolved Group membership, keyed by the Team-membership lifetime it hangs on.
 *
 * Group access is ineffective whenever the parent Team membership is ineffective;
 * that is derived here from the same structural predicate rather than copied into a
 * Boolean on the Group row that a cleanup race could leave stale.
 */
export type TeamGroupMembershipLifetimeContext = Readonly<{
    teamId: string;
    teamGroupId: string;
    teamMembershipId: string;
    accountId: string;
    nativeContribution: boolean;
    /** The Group's own horizon. Team and Group horizons are independent facts. */
    sessionAccessStartsAt: Date | null;
    historyAccess: SessionHistoryAccess;
    effective: boolean;
}>;

export type TeamGroupMembershipContextError =
    | "team_group_not_found"
    | "team_membership_not_found"
    | "team_group_membership_not_found";

export type TeamGroupMembershipContextResolution =
    | Readonly<{ ok: true; groupMembership: TeamGroupMembershipLifetimeContext }>
    | Readonly<{ ok: false; error: TeamGroupMembershipContextError }>;

/**
 * The storage predicate for the same effective Group-membership contract as
 * `isEffectiveTeamGroupMembership`. Retained rows remain queryable for restore
 * and history, but list/count projections must exclude them while any parent
 * lifecycle input is inactive.
 */
export const EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE = {
    teamMembership: EFFECTIVE_TEAM_MEMBERSHIP_WHERE,
    group: { archivedAt: null },
} as const;

/**
 * Lane 01's complete structural Group-membership predicate. Retained roster
 * rows are not effective while any Account, Team-membership, Team, or Group
 * lifecycle input is inactive.
 */
export function isEffectiveTeamGroupMembership(
    input: Readonly<{
        accountStatus: AccountStatus;
        membershipStatus: TeamMembershipStatus;
        teamArchivedAt: Date | null;
        groupArchivedAt: Date | null;
    }>,
): boolean {
    return isEffectiveTeamMembership(input) && input.groupArchivedAt === null;
}

/** Resolve all currently effective Group identities for one Account in a Team. */
export async function resolveEffectiveTeamGroupIdsForAccountInTx(
    tx: Tx,
    params: Readonly<{ teamId: string; accountId: string }>,
): Promise<readonly string[]> {
    return (await resolveTeamGroupMembershipsForAccountInTx(tx, params))
        .filter(membership => membership.effective).map(membership => membership.teamGroupId).sort();
}

/** Read only this Account's current lifetime memberships, optionally for one credential audience. */
export async function resolveTeamGroupMembershipsForAccountInTx(
    tx: Tx,
    params: Readonly<{ teamId: string; accountId: string; credentialResourceId?: string }>,
): Promise<readonly TeamGroupMembershipLifetimeContext[]> {
    return resolveTeamGroupMembershipsForAccountsInTx(tx, { ...params, accountIds: [params.accountId] });
}

/** Resolve one recipient set through the same Group lifetime projection owner. */
export async function resolveTeamGroupMembershipsForAccountsInTx(
    tx: Tx,
    params: Readonly<{ teamId: string; accountIds: readonly string[]; credentialResourceId?: string }>,
): Promise<readonly TeamGroupMembershipLifetimeContext[]> {
    const contexts: TeamGroupMembershipLifetimeContext[] = [];
    for (const accountIds of portableQueryChunks({
        values: [...new Set(params.accountIds)], bindingsPerValue: 1,
        // Two Team predicates, optional resource equality, and Prisma's OFFSET bind.
        fixedBindings: params.credentialResourceId ? 4 : 3,
    })) {
        const memberships = await tx.teamGroupMembership.findMany({
            where: {
                teamMembership: { teamId: params.teamId, accountId: { in: [...accountIds] } },
                group: {
                    teamId: params.teamId,
                    ...(params.credentialResourceId ? { credentialGrants: { some: { resourceId: params.credentialResourceId } } } : {}),
                },
            },
            select: {
                nativeContribution: true, sessionAccessStartsAt: true,
                group: { select: { id: true, teamId: true, archivedAt: true } },
                teamMembership: {
                    select: { id: true, accountId: true, status: true, account: { select: { status: true } }, team: { select: { archivedAt: true } } },
                },
            },
        });
        for (const row of memberships) {
            contexts.push(projectTeamGroupMembershipLifetime({
                ...row, membership: row.teamMembership, accountId: row.teamMembership.accountId,
            }));
        }
    }
    return contexts;
}

function projectTeamGroupMembershipLifetime(input: Readonly<{
    accountId: string;
    group: Readonly<{ id: string; teamId: string; archivedAt: Date | null }>;
    membership: Readonly<{ id: string; status: TeamMembershipStatus;
        account: Readonly<{ status: AccountStatus }>; team: Readonly<{ archivedAt: Date | null }> }>;
    nativeContribution: boolean;
    sessionAccessStartsAt: Date | null;
}>): TeamGroupMembershipLifetimeContext {
    return {
        teamId: input.group.teamId,
        teamGroupId: input.group.id,
        teamMembershipId: input.membership.id,
        accountId: input.accountId,
        nativeContribution: input.nativeContribution,
        sessionAccessStartsAt: input.sessionAccessStartsAt,
        historyAccess: sessionHistoryAccessOf(input.sessionAccessStartsAt),
        effective: isEffectiveTeamGroupMembership({
            accountStatus: input.membership.account.status,
            membershipStatus: input.membership.status,
            teamArchivedAt: input.membership.team.archivedAt,
            groupArchivedAt: input.group.archivedAt,
        }),
    };
}

/**
 * Resolve a Group membership from its public `{ teamId, groupId, accountId }`
 * address inside the caller's transaction.
 *
 * The public address is by Account, but the stored row is keyed by the current
 * Team-membership lifetime. Resolving that lifetime here — once, transactionally —
 * is what lets removal and rejoin produce a genuinely new Group membership and
 * horizon instead of resurrecting the previous one, and it is why no surrogate
 * Group-membership id is minted anywhere.
 *
 * The Group row is the authority for its own parent Team; the caller's `teamId` is a
 * claim that is verified rather than trusted, so a Group cannot be reached through a
 * Team that does not own it.
 */
export async function resolveTeamGroupMembershipContextInTx(
    tx: Tx,
    params: Readonly<{
        teamId: string;
        groupId: string;
        accountId: string;
    }>,
): Promise<TeamGroupMembershipContextResolution> {
    const group = await tx.teamGroup.findUnique({
        where: { id: params.groupId },
        select: {
            id: true,
            teamId: true,
            archivedAt: true,
            team: { select: { archivedAt: true } },
        },
    });
    if (!group || group.teamId !== params.teamId) return { ok: false, error: "team_group_not_found" };

    const membership = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: params.teamId, accountId: params.accountId } },
        select: {
            id: true,
            status: true,
            account: { select: { status: true } },
        },
    });
    if (!membership) {
        return { ok: false, error: "team_membership_not_found" };
    }

    const groupMembership = await tx.teamGroupMembership.findUnique({
        where: { teamGroupId_teamMembershipId: { teamGroupId: group.id, teamMembershipId: membership.id } },
        select: { nativeContribution: true, sessionAccessStartsAt: true },
    });
    if (!groupMembership) return { ok: false, error: "team_group_membership_not_found" };
    return { ok: true, groupMembership: projectTeamGroupMembershipLifetime({
        group, membership: { ...membership, team: group.team }, accountId: params.accountId, ...groupMembership,
    }) };
}
