import * as React from 'react';
import type {
    FeaturesResponse,
    PeerMediationObservabilityScopeV1,
} from '@happier-dev/protocol';

import { apiSocket } from '@/sync/api/session/apiSocket';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';

import { peerMediationObservabilityScopeKey } from './keys';
import {
    applyPeerMediationObservabilityDelta,
    applyPeerMediationObservabilitySnapshot,
    applyPeerMediationObservabilityUnavailable,
    createPeerMediationObservabilityUiStore,
} from './store';
import {
    createPeerMediationObservabilitySubscription,
    type PeerMediationObservabilityTransport,
} from './subscriptions';
import type {
    PeerMediationObservabilitySource,
    PeerMediationObservabilityUiStore,
} from './types';

export type UsePeerMediationObservabilityStoreInput = Readonly<{
    scope?: PeerMediationObservabilityScopeV1 | null;
    source?: PeerMediationObservabilitySource;
    serverId?: string | null;
    enabled?: boolean;
    serverFeatures?: FeaturesResponse | null;
    transport?: PeerMediationObservabilityTransport;
}>;

function createApiSocketObservabilityTransport(): PeerMediationObservabilityTransport {
    return {
        emit: (eventName, payload) => {
            apiSocket.send(eventName, payload);
        },
        on: (eventName, handler) => apiSocket.onMessage(eventName, handler),
    };
}

function useApiSocketConnected(enabled: boolean): boolean {
    const [connected, setConnected] = React.useState(false);

    React.useEffect(() => {
        if (!enabled) {
            setConnected(false);
            return;
        }
        const unsubscribe = apiSocket.onStatusChange((status) => {
            setConnected(status === 'connected');
        });
        return () => {
            unsubscribe();
        };
    }, [enabled]);

    return connected;
}

export function usePeerMediationObservabilityStore(
    input: UsePeerMediationObservabilityStoreInput,
): PeerMediationObservabilityUiStore {
    const enabled = input.enabled ?? true;
    const source = input.source ?? 'server';
    const scope = input.scope ?? null;
    const scopeKey = scope ? peerMediationObservabilityScopeKey(scope) : null;
    const hasInjectedTransport = Boolean(input.transport);
    const socketConnected = useApiSocketConnected(enabled && !hasInjectedTransport);
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(input.serverId, {
        enabled: enabled && input.serverFeatures === undefined,
    });
    const [state, setState] = React.useState<PeerMediationObservabilityUiStore>(() => (
        createPeerMediationObservabilityUiStore()
    ));

    const serverFeatures = input.serverFeatures !== undefined
        ? input.serverFeatures
        : serverFeaturesSnapshot.status === 'ready'
            ? serverFeaturesSnapshot.features
            : null;
    const canUseTransport = hasInjectedTransport || socketConnected;

    React.useEffect(() => {
        if (!enabled || !scope || !scopeKey) {
            setState(createPeerMediationObservabilityUiStore());
            return;
        }
        if (!serverFeatures || !canUseTransport) {
            return;
        }

        setState(createPeerMediationObservabilityUiStore());
        const transport = input.transport ?? createApiSocketObservabilityTransport();
        const subscription = createPeerMediationObservabilitySubscription({
            scope,
            source,
            serverFeatures,
            transport,
            onSnapshot: (snapshot) => {
                setState((previous) => applyPeerMediationObservabilitySnapshot(previous, {
                    source,
                    snapshot,
                }));
            },
            onDelta: (delta) => {
                setState((previous) => applyPeerMediationObservabilityDelta(previous, {
                    source,
                    delta,
                }));
            },
            onUnavailable: (reasonCode) => {
                setState((previous) => applyPeerMediationObservabilityUnavailable(previous, {
                    scope,
                    reasonCode,
                }));
            },
        });

        return () => {
            subscription.close();
        };
    }, [canUseTransport, enabled, input.transport, scope, scopeKey, serverFeatures, source]);

    return state;
}
