import type { TeamResourceCreationPolicyV1 } from '@happier-dev/protocol/teams';

/** The resource's own Team preference decides its default and required audience once at creation. */
export function projectTeamCreationPolicy(policy: TeamResourceCreationPolicyV1): Readonly<{
    requiredByPolicy: boolean;
    defaultGrant: Readonly<{ accessLevel: 'edit'; canApprovePermissions: false }> | null;
}> {
    return {
        requiredByPolicy: policy === 'team_required',
        defaultGrant: policy === 'private_default' ? null : {
            accessLevel: 'edit',
            canApprovePermissions: false,
        },
    };
}
