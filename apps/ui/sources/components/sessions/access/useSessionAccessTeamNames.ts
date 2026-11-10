import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeTeam } from '@/sync/engine/teams/teamsDirectoryEngine';
import { getTeamSnapshot, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';

/** Labels for authored Team grants, without mounting the access directory. */
export function useSessionAccessTeamNames(scope: ServerAccountScope, subjects: readonly PrincipalRefV1[]): ReadonlyMap<string, string | null> {
    const teamIdsKey = JSON.stringify([...new Set(subjects.flatMap(subject => subject.kind === 'team' ? [subject.teamId] : []))]);
    const teamIds = React.useMemo(() => JSON.parse(teamIdsKey) as string[], [teamIdsKey]);
    React.useEffect(() => {
        const releases = teamIds.map(teamId => observeTeam(scope, { serverId: scope.serverId, teamId }));
        return () => { for (const release of releases) release(); };
    }, [scope.serverId, scope.accountId, teamIds]);
    const read = React.useCallback(() => JSON.stringify(teamIds.map(teamId => [
        teamId, getTeamSnapshot(scope, { serverId: scope.serverId, teamId })?.data?.name ?? null,
    ])), [scope.serverId, scope.accountId, teamIds]);
    const namesKey = React.useSyncExternalStore(subscribeTeamsSnapshots, read, read);
    return React.useMemo(() => new Map<string, string | null>(JSON.parse(namesKey)), [namesKey]);
}
