import * as React from 'react';

import {
    resolveTeamViewState,
    type TeamViewState,
} from '@/components/settings/teams/teamViewState';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { createTeamAddress, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { observeTeam, refreshTeam } from '@/sync/engine/teams/teamsDirectoryEngine';
import {
    getTeamSnapshot,
    subscribeTeamsSnapshots,
    type TeamSnapshot,
} from '@/sync/store/teams/teamsSnapshots';

/**
 * What this device can currently say about one explicitly addressed Team.
 *
 * `unknown_home`, `signed_out`, `credential_unreadable` and `invalid_address`
 * are facts about this device's saved Homes and the route it was given, never
 * answers from the Home, and are deliberately distinct from every state the
 * Home itself reports. `credential_unreadable` is settled: this device failed
 * to read its saved credential, and only a re-read helps.
 */
export type TeamBinding =
    | Readonly<{ kind: 'resolving' }>
    | Readonly<{ kind: 'invalid_address' }>
    | Readonly<{ kind: 'unknown_home' }>
    | Readonly<{ kind: 'signed_out'; homeName: string }>
    | Readonly<{ kind: 'credential_unreadable'; serverId: string }>
    | Readonly<{
        kind: 'bound';
        scope: ServerAccountScope;
        address: TeamAddress;
        homeName: string;
        state: TeamViewState;
        /**
         * The raw snapshot the state was derived from, for a surface that needs
         * a fact the view state deliberately does not project. Readiness and
         * continuity decisions still come from `state`, so a consumer cannot
         * become a second interpreter of staleness or reachability.
         */
        snapshot: TeamSnapshot | null;
        refresh: () => void;
    }>;

const RESOLVING: TeamBinding = Object.freeze({ kind: 'resolving' as const });
const INVALID_ADDRESS: TeamBinding = Object.freeze({ kind: 'invalid_address' as const });
const UNKNOWN_HOME: TeamBinding = Object.freeze({ kind: 'unknown_home' as const });

/**
 * Binds a Team screen to one exact Home and Team for its whole lifetime.
 *
 * The Home comes from the route's own `serverId`, never from whichever Home
 * happens to be focused, so switching Homes elsewhere in the app cannot
 * retarget an open Team screen or a mutation started from it. The Account comes
 * from that Home's own saved credential, because two Homes routinely hold
 * different Accounts with different Team roles and capabilities.
 */
export function useTeamBinding(serverIdRaw: string, teamIdRaw: string): TeamBinding {
    const address = React.useMemo(
        () => createTeamAddress(serverIdRaw, teamIdRaw),
        [serverIdRaw, teamIdRaw],
    );

    const profile = React.useMemo(
        () => (address ? getServerProfileById(address.serverId) : null),
        [address],
    );
    const homeName = useHomeDisplayLabel(profile);

    const resolution = useServerCredentialAccountScopeResolution(address?.serverId ?? null);
    const scope = resolution.kind === 'bound' ? resolution.scope : null;

    const scopeServerId = scope?.serverId ?? '';
    const scopeAccountId = scope?.accountId ?? '';
    const teamId = address?.teamId ?? '';

    // Observing is what declares this screen a live consumer of this Team. The
    // engine owns first load, Account-change wake and retry.
    React.useEffect(() => {
        const observedScope = createServerAccountScope(scopeServerId, scopeAccountId);
        const observedAddress = createTeamAddress(scopeServerId, teamId);
        if (!observedScope || !observedAddress) return;
        return observeTeam(observedScope, observedAddress);
    }, [scopeServerId, scopeAccountId, teamId]);

    const getSnapshot = React.useCallback(
        () => getTeamSnapshot(
            createServerAccountScope(scopeServerId, scopeAccountId),
            createTeamAddress(scopeServerId, teamId),
        ),
        [scopeServerId, scopeAccountId, teamId],
    );

    const snapshot = React.useSyncExternalStore(subscribeTeamsSnapshots, getSnapshot, getSnapshot);

    const refresh = React.useCallback(() => {
        const target = createServerAccountScope(scopeServerId, scopeAccountId);
        const targetAddress = createTeamAddress(scopeServerId, teamId);
        if (!target || !targetAddress) return;
        void refreshTeam(target, targetAddress);
    }, [scopeServerId, scopeAccountId, teamId]);

    return React.useMemo<TeamBinding>(() => {
        if (!address) return INVALID_ADDRESS;
        switch (resolution.kind) {
            case 'resolving':
                return RESOLVING;
            case 'unavailable':
                return Object.freeze({ kind: 'credential_unreadable' as const, serverId: address.serverId });
            case 'unknown_home':
                return UNKNOWN_HOME;
            case 'signed_out':
                return Object.freeze({ kind: 'signed_out' as const, homeName });
            case 'bound':
                return Object.freeze({
                    kind: 'bound' as const,
                    scope: resolution.scope,
                    // A route may retain a URL alias after credential restoration promotes
                    // the Home identity. Writes must address the same snapshot as its reads.
                    address: { serverId: resolution.scope.serverId, teamId: address.teamId },
                    homeName,
                    state: resolveTeamViewState(snapshot),
                    snapshot,
                    refresh,
                });
        }
    }, [address, resolution, homeName, snapshot, refresh]);
}
