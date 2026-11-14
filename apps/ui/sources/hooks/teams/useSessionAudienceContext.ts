import { compareCodeUnits } from '@/utils/strings/compareCodeUnits';
import * as React from 'react';
import type { SessionEffectiveAccessV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { TeamGroupNameProjectionV1 } from '@happier-dev/protocol/teams';

import { storage } from '@/sync/domains/state/storageStore';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildSessionContextFacts, type SessionAudiencePresentation } from '@/sync/domains/session/presentation/sessionContextPresentation';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureServerProfileScopeResolver, getServerProfilesGeneration } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { observeTeam, observeTeamGroup } from '@/sync/engine/teams/teamsDirectoryEngine';
import { readTeamGroup, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import { teamGroupDisplayNameKey, useScopedTeamGroupNameProjectionDisplayNames } from './useTeamGroupDisplayNames';

type AudienceTarget = Readonly<{
    address: SessionAddress;
    audience: NonNullable<SessionEffectiveAccessV1['audienceContext']>;
}>;

/** One surface binding to existing exact-Home credentials and Team projections, never per card. */
export function useSessionAudienceContext(addresses: readonly SessionAddress[]) {
    const addressesKey = React.useMemo(() => JSON.stringify(
        [...new Map(addresses.map((address) => [sessionAddressKey(address), address])).entries()]
            .sort(([leftKey], [rightKey]) => compareCodeUnits(leftKey, rightKey))
            .map(([, address]) => address),
    ), [addresses]);
    // These are our own serialized address tuples. Keeping this primitive as the selector result
    // makes streaming and unrelated row mutations invisible to audience observation.
    const stableAddresses = React.useMemo(() => JSON.parse(addressesKey) as SessionAddress[], [addressesKey]);
    const selectTargetsKey = React.useMemo(() => {
        let previousInputs: Pick<ReturnType<typeof storage.getState>, 'sessions' | 'sessionListRowsByServerId'> | null = null;
        let previousProfilesGeneration = -1;
        let key = '[]';
        return (state: ReturnType<typeof storage.getState>) => {
            const profilesGeneration = getServerProfilesGeneration();
            if (previousInputs?.sessions === state.sessions
                && previousInputs.sessionListRowsByServerId === state.sessionListRowsByServerId
                && previousProfilesGeneration === profilesGeneration) return key;
            previousInputs = { sessions: state.sessions, sessionListRowsByServerId: state.sessionListRowsByServerId };
            previousProfilesGeneration = profilesGeneration;
            const resolveScopeId = captureServerProfileScopeResolver();
            key = JSON.stringify(stableAddresses.flatMap((address) => {
                // Audience belongs to the row; the list's Home-name/index join is unused here.
                const row = readSessionListRowForServerId(state.sessionListRowsByServerId, address.serverId, address.sessionId, resolveScopeId);
                const hydrated = state.sessions[address.sessionId];
                const session = row ?? (hydrated?.serverId === address.serverId ? hydrated : null);
                const audience = session?.access?.audienceContext;
                return audience ? [{ address, audience }] : [];
            }));
            return key;
        };
    }, [stableAddresses]);
    const targetsKey = storage(selectTargetsKey);
    const targets = React.useMemo(() => JSON.parse(targetsKey) as AudienceTarget[], [targetsKey]);
    const credentialBindingsByServerId = useServerCredentialAccountScopeBindings(
        stableAddresses.map((address) => address.serverId),
    );
    const scopes = React.useMemo(() => {
        const result = new Map<string, ServerAccountScope>();
        for (const [serverId, binding] of credentialBindingsByServerId) {
            result.set(serverId, binding.scope);
        }
        return result;
    }, [credentialBindingsByServerId]);
    const observedKey = JSON.stringify(targets.flatMap(({ address, audience }) => {
        const scope = scopes.get(address.serverId);
        return scope ? [{ scope, audience }] : [];
    }));
    React.useEffect(() => {
        const releases: (() => void)[] = [];
        const teams = new Set<string>();
        const groups = new Set<string>();
        for (const { address, audience } of targets) {
            const scope = scopes.get(address.serverId);
            if (!scope) continue;
            const teamAddress = { serverId: address.serverId, teamId: audience.teamId };
            const teamKey = JSON.stringify([scope.serverId, scope.accountId, audience.teamId]);
            if (!teams.has(teamKey)) {
                teams.add(teamKey);
                releases.push(observeTeam(scope, teamAddress));
            }
            if (audience.kind === 'group') {
                const groupKey = JSON.stringify([teamKey, audience.groupId]);
                if (!groups.has(groupKey)) {
                    groups.add(groupKey);
                    releases.push(observeTeamGroup(scope, teamAddress, audience.groupId));
                }
            }
        }
        return () => { for (const release of releases) release(); };
        // Exact observer identity; a row streaming without changing audience keeps its observers.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [observedKey]);
    const readAudienceSnapshots = React.useMemo(() => {
        let previous: readonly (AudienceTarget & Readonly<{
            scope: ServerAccountScope | undefined;
            groupName: TeamGroupNameProjectionV1 | null;
            label: string | null;
        }>)[] = [];
        return () => {
            const next = targets.map(({ address, audience }) => {
                const scope = scopes.get(address.serverId);
                const groupName = scope && audience.kind === 'group'
                    ? readTeamGroup(scope, { serverId: address.serverId, teamId: audience.teamId }, audience.groupId)?.name ?? null
                    : null;
                return { address, audience, scope, groupName,
                    label: buildSessionContextFacts({ address, audienceContext: audience, audienceScope: scope }).audience?.label ?? null };
            });
            if (next.length === previous.length && next.every((row, index) =>
                row.groupName === previous[index]!.groupName && row.label === previous[index]!.label)) return previous;
            previous = next;
            return next;
        };
    }, [scopes, targets]);
    const snapshots = React.useSyncExternalStore(subscribeTeamsSnapshots, readAudienceSnapshots, readAudienceSnapshots);
    const groups = React.useMemo(() => [...new Map(snapshots.flatMap(({ audience, scope, groupName }) =>
        scope && audience.kind === 'group' && groupName
            ? [[teamGroupDisplayNameKey(scope, audience.groupId), { scope, id: audience.groupId, name: groupName }] as const]
            : [])).values()], [snapshots]);
    const groupDisplayNames = useScopedTeamGroupNameProjectionDisplayNames(groups);
    const presentationsRef = React.useRef<ReadonlyMap<string, SessionAudiencePresentation | null>>(new Map());
    const presentationsBySessionKey = React.useMemo(() => {
        const previous = presentationsRef.current;
        const next = new Map<string, SessionAudiencePresentation | null>();
        for (const { address, audience, scope } of snapshots) {
            const key = sessionAddressKey(address);
            const value = buildSessionContextFacts({ address, audienceContext: audience, audienceScope: scope,
                audienceLabel: scope && audience.kind === 'group'
                    ? groupDisplayNames.get(teamGroupDisplayNameKey(scope, audience.groupId))
                    : null,
            }).audience;
            next.set(key, retainIfEqual(previous.get(key), value));
        }
        const result = next.size === previous.size && [...next].every(([key, value]) => previous.get(key) === value)
            ? previous : next;
        presentationsRef.current = result;
        return result;
    }, [groupDisplayNames, snapshots]);
    const labelsVersion = React.useMemo(() => JSON.stringify([...presentationsBySessionKey]
        .map(([key, audience]) => [key, audience?.label ?? null])), [presentationsBySessionKey]);
    const labelsBySessionKey = React.useMemo(() => new Map<string, string | null>(JSON.parse(labelsVersion)), [labelsVersion]);
    return React.useMemo(() => ({
        credentialBindingsByServerId,
        scopes,
        labelsVersion,
        labelsBySessionKey,
        presentationsBySessionKey,
    }), [credentialBindingsByServerId, scopes, labelsVersion, labelsBySessionKey, presentationsBySessionKey]);
}
