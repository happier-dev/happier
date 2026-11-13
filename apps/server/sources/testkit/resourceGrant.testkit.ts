import type { ResourceAccessLevelV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';

/** Persisted Team arm for resource fixtures; the real database enforces its selected principal. */
export function teamResourceGrantFixture(input: Readonly<{
    teamId: string; accessLevel: ResourceAccessLevelV1; createdByAccountId: string;
}>) {
    return { principalKind: 'team' as const, ...input };
}
