import type { Tx } from "@/storage/inTx";
import type { Prisma } from "@prisma/client";
import {
    AccountStatus,
    TeamMembershipStatus,
    type SessionHistoryAccess,
    type TeamRole,
} from "@/storage/enums.generated";
import { sessionHistoryAccessOf } from "./sessionHistory";

/**
 * One resolved Team-membership lifetime, as seen inside the deciding transaction.
 *
 * `effective` is Lane 01's single structural membership predicate. It is a
 * structural fact only: it does not claim the request satisfies a configured Team
 * authentication requirement, and it never decides Session access. Consumers read
 * this projection instead of rebuilding it from role strings, external source
 * state, or client data.
 */
export type TeamMembershipLifetimeContext = Readonly<{
    teamMembershipId: string;
    teamId: string;
    accountId: string;
    role: TeamRole;
    status: TeamMembershipStatus;
    /**
     * The server-owned access input. Lane 04 alone compares it with a grant's
     * immutable `effectiveAt`; nothing here interprets it.
     */
    sessionAccessStartsAt: Date | null;
    historyAccess: SessionHistoryAccess;
    effective: boolean;
}>;

export type TeamMembershipContextError =
    | "team_membership_not_found"
    | "team_membership_account_changed";

export type TeamMembershipContextResolution =
    | Readonly<{ ok: true; membership: TeamMembershipLifetimeContext }>
    | Readonly<{ ok: false; error: TeamMembershipContextError }>;

/**
 * Current effective Team membership: an active Account, an active membership, and
 * a Team that is not archived. Archival makes Team-derived access ineffective while
 * every row is retained for restoration.
 */
export const EFFECTIVE_TEAM_MEMBERSHIP_WHERE = {
    status: TeamMembershipStatus.active,
    account: { status: AccountStatus.active },
    team: { archivedAt: null },
} as const;

export function isEffectiveTeamMembership(
    input: Readonly<{
        accountStatus: AccountStatus;
        membershipStatus: TeamMembershipStatus;
        teamArchivedAt: Date | null;
    }>,
): boolean {
    return input.accountStatus === AccountStatus.active
        && input.membershipStatus === TeamMembershipStatus.active
        && input.teamArchivedAt === null;
}

/**
 * Load current membership lifetimes and their effectiveness facts as one set.
 * Callers scope the acquisition by Account, Team, or retained lifetime ids;
 * inactive rows remain represented so restoration and history retain their facts.
 * No context is retained beyond the caller's deciding transaction.
 */
export async function resolveTeamMembershipContextsInTx(
    tx: Tx,
    params: Readonly<{ where: Prisma.TeamMembershipWhereInput }>,
): Promise<readonly TeamMembershipLifetimeContext[]> {
    const memberships = await tx.teamMembership.findMany({
        where: params.where,
        select: {
            id: true,
            teamId: true,
            accountId: true,
            role: true,
            status: true,
            sessionAccessStartsAt: true,
            account: { select: { status: true } },
            team: { select: { archivedAt: true } },
        },
    });

    return memberships.map(membership => ({
        teamMembershipId: membership.id,
        teamId: membership.teamId,
        accountId: membership.accountId,
        role: membership.role,
        status: membership.status,
        sessionAccessStartsAt: membership.sessionAccessStartsAt,
        historyAccess: sessionHistoryAccessOf(membership.sessionAccessStartsAt),
        effective: isEffectiveTeamMembership({
            accountStatus: membership.account.status,
            membershipStatus: membership.status,
            teamArchivedAt: membership.team.archivedAt,
        }),
    }));
}

/**
 * Resolve one immutable lifetime through the same context acquisition owner.
 * Provider Account replacement preserves the lifetime id but moves `accountId`;
 * reject that retargeting, and conceal ids belonging to another Team.
 */
export async function resolveTeamMembershipContextInTx(
    tx: Tx,
    params: Readonly<{
        teamId: string;
        teamMembershipId: string;
        expectedAccountId: string;
    }>,
): Promise<TeamMembershipContextResolution> {
    const [membership] = await resolveTeamMembershipContextsInTx(tx, { where: { id: params.teamMembershipId } });
    if (!membership || membership.teamId !== params.teamId) {
        return { ok: false, error: "team_membership_not_found" };
    }
    if (membership.accountId !== params.expectedAccountId) {
        return { ok: false, error: "team_membership_account_changed" };
    }
    return { ok: true, membership };
}
