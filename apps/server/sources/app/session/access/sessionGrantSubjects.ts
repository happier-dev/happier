import type { Tx } from "@/storage/inTx";
import { AccountStatus, TeamMembershipStatus } from "@/storage/prisma";
import { TEAM_PRINCIPAL_ROLES_V1 } from '@happier-dev/protocol/teams';

export type SessionCollectiveGrantSubject =
    | Readonly<{ kind: "team"; teamId: string }>
    | Readonly<{ kind: "group"; teamId: string; groupId: string }>;

/** Accounts currently reached by one subject, used to bound a mutation's delta. */
export async function resolveSubjectMemberAccountIdsInTx(
    tx: Tx,
    subject: SessionCollectiveGrantSubject,
): Promise<string[]> {
    if (subject.kind === "team") {
        const memberships = await tx.teamMembership.findMany({
            where: {
                teamId: subject.teamId,
                status: TeamMembershipStatus.active,
                role: { in: [...TEAM_PRINCIPAL_ROLES_V1] },
                account: { status: AccountStatus.active },
            },
            select: { accountId: true },
        });
        return [...new Set(memberships.map((membership) => membership.accountId))];
    }
    const groupMemberships = await tx.teamGroupMembership.findMany({
        where: {
            teamGroupId: subject.groupId,
            teamMembership: {
                status: TeamMembershipStatus.active,
                account: { status: AccountStatus.active },
            },
        },
        select: { teamMembership: { select: { accountId: true } } },
    });
    return [...new Set(groupMemberships.map((membership) => membership.teamMembership.accountId))];
}
