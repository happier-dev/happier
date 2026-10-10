import * as React from 'react';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { resolveWorkflowRunVisibleTeamV1 } from '@happier-dev/protocol/workflows';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { observeTeam, refreshTeam } from '@/sync/engine/teams/teamsDirectoryEngine';
import { getTeamSnapshot, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

type GrantedTeam = Readonly<{ id: string; name: string | null; sessionCreationPolicy: TeamSummaryV1['policy']['sessionCreationPolicy'] }>;
const EMPTY_TEAMS: readonly GrantedTeam[] = Object.freeze([]);

/** Artifact grants nominate Teams; the existing Team reader decides which are viewable. */
export function useWorkflowRunVisibility(sourceArtifactId: string | null | undefined) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = lifetime?.scope ?? null;
    const identity = JSON.stringify([scope?.serverId, scope?.accountId, sourceArtifactId]);
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const [state, setState] = React.useState<Readonly<{
        identity: string; status: 'ready' | 'loading' | 'failed'; teams: readonly GrantedTeam[]; shared?: boolean; selectedTeamId?: string;
        lifetime: ActiveServerAccountScopeLifetime | null;
    }>>({ identity, lifetime, status: sourceArtifactId ? 'loading' : 'ready', teams: EMPTY_TEAMS });
    React.useEffect(() => {
        if (!sourceArtifactId) {
            setState({ identity, lifetime, status: 'ready', teams: EMPTY_TEAMS });
            return;
        }
        if (!lifetime) {
            setState({ identity, lifetime, status: 'failed', teams: EMPTY_TEAMS });
            return;
        }
        const abort = new AbortController();
        const retirement = lifetime.onRetire(() => abort.abort());
        const releases: Array<() => void> = [];
        setState({ identity, lifetime, status: 'loading', teams: EMPTY_TEAMS });
        void callWorkflowAction({ actionId: 'artifact.access.grants.list', input: { artifactId: sourceArtifactId },
            parseResult: (value) => {
                const grants = ArtifactAccessGrantsListResponseV1Schema.parse(value);
                if (grants.artifactId !== sourceArtifactId) throw new Error('artifact_access_source_mismatch');
                const teamIds = grants.grants.flatMap((grant) => grant.principal.kind === 'team' ? [grant.principal.teamId] : []);
                return { teamIds, shared: grants.access !== 'owner' || teamIds.length > 0 };
            }, signal: abort.signal,
        }).then((grants) => {
            if (abort.signal.aborted || !lifetime.isCurrent()) return;
            const addresses = grants.teamIds.map((teamId) => createTeamAddress(lifetime.scope.serverId, teamId)!);
            const project = () => {
                if (abort.signal.aborted || !lifetime.isCurrent()) return;
                const teams: GrantedTeam[] = [];
                let status: 'ready' | 'loading' | 'failed' = 'ready';
                for (const address of addresses) {
                    const snapshot = getTeamSnapshot(lifetime.scope, address);
                    // An authoritative non-viewable answer excludes this Team, not the whole review.
                    if (snapshot?.status === 'error' && snapshot.error?.code === 'team_not_found') continue;
                    if (snapshot?.status === 'error') { status = 'failed'; break; }
                    if (snapshot?.status !== 'ready' || snapshot.stale || !snapshot.data) { status = 'loading'; continue; }
                    teams.push({ id: address.teamId, name: snapshot.data.name, sessionCreationPolicy: snapshot.data.policy.sessionCreationPolicy });
                }
                const readyTeams = status === 'ready' ? teams : EMPTY_TEAMS;
                setState((current) => {
                    if (current.identity === identity && current.status === status && current.shared === grants.shared
                        && current.teams.length === readyTeams.length && current.teams.every((team, index) => {
                            const next = readyTeams[index];
                            return team.id === next.id && team.name === next.name && team.sessionCreationPolicy === next.sessionCreationPolicy;
                        })) return current;
                    return { identity, lifetime, status, teams: readyTeams, shared: grants.shared,
                        ...(current.identity === identity ? { selectedTeamId: current.selectedTeamId } : {}) };
                });
            };
            releases.push(subscribeTeamsSnapshots(project));
            for (const address of addresses) releases.push(observeTeam(lifetime.scope, address));
            if (attempt > 0) for (const address of addresses) void refreshTeam(lifetime.scope, address);
            project();
        }, () => {
            if (!abort.signal.aborted && lifetime.isCurrent()) setState({ identity, lifetime, status: 'failed', teams: EMPTY_TEAMS });
        });
        return () => { abort.abort(); releases.forEach((release) => release()); retirement.dispose(); };
    }, [attempt, identity, lifetime, sourceArtifactId]);
    const onChange = React.useCallback((selectedTeamId: string) => {
        if (!lifetime?.isCurrent()) return;
        setState((current) => current.identity === identity && current.lifetime === lifetime && current.status === 'ready'
            && current.teams.some((team) => team.id === selectedTeamId) ? { ...current, selectedTeamId } : current);
    }, [identity, lifetime]);
    const current = state.identity === identity && state.lifetime === lifetime ? state : {
        status: sourceArtifactId ? 'loading' as const : 'ready' as const, teams: EMPTY_TEAMS, shared: false, selectedTeamId: undefined,
    };
    const resolution = resolveWorkflowRunVisibleTeamV1(current.teams.map((team) => team.id), current.selectedTeamId);
    return { status: current.status, teams: current.teams, shared: current.shared === true, resolution, onChange, retry };
}
