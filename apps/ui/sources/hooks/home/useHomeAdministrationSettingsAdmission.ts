import * as React from 'react';

import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import {
    resolveHomeAdministrationSettingsAdmission,
    type HomeAdministrationHomeObservation,
    type HomeAdministrationSettingsAdmission,
} from '@/sync/domains/home/governance/homeAdministrationSettingsAdmission';
import { observeHomeGovernance, refreshHomeGovernanceSnapshot } from '@/sync/engine/home/governance/homeGovernanceEngine';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import {
    getHomeGovernanceSnapshot,
    getHomeGovernanceSnapshotsVersion,
    subscribeHomeGovernanceSnapshots,
} from '@/sync/store/home/governance/homeGovernanceSnapshots';

import { useServerCredentialAccountScopeResolutions } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopeListKey } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type {
    HomeAdministrationHomeEntry,
    HomeAdministrationSettingsAdmission,
} from '@/sync/domains/home/governance/homeAdministrationSettingsAdmission';

const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

export type HomeAdministrationSettingsAdmissionBinding = HomeAdministrationSettingsAdmission & Readonly<{
    /** Asks one Home again: its administration projection, or its credential when that is unreadable. */
    retry: (serverId: string) => void;
}>;

/**
 * The Settings admission decision for the Home Administration destination.
 *
 * It reads the exact Home set the user is looking at, binds each of those Homes
 * to the Account this device holds *there*, and asks each Home's own projection
 * whether it offers administration. The focused Home's role and the server
 * feature payload take no part: administering Home A says nothing about Home B,
 * and Home governance is core behavior rather than a gated capability.
 *
 * Mounting this hook is also what keeps those Homes observed, so a Settings
 * entry that offers the destination is looking at live state rather than a
 * projection nobody is refreshing.
 */
export function useHomeAdministrationSettingsAdmission(
    options?: Readonly<{
        enabled?: boolean;
        /**
         * The Homes to answer for, instead of the Homes in view. The Homes page lists every Home this
         * device knows and offers the console on each one that admits this account.
         */
        serverIds?: readonly string[];
    }>,
): HomeAdministrationSettingsAdmissionBinding {
    const enabled = options?.enabled ?? true;
    const selection = useEffectiveServerSelection();
    const serverIds = enabled ? options?.serverIds ?? selection.serverIds : NO_SERVER_IDS;
    const serverIdsKey = JSON.stringify([...serverIds]);

    const scopes = useServerCredentialAccountScopeResolutions(serverIds);

    // Every resolution matters to the decision, so this key covers all of them:
    // a Home moving from resolving to signed out changes what may be offered
    // even though no Account was ever bound.
    const scopesKey = JSON.stringify([...scopes.entries()]
        .map(([serverId, resolution]) => (resolution.kind === 'bound'
            ? [serverId, resolution.kind, resolution.scope.accountId]
            : [serverId, resolution.kind]))
        .sort(([left], [right]) => left.localeCompare(right)));

    // Observing is what declares this surface a live consumer of each Home. The
    // engine still owns when each one is actually read.
    const boundScopesKey = [...scopes.entries()]
        .filter(([, resolution]) => resolution.kind === 'bound')
        .map(([, resolution]) => resolution.kind === 'bound' ? resolution.scope : null)
        .filter((scope) => scope !== null)
        .sort((left, right) => left.serverId.localeCompare(right.serverId));
    const boundScopesIdentity = serverAccountScopeListKey(boundScopesKey);

    React.useEffect(() => {
        const releases: (() => void)[] = [];
        for (const resolution of scopes.values()) {
            if (resolution.kind !== 'bound') continue;
            releases.push(observeHomeGovernance(resolution.scope));
        }
        return () => {
            for (const release of releases) release();
        };
        // The bound set is the identity of what is observed; `scopes` itself
        // changes identity on unrelated resolution churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [boundScopesIdentity]);

    const version = React.useSyncExternalStore(
        subscribeHomeGovernanceSnapshots,
        getHomeGovernanceSnapshotsVersion,
        getHomeGovernanceSnapshotsVersion,
    );

    const scopesRef = React.useRef(scopes);
    scopesRef.current = scopes;
    const retry = React.useCallback((serverId: string) => {
        const resolution = scopesRef.current.get(resolveServerProfileScopeIdForIdentifier(serverId));
        if (resolution?.kind === 'bound') void refreshHomeGovernanceSnapshot(resolution.scope);
        else retryServerCredentialAccountScope(serverId);
    }, []);

    const admission = React.useMemo(() => {
        const observationsByServerId: Record<string, HomeAdministrationHomeObservation> = {};
        for (const serverId of serverIds) {
            const resolution = scopes.get(resolveServerProfileScopeIdForIdentifier(serverId));
            if (!resolution) continue;
            const snapshot = resolution.kind === 'bound'
                ? getHomeGovernanceSnapshot(resolution.scope)
                : null;
            observationsByServerId[serverId] = {
                scope: resolution.kind,
                projection: snapshot?.data ?? null,
                error: snapshot?.error ?? null,
                stale: snapshot?.stale ?? false,
            };
        }
        return resolveHomeAdministrationSettingsAdmission({ serverIds, observationsByServerId });
        // `version` is the store's change signal; the keys carry the requested
        // Home set and every credential resolution behind it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverIdsKey, scopesKey, version]);

    return React.useMemo(() => ({ ...admission, retry }), [admission, retry]);
}
