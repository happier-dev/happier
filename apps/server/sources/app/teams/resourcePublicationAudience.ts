import type { Tx } from '@/storage/inTx';
import { AccountStatus, TeamMembershipStatus } from '@/storage/enums.generated';

/** Payload-free resource invalidation reaches the Team's current active recipients. */
export async function readTeamResourcePublicationAudienceInTx(tx: Tx, teamId: string): Promise<string[]> {
    return (await tx.teamMembership.findMany({
        where: { teamId, status: TeamMembershipStatus.active, account: { status: AccountStatus.active } },
        select: { accountId: true },
    })).map(member => member.accountId);
}
