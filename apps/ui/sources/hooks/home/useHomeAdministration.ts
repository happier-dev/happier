import * as React from 'react';

import {
    resolveHomeGovernanceViewState,
    type HomeGovernanceViewState,
} from '@/components/settings/home/governance/homeGovernanceViewState';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

import { readCurrentServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useHomeGovernanceSnapshot } from './useHomeGovernanceSnapshot';

/**
 * What this device can currently say about one explicitly addressed Home.
 *
 * `unknown_home`, `signed_out` and `credential_unreadable` are facts about this
 * device's saved Homes, not answers from the Home, and are deliberately distinct
 * from every state the Home itself reports. `credential_unreadable` is settled:
 * this device failed to read its saved credential, and only a re-read helps.
 */
export type HomeAdministrationBinding =
    | Readonly<{ kind: 'resolving' }>
    | Readonly<{ kind: 'unknown_home' }>
    | Readonly<{ kind: 'signed_out'; homeName: string }>
    | Readonly<{ kind: 'credential_unreadable'; serverId: string }>
    | Readonly<{
        kind: 'bound';
        scope: ServerAccountScope;
        /**
         * The credential lifetime of `scope` while it is current (`null` while a refresh re-checks
         * it). A destructive confirmation captures it and acts only if it is still current.
         */
        lifetime: ServerAccountScopeLifetime | null;
        homeName: string;
        state: HomeGovernanceViewState;
    }>;

const RESOLVING: HomeAdministrationBinding = Object.freeze({ kind: 'resolving' as const });
const UNKNOWN_HOME: HomeAdministrationBinding = Object.freeze({ kind: 'unknown_home' as const });

/**
 * Binds Home Administration to one exact Home for the whole time a screen is
 * open.
 *
 * The Home is addressed by the route's `serverId`, never by whichever Home
 * happens to be focused, so switching Homes elsewhere in the app cannot
 * retarget an open administration screen or a mutation started from it. The
 * Account comes from the Home-family credential binding, so signing out or
 * signing in as someone else on this Home moves the screen with it instead of
 * leaving it addressed to an Account this device no longer holds.
 */
export function useHomeAdministration(serverIdRaw: string): HomeAdministrationBinding {
    const serverId = serverIdRaw.trim();
    const profile = React.useMemo(
        () => (serverId ? getServerProfileById(serverId) : null),
        [serverId],
    );
    const homeName = useHomeDisplayLabel(profile);

    const { resolution, binding } = useServerCredentialAccountScopeBinding(serverId);
    // While a page that opens again re-resolves its credential, the Account this device still holds for the Home
    // keeps its last answer on screen (as a Team page does), so a return visit never shows the wait.
    const retainedOwner = resolution.kind === 'resolving' && serverId ? readCurrentServerCredentialAccountScopeLifetime(serverId) : null;
    const scope: ServerAccountScope | null = resolution.kind === 'bound' ? resolution.scope : retainedOwner?.scope ?? null;

    // Subscribing is what declares this screen a live consumer of that exact
    // Home; the engine owns when it is fetched and the screen never refetches.
    const snapshot = useHomeGovernanceSnapshot(scope);

    return React.useMemo<HomeAdministrationBinding>(() => {
        switch (resolution.kind) {
            case 'resolving':
                if (!retainedOwner || !snapshot?.data) return RESOLVING;
                return Object.freeze({
                    kind: 'bound' as const,
                    scope: retainedOwner.scope,
                    lifetime: retainedOwner,
                    homeName,
                    state: resolveHomeGovernanceViewState(snapshot),
                });
            case 'unavailable':
                return Object.freeze({ kind: 'credential_unreadable' as const, serverId });
            case 'unknown_home':
                return UNKNOWN_HOME;
            case 'signed_out':
                return Object.freeze({ kind: 'signed_out' as const, homeName });
            case 'bound':
                return Object.freeze({
                    kind: 'bound' as const,
                    scope: resolution.scope,
                    lifetime: binding,
                    homeName,
                    state: resolveHomeGovernanceViewState(snapshot),
                });
        }
    }, [resolution, binding, retainedOwner, homeName, snapshot, serverId]);
}
