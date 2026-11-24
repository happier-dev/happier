import * as React from 'react';
import {
    TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1,
    teamDirectoryQueryKeyV1,
    type TeamsListInputV1,
} from '@happier-dev/protocol/teams';

import {
    resolveTeamsDirectoryViewState,
    type TeamsDirectoryViewState,
} from '@/components/settings/teams/teamsDirectoryViewState';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useServerCredentialAccountScopeResolutions } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readCurrentServerCredentialAccountScopeLifetime, retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useTeamsSettingsAdmission } from '@/hooks/teams/useTeamsSettingsAdmission';
import {
    serverAccountScopeListKey,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { TeamsHomeAdmissionEntry } from '@/sync/domains/teams/teamsSettingsAdmission';
import {
    loadMoreTeamsDirectory,
    observeTeamsDirectory,
    refreshTeamsDirectory,
} from '@/sync/engine/teams/teamsDirectoryEngine';
import {
    getTeamsDirectorySnapshot,
    getTeamsDirectorySnapshotsSelectionKey,
    subscribeTeamsSnapshots,
    type TeamsDirectorySnapshot,
} from '@/sync/store/teams/teamsSnapshots';

/**
 * The Teams directory across the exact Home set the user is looking at.
 *
 * Admission decides *which* Homes may contribute, each Home's own saved
 * credential decides *as whom* it is read, and the engine decides *when* it is
 * read. This hook adds none of those decisions: it binds them together, keeps
 * every admitted Home observed while the surface is mounted, and projects one
 * truthful view state that keeps reachable Homes rendered while naming the ones
 * that could not answer.
 */

export type TeamsDirectoryBinding = TeamsDirectoryViewState & Readonly<{
    /** The Homes currently contributing, for a caller that needs the targets. */
    scopes: readonly ServerAccountScope[];
    /** Whether a further page exists on any contributing Home. */
    hasMore: boolean;
    refresh: () => void;
    loadMore: () => void;
}>;

const EMPTY_SCOPES: readonly ServerAccountScope[] = Object.freeze([]);

function directoryInput(
    scope: TeamsListInputV1['scope'],
    archived: TeamsListInputV1['archived'],
): TeamsListInputV1 {
    return {
        v: 1,
        scope,
        archived,
        limit: TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1,
    };
}

export function useTeamsDirectory(options?: Readonly<{
    /** `all` observes both protocol sequences, each with its own cursor. */
    archived?: TeamsListInputV1['archived'] | 'all';
    enabled?: boolean;
    /**
     * `member` is what a person's own Teams destination asks for. `administered`
     * is the explicit Home-governance scope a Home administrator with
     * `manageAllTeams` may request; the Home authorizes it, and its answer is a
     * separate query key so the two never share a page sequence or a snapshot.
     */
    scope?: TeamsListInputV1['scope'];
    /**
     * The exact Homes this read is about. A Home-scoped surface asks its one
     * Home and reports on that Home alone, so the target set is handed to the
     * admission owner itself rather than intersected with the user's current
     * Home view selection afterwards — an administration screen for Home A is
     * about Home A whichever Home the person happens to be looking at.
     */
    serverIds?: readonly string[];
}>): TeamsDirectoryBinding {
    const enabled = options?.enabled ?? true;
    const archived = options?.archived ?? 'active';
    const scope = options?.scope ?? 'member';
    const admission = useTeamsSettingsAdmission({
        enabled,
        ...(options?.serverIds ? { serverIds: options.serverIds } : {}),
    });

    // Only a Home the feature decision admitted is ever read. A Home that said
    // no is not asked for Teams it has told us it does not have.
    const admittedHomes = admission.homes;
    const capableServerIds = admission.capableServerIds;
    const scopeResolutions = useServerCredentialAccountScopeResolutions(enabled ? capableServerIds : []);

    const scopes = React.useMemo(() => {
        const out: ServerAccountScope[] = [];
        for (const serverId of capableServerIds) {
            const resolution = scopeResolutions.get(resolveServerProfileScopeIdForIdentifier(serverId));
            if (resolution?.kind === 'bound') out.push(resolution.scope);
        }
        return out.length > 0 ? Object.freeze(out) : EMPTY_SCOPES;
    }, [capableServerIds, scopeResolutions]);

    // A surface mounting again (a return) re-resolves each Home's credential. While that runs, the
    // credential this device already holds, while it is still current, names the Account whose
    // last-known pages the store keeps, so those rows paint at once instead of a loading line. Only
    // a bound credential is observed or refreshed; this scope only reads.
    const readScopes = React.useMemo(() => {
        const out = new Map<string, ServerAccountScope>();
        for (const serverId of capableServerIds) {
            const resolution = scopeResolutions.get(resolveServerProfileScopeIdForIdentifier(serverId));
            const scope = resolution?.kind === 'bound'
                ? resolution.scope
                : resolution === undefined || resolution.kind === 'resolving'
                    ? readCurrentServerCredentialAccountScopeLifetime(serverId)?.scope
                    : undefined;
            if (scope) out.set(serverId, scope);
        }
        return out;
    }, [capableServerIds, scopeResolutions]);
    const readScopeList = React.useMemo(() => [...readScopes.values()], [readScopes]);

    const inputs = React.useMemo(() => archived === 'all'
        ? [directoryInput(scope, 'active'), directoryInput(scope, 'archived')]
        : [directoryInput(scope, archived)], [scope, archived]);
    const queryKeys = React.useMemo(() => inputs.map(teamDirectoryQueryKeyV1), [inputs]);

    // Observing is what declares this surface a live consumer of each Home. The
    // engine owns first load, Account-change wake and retry; this never decides
    // to refetch on its own.
    const scopesKey = serverAccountScopeListKey(scopes);
    React.useEffect(() => {
        if (!enabled) return;
        const releases = scopes.flatMap((scope) => inputs.map((input) => observeTeamsDirectory(scope, input)));
        return () => {
            for (const release of releases) release();
        };
        // `scopesKey` is the identity of the observed Home/Account set.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, inputs, scopesKey]);

    const getSnapshots = React.useCallback(() => {
        const byServerId: Record<string, readonly (TeamsDirectorySnapshot | undefined)[]> = {};
        // Credential/snapshot keys use the published Home identity; the view
        // keeps the requested profile identifier, including its navigation address.
        for (const [serverId, scope] of readScopes) {
            byServerId[serverId] = queryKeys.map((queryKey) => getTeamsDirectorySnapshot(scope, queryKey) ?? undefined);
        }
        return byServerId;
    }, [queryKeys, readScopes]);

    const readSelectionKey = React.useCallback(
        () => getTeamsDirectorySnapshotsSelectionKey(readScopeList, queryKeys),
        [readScopeList, queryKeys],
    );
    const snapshotsVersion = React.useSyncExternalStore(
        subscribeTeamsSnapshots,
        readSelectionKey,
        readSelectionKey,
    );

    const homeNamesByServerId = React.useMemo(() => {
        const names: Record<string, string | undefined> = {};
        for (const home of admittedHomes) {
            const profile = getServerProfileById(home.serverId);
            names[home.serverId] = resolveHomeDisplayLabel(profile, home.serverId);
        }
        return names;
    }, [admittedHomes]);

    // A Home whose credential this device cannot resolve has not refused; it is
    // reported as still resolving rather than silently dropped. A credential
    // this device failed to read is settled on its own reason, never a spinner.
    const homes = React.useMemo<readonly TeamsHomeAdmissionEntry[]>(() => admittedHomes.map((home) => {
        if (home.state !== 'capable') return home;
        const resolution = scopeResolutions.get(resolveServerProfileScopeIdForIdentifier(home.serverId));
        if (resolution?.kind === 'bound' || readScopes.has(home.serverId)) return home;
        if (resolution?.kind === 'signed_out' || resolution?.kind === 'unknown_home') {
            return { serverId: home.serverId, state: 'disabled' as const };
        }
        return resolution?.kind === 'unavailable'
            ? { serverId: home.serverId, state: 'unresolved' as const, reason: 'credential_unreadable' as const }
            : { serverId: home.serverId, state: 'unresolved' as const, reason: 'loading' as const };
    }), [admittedHomes, readScopes, scopeResolutions]);

    const previousState = React.useRef<TeamsDirectoryViewState | null>(null);
    const state = React.useMemo(
        () => {
            const next = resolveTeamsDirectoryViewState({
            homes,
            homeNamesByServerId,
            snapshotsByServerId: getSnapshots(),
            }, previousState.current);
            previousState.current = next;
            return next;
        },
        // `snapshotsVersion` is the store's change signal for the observed keys.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [homes, homeNamesByServerId, getSnapshots, snapshotsVersion],
    );

    const hasMore = React.useMemo(
        () => readScopeList.some((scope) => queryKeys.some((queryKey) => (getTeamsDirectorySnapshot(scope, queryKey)?.nextCursor ?? null) !== null)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [queryKeys, readScopeList, snapshotsVersion],
    );

    const unreadableServerIdsKey = JSON.stringify(homes
        .filter((home) => home.state === 'unresolved' && home.reason === 'credential_unreadable')
        .map((home) => home.serverId));
    const refresh = React.useCallback(() => {
        for (const scope of scopes) {
            for (const input of inputs) void refreshTeamsDirectory(scope, input);
        }
        for (const serverId of JSON.parse(unreadableServerIdsKey) as string[]) {
            retryServerCredentialAccountScope(serverId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inputs, scopesKey, unreadableServerIdsKey]);

    const loadMore = React.useCallback(() => {
        for (const scope of scopes) {
            for (const input of inputs) void loadMoreTeamsDirectory(scope, input);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inputs, scopesKey]);

    return React.useMemo(
        () => Object.freeze({ ...state, scopes, hasMore, refresh, loadMore }),
        [state, scopes, hasMore, refresh, loadMore],
    );
}
