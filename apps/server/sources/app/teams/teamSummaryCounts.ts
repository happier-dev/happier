import type { Tx } from "@/storage/inTx";
import { TeamMembershipStatus } from "@/storage/enums.generated";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";

import { activeTeamInvitationWhere } from "./invitations/invitationLifecycle";
import type { TeamSummaryCountFacts } from "./projections";

/**
 * The Team Overview counts for a page of Teams, as three grouped queries
 * whatever the page size — never a count per row. Membership counts use the
 * roster's `all` set, Groups exclude archived ones, and waiting invitations use
 * the invitation owner's own active predicate at the transaction's database
 * time, so the Overview and the lists it leads to cannot disagree.
 */
export async function readTeamSummaryCountsInTx(
    tx: Tx,
    teamIds: readonly string[],
): Promise<ReadonlyMap<string, TeamSummaryCountFacts>> {
    const counts = new Map<string, TeamSummaryCountFacts>();
    if (teamIds.length === 0) return counts;
    const ids = [...new Set(teamIds)];
    const now = await readTransactionDatabaseTime(tx);
    const [memberships, groups, invitations] = await Promise.all([
        tx.teamMembership.groupBy({
            by: ["teamId", "status"],
            where: { teamId: { in: ids } },
            _count: { _all: true },
        }),
        tx.teamGroup.groupBy({
            by: ["teamId"],
            where: { teamId: { in: ids }, archivedAt: null },
            _count: { _all: true },
        }),
        tx.teamInvitation.groupBy({
            by: ["teamId"],
            where: { teamId: { in: ids }, ...activeTeamInvitationWhere(now) },
            _count: { _all: true },
        }),
    ]);
    const mutable = new Map(ids.map((id) => [id, { members: 0, suspendedMembers: 0, groups: 0, waitingInvitations: 0 }]));
    for (const row of memberships) {
        const entry = mutable.get(row.teamId);
        if (!entry) continue;
        entry.members += row._count._all;
        if (row.status === TeamMembershipStatus.suspended) entry.suspendedMembers += row._count._all;
    }
    for (const row of groups) {
        const entry = mutable.get(row.teamId);
        if (entry) entry.groups = row._count._all;
    }
    for (const row of invitations) {
        const entry = mutable.get(row.teamId);
        if (entry) entry.waitingInvitations = row._count._all;
    }
    for (const [id, entry] of mutable) counts.set(id, Object.freeze(entry));
    return counts;
}
