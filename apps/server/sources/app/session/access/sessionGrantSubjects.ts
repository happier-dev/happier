import type { Tx } from "@/storage/inTx";
import { AccountStatus, TeamMembershipStatus } from "@/storage/prisma";
import { TEAM_PRINCIPAL_ROLES_V1 } from '@happier-dev/protocol/teams';

export type SessionCollectiveGrantSubject =
    | Readonly<{ kind: "team"; teamId: string }>
    | Readonly<{ kind: "group"; teamId: string; groupId: string }>;

/** Accounts reached by one subject, optionally including retained memberships for admission. */
export async function resolveSubjectMemberAccountIdsInTx(
    tx: Tx,
    subject: SessionCollectiveGrantSubject,
    options?: Readonly<{ includeInactiveAccounts?: boolean }>,
): Promise<string[]> {
    const currentMembership = {
        status: TeamMembershipStatus.active,
        ...(options?.includeInactiveAccounts ? {} : { account: { status: AccountStatus.active } }),
    };
    if (subject.kind === "team") {
        const memberships = await tx.teamMembership.findMany({
            where: {
                teamId: subject.teamId,
                ...currentMembership,
                role: { in: [...TEAM_PRINCIPAL_ROLES_V1] },
            },
            select: { accountId: true },
        });
        return [...new Set(memberships.map((membership) => membership.accountId))];
    }
    const groupMemberships = await tx.teamGroupMembership.findMany({
        where: {
            teamGroupId: subject.groupId,
            teamMembership: currentMembership,
        },
        select: { teamMembership: { select: { accountId: true } } },
    });
    return [...new Set(groupMemberships.map((membership) => membership.teamMembership.accountId))];
}
