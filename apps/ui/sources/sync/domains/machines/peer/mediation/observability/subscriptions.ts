import { PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT, PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT, PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT, PeerMediationObservabilityDeltaV1Schema, PeerMediationObservabilitySnapshotV1Schema, type PeerMediationObservabilityDeltaV1, type PeerMediationObservabilityScopeV1, type PeerMediationObservabilitySnapshotV1 } from '@happier-dev/protocol/machines/peer/mediation/observability/v1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { FeatureDecision } from '@happier-dev/protocol/features/decision';
import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { peerMediationObservabilityScopesEqual } from './keys';
import { isPeerMediationObservabilityDeltaSequenceContiguous } from './store';
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

    let closed = false;
    let lastSequence: number | undefined;
    let awaitingSnapshot = true;
    const requestSnapshot = () => input.transport.emit(
        PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
        subscribePayload({ scope: input.scope }),
    );

    const unsubscribeSnapshot = input.transport.on(
        PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT,
        (payload) => {
            const parsed = PeerMediationObservabilitySnapshotV1Schema.safeParse(payload);
            if (!closed && parsed.success && shouldAcceptSnapshot(input.scope, parsed.data)
                && (lastSequence === undefined || parsed.data.sequence >= lastSequence)) {
                lastSequence = parsed.data.sequence;
                awaitingSnapshot = false;
                input.onSnapshot(parsed.data);
            }
        },
    );
    const unsubscribeDelta = input.transport.on(
        PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
        (payload) => {
            const parsed = PeerMediationObservabilityDeltaV1Schema.safeParse(payload);
            if (closed || !parsed.success || !shouldAcceptDelta(input.scope, parsed.data)
                || awaitingSnapshot || lastSequence === undefined || parsed.data.sequence <= lastSequence) return;
            if (!isPeerMediationObservabilityDeltaSequenceContiguous(lastSequence, parsed.data.sequence)) {
                awaitingSnapshot = true;
                input.onDelta(parsed.data); // Preserve the read-side store's explicit stale state.
                requestSnapshot();
                return;
            }
            lastSequence = parsed.data.sequence;
            input.onDelta(parsed.data);
        },
    );

    requestSnapshot();

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
