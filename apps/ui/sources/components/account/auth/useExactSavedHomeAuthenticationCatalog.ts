import * as React from 'react';

import { acquireAccountServiceAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { fetchHomeAuthEntry } from '@/auth/entry/authEntryClient';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { retryServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveServerProfileScopeId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { createUsableAuthEntryObservation, type UsableAuthEntryObservation } from './useAuthEntryOptions';

type HomeAuthTransport = Awaited<ReturnType<typeof acquireAccountServiceAuthTransport>>['transport'];
type AuthenticationActions = UsableAuthEntryObservation['options']['authenticationActions'];

export type ExactSavedHomeAuthenticationCatalog = Readonly<{
    state: 'loading' | 'ready' | 'unavailable';
    /** The Home's own advertised methods; empty until `ready`. */
    actions: AuthenticationActions;
    transport: HomeAuthTransport | null;
    keyChallengeV2Available: boolean;
    /** Whether an `unavailable` Home answered as incompatible rather than unreachable. */
    incompatible: boolean;
    retry: () => void;
}>;

type TransportState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; transport: HomeAuthTransport }>
    | Readonly<{ kind: 'unavailable' }>;

type EntryState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; observation: UsableAuthEntryObservation }>
    | Readonly<{ kind: 'unavailable'; incompatible: boolean }>;

const NO_ACTIONS: AuthenticationActions = [];

/**
 * The authentication methods one exact saved Home advertises, read from that
 * Home itself — never from whichever Home is focused. It owns the Home's auth
 * transport (acquired and closed per Home), the Home's auth-entry projection
 * with the released feature catalog as the unsupported-endpoint fallback, and
 * aborts in-flight reads when the profile changes.
 */
export function useExactSavedHomeAuthenticationCatalog(
    profile: ServerProfile | null,
): ExactSavedHomeAuthenticationCatalog {
    const homeServerIdentityId = profile?.serverIdentityId?.trim() || null;
    const scopeId = profile && homeServerIdentityId ? resolveServerProfileScopeId(profile) : null;
    const canonicalServerUrl = homeServerIdentityId ? profile?.canonicalServerUrl ?? profile?.serverUrl ?? null : null;
    const snapshot = useServerFeaturesSnapshotForServerId(scopeId, { enabled: Boolean(scopeId) });
    const [attempt, setAttempt] = React.useState(0);
    const [transportState, setTransportState] = React.useState<TransportState>({ kind: 'loading' });
    const [entryState, setEntryState] = React.useState<EntryState>({ kind: 'loading' });

    React.useEffect(() => {
        if (!canonicalServerUrl || !homeServerIdentityId) {
            setTransportState({ kind: 'unavailable' });
            return;
        }
        let current = true;
        let close = async () => {};
        setTransportState({ kind: 'loading' });
        void acquireAccountServiceAuthTransport({
            serverIdentityId: homeServerIdentityId,
            canonicalServerUrl,
        }).then((acquired) => {
            close = acquired.close;
            if (current) setTransportState({ kind: 'ready', transport: acquired.transport });
            else void acquired.close();
        }).catch(() => {
            if (current) setTransportState({ kind: 'unavailable' });
        });
        return () => {
            current = false;
            void close();
        };
    }, [attempt, canonicalServerUrl, homeServerIdentityId]);

    React.useEffect(() => {
        if (!canonicalServerUrl || !scopeId || snapshot.status !== 'ready' || transportState.kind !== 'ready') {
            setEntryState({ kind: 'loading' });
            return;
        }
        let current = true;
        const controller = new AbortController();
        setEntryState({ kind: 'loading' });
        void fetchHomeAuthEntry({
            endpointUrl: canonicalServerUrl,
            serverId: scopeId,
            ...transportState.transport,
            signal: controller.signal,
        }).then((entry) => {
            if (!current) return;
            if (entry.kind === 'ready' && entry.projection.state === 'ready') {
                setEntryState({ kind: 'ready', observation: createUsableAuthEntryObservation({
                    features: snapshot.features,
                    entryProjection: entry.projection,
                    authEntryUnavailable: false,
                }) });
                return;
            }
            if (entry.kind === 'unsupported') {
                // An older Home without contextual auth entry: its released
                // feature catalog is the method list.
                setEntryState({ kind: 'ready', observation: createUsableAuthEntryObservation({
                    features: snapshot.features,
                    entryProjection: null,
                    authEntryUnavailable: false,
                }) });
                return;
            }
            setEntryState({
                kind: 'unavailable',
                incompatible: entry.kind === 'incompatible'
                    || (entry.kind === 'ready' && entry.projection.state === 'update_required'),
            });
        }).catch(() => {
            if (current) setEntryState({ kind: 'unavailable', incompatible: false });
        });
        return () => {
            current = false;
            controller.abort();
        };
    }, [canonicalServerUrl, scopeId, snapshot, transportState]);

    const retry = React.useCallback(() => {
        if (scopeId) {
            fireAndForget(retryServerFeaturesSnapshot({ serverId: scopeId }), {
                tag: 'useExactSavedHomeAuthenticationCatalog.retryFeatures',
            });
        }
        setAttempt((value) => value + 1);
    }, [scopeId]);

    if (!profile || !homeServerIdentityId || snapshot.status === 'error' || snapshot.status === 'unsupported'
        || transportState.kind === 'unavailable' || entryState.kind === 'unavailable') {
        return {
            state: 'unavailable',
            actions: NO_ACTIONS,
            transport: null,
            keyChallengeV2Available: false,
            incompatible: snapshot.status === 'unsupported'
                || (entryState.kind === 'unavailable' && entryState.incompatible),
            retry,
        };
    }
    if (snapshot.status === 'loading' || transportState.kind === 'loading' || entryState.kind === 'loading') {
        return { state: 'loading', actions: NO_ACTIONS, transport: null, keyChallengeV2Available: false, incompatible: false, retry };
    }
    return {
        state: 'ready',
        actions: entryState.observation.options.authenticationActions,
        transport: transportState.transport,
        keyChallengeV2Available: entryState.observation.options.keyChallengeV2Available,
        incompatible: false,
        retry,
    };
}
