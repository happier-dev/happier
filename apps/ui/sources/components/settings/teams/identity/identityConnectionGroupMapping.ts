import type { TeamExternalGroupBindingSetInputV1 } from '@happier-dev/protocol/teams';

export function buildIdentityConnectionGroupMappingCommand(input: Readonly<{
    teamId: string;
    connectionId: string;
    externalGroupId: string;
    target: Extract<TeamExternalGroupBindingSetInputV1['target'], { kind: 'native_target' }>;
}>): TeamExternalGroupBindingSetInputV1 | null {
    const externalGroupId = input.externalGroupId.trim();
    if (!externalGroupId) return null;
    return {
        v: 1,
        teamId: input.teamId,
        owner: { kind: 'identity_connection', teamIdentityConnectionId: input.connectionId },
        externalGroupId,
        target: input.target,
    };
}
