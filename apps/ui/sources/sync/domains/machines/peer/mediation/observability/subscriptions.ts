import {
    PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
    PeerMediationObservabilityDeltaV1Schema,
    PeerMediationObservabilitySnapshotV1Schema,
    readServerEnabledBit,
    type FeatureDecision,
    type FeaturesResponse,
    type PeerMediationObservabilityDeltaV1,
    type PeerMediationObservabilityScopeV1,
    type PeerMediationObservabilitySnapshotV1,
} from '@happier-dev/protocol';

import { peerMediationObservabilityScopesEqual } from './keys';
import type { PeerMediationObservabilitySource } from './types';

export type PeerMediationObservabilitySubscriptionState = Readonly<
    | {
        status: 'subscribed';
      }
    | {
        status: 'unavailable';
        reasonCode: 'observability_unavailable';
      }
>;

export type PeerMediationObservabilityTransport = Readonly<{
    emit: (eventName: string, payload: unknown) => void;
    on: (eventName: string, handler: (payload: unknown) => void) => () => void;
}>;

export type PeerMediationObservabilitySubscription = Readonly<{
    state: PeerMediationObservabilitySubscriptionState;
    close: () => void;
}>;

export function resolvePeerMediationObservabilitySubscriptionState(input: Readonly<{
    featureDecision?: FeatureDecision | null;
    serverFeatures: FeaturesResponse | null | undefined;
}>): PeerMediationObservabilitySubscriptionState {
    if (input.featureDecision && input.featureDecision.state !== 'enabled') {
        return {
            status: 'unavailable',
            reasonCode: 'observability_unavailable',
        };
    }
    const features = input.serverFeatures;
    if (!features || readServerEnabledBit(features, 'machines.peerMediation.observability') !== true) {
        return {
            status: 'unavailable',
            reasonCode: 'observability_unavailable',
        };
    }
    return { status: 'subscribed' };
}

function subscribePayload(input: Readonly<{
    scope: PeerMediationObservabilityScopeV1;
}>): Record<string, unknown> {
    return {
        scope: input.scope,
    };
}

function shouldAcceptSnapshot(
    scope: PeerMediationObservabilityScopeV1,
    payload: PeerMediationObservabilitySnapshotV1,
): boolean {
    return peerMediationObservabilityScopesEqual(scope, payload.scope);
}

function shouldAcceptDelta(
    scope: PeerMediationObservabilityScopeV1,
    payload: PeerMediationObservabilityDeltaV1,
): boolean {
    return peerMediationObservabilityScopesEqual(scope, payload.scope)
        && payload.events.every((event) => peerMediationObservabilityScopesEqual(payload.scope, event.scope));
}

export function createPeerMediationObservabilitySubscription(input: Readonly<{
    scope: PeerMediationObservabilityScopeV1;
    source: PeerMediationObservabilitySource;
    featureDecision?: FeatureDecision | null;
    serverFeatures: FeaturesResponse | null | undefined;
    transport: PeerMediationObservabilityTransport;
    onSnapshot: (snapshot: PeerMediationObservabilitySnapshotV1) => void;
    onDelta: (delta: PeerMediationObservabilityDeltaV1) => void;
    onUnavailable?: (reasonCode: 'observability_unavailable') => void;
}>): PeerMediationObservabilitySubscription {
    const state = resolvePeerMediationObservabilitySubscriptionState({
        featureDecision: input.featureDecision,
        serverFeatures: input.serverFeatures,
    });
    if (state.status !== 'subscribed') {
        input.onUnavailable?.(state.reasonCode);
        return {
            state,
            close: () => undefined,
        };
    }

    const unsubscribeSnapshot = input.transport.on(
        PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT,
        (payload) => {
            const parsed = PeerMediationObservabilitySnapshotV1Schema.safeParse(payload);
            if (parsed.success && shouldAcceptSnapshot(input.scope, parsed.data)) {
                input.onSnapshot(parsed.data);
            }
        },
    );
    const unsubscribeDelta = input.transport.on(
        PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
        (payload) => {
            const parsed = PeerMediationObservabilityDeltaV1Schema.safeParse(payload);
            if (parsed.success && shouldAcceptDelta(input.scope, parsed.data)) {
                input.onDelta(parsed.data);
            }
        },
    );

    input.transport.emit(
        PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
        subscribePayload({ scope: input.scope }),
    );

    let closed = false;
    return {
        state,
        close: () => {
            if (closed) return;
            closed = true;
            unsubscribeSnapshot();
            unsubscribeDelta();
            input.transport.emit(
                PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
                subscribePayload({ scope: input.scope }),
            );
        },
    };
}
