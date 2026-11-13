import type { SessionAccessProjectionRow } from './sessionAccess';
type Grant = SessionAccessProjectionRow['grants'][number];
/** A direct Account grant at the Prisma boundary, with every nullable unified arm represented. */
export function sessionDirectGrantProjectionFixture(input: Readonly<{ id: string; accountId: string;
    accessLevel?: Grant['accessLevel']; canApprovePermissions?: boolean; account?: Grant['account'] }>): Grant {
    return { id: input.id, principalKind: 'account', accountId: input.accountId,
        teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false,
        account: input.account ?? { status: 'active' }, team: null, teamGroup: null,
        accessLevel: input.accessLevel ?? 'view', canApprovePermissions: input.canApprovePermissions ?? false };
}
