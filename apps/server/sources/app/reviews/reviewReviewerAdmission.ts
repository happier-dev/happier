import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { Tx } from '@/storage/inTx';

export function reviewReviewerPrincipalKey(principal: PrincipalRefV1): string {
    return principal.kind === 'account' ? `account:${principal.accountId}`
        : principal.kind === 'team' ? `team:${principal.teamId}` : `group:${principal.teamId}:${principal.groupId}`;
}

/** A request's eligible people are resolved once, when its round is admitted. */
export async function admitReviewRequestedReviewersInTx(tx: Tx, input: Readonly<{
    reviewId: string;
    roundOrdinal: number;
    reviewers: readonly Readonly<{ principal: PrincipalRefV1; required: boolean }>[];
}>): Promise<void> {
    for (const reviewer of input.reviewers) {
        const eligibleAccounts = reviewer.principal.kind === 'account'
            ? [reviewer.principal.accountId]
            : reviewer.principal.kind === 'team'
                ? (await tx.teamMembership.findMany({ where: { teamId: reviewer.principal.teamId, status: 'active', account: { status: 'active' }, team: { archivedAt: null }, role: { in: ['owner', 'admin', 'member'] } }, select: { accountId: true } })).map(row => row.accountId)
                : (await tx.teamGroupMembership.findMany({ where: { teamGroupId: reviewer.principal.groupId, teamMembership: { status: 'active', account: { status: 'active' }, team: { archivedAt: null }, role: { in: ['owner', 'admin', 'member'] } } }, select: { teamMembership: { select: { accountId: true } } } })).map(row => row.teamMembership.accountId);
        await tx.reviewRequestedReviewer.create({ data: { reviewId: input.reviewId, roundOrdinal: input.roundOrdinal,
            principalKey: reviewReviewerPrincipalKey(reviewer.principal),
            principal: reviewer.principal, required: reviewer.required, eligibleAccounts: { create: eligibleAccounts.map(accountId => ({ accountId })) } } });
    }
}
