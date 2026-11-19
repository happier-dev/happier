import * as React from 'react';

import {
    resolveTeamViewState,
    type TeamViewState,
} from '@/components/settings/teams/teamViewState';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readCurrentServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
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
type TeamBindingProjection = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    homeName: string;
    state: TeamViewState;
    /** Raw data for a surface that needs a fact the view state does not project. */
    snapshot: TeamSnapshot | null;
    refresh: () => void;
}>;

export type TeamBinding =
    | Readonly<{ kind: 'resolving'; retained?: TeamBindingProjection }>
    | Readonly<{ kind: 'invalid_address' }>
    | Readonly<{ kind: 'unknown_home' }>
    | Readonly<{ kind: 'signed_out'; homeName: string }>
    | Readonly<{ kind: 'credential_unreadable'; serverId: string }>
    | Readonly<{ kind: 'bound' } & TeamBindingProjection>;

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
    const retainedOwner = resolution.kind === 'resolving' && address
        ? readCurrentServerCredentialAccountScopeLifetime(address.serverId) : null;
    const displayScope = scope ?? retainedOwner?.scope ?? null;

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
        () => retainedOwner && !retainedOwner.isCurrent() ? null : getTeamSnapshot(
            displayScope, createTeamAddress(displayScope?.serverId, teamId),
        ),
        [displayScope, retainedOwner, teamId],
    );

    const snapshot = React.useSyncExternalStore(subscribeTeamsSnapshots, getSnapshot, getSnapshot);

    const refresh = React.useCallback(() => {
        const target = createServerAccountScope(scopeServerId, scopeAccountId);
        const targetAddress = createTeamAddress(scopeServerId, teamId);
        if (!target || !targetAddress) return;
        void refreshTeam(target, targetAddress);
    }, [scopeServerId, scopeAccountId, teamId]);

    const resolvedAddressRef = React.useRef<TeamAddress | undefined>(undefined);
    return React.useMemo<TeamBinding>(() => {
        if (!address) return INVALID_ADDRESS;
        switch (resolution.kind) {
            case 'unavailable':
                return Object.freeze({ kind: 'credential_unreadable' as const, serverId: address.serverId });
            case 'unknown_home':
                return UNKNOWN_HOME;
            case 'signed_out':
                return Object.freeze({ kind: 'signed_out' as const, homeName });
        }
        const bound = resolution.kind === 'bound';
        if (!displayScope || (!bound && !snapshot?.data)) return RESOLVING;
        const resolvedAddress = retainShallow(resolvedAddressRef.current, {
            serverId: displayScope.serverId,
            teamId: address.teamId,
        });
        resolvedAddressRef.current = resolvedAddress;
        const projection = Object.freeze({
            scope: displayScope,
            address: resolvedAddress,
            homeName,
            state: resolveTeamViewState(snapshot, bound),
            snapshot,
            refresh,
        });
        return bound ? Object.freeze({ kind: 'bound', ...projection })
            : Object.freeze({ kind: 'resolving', retained: projection });
    }, [address, resolution, displayScope, homeName, snapshot, refresh]);
}
