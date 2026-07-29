import { describe, expect, it } from 'vitest';
import {
    createFeatureDecision,
    FeaturesResponseSchema,
    PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
    type FeaturesResponse,
    type FeatureDecision,
    type PeerMediationObservabilityDeltaV1,
    type PeerMediationObservabilityScopeV1,
    type PeerMediationObservabilitySnapshotV1,
} from '@happier-dev/protocol';

type SubscriptionModuleShape = Readonly<{
    resolvePeerMediationObservabilitySubscriptionState: (
        input: Readonly<{
            featureDecision?: FeatureDecision | null;
            serverFeatures: FeaturesResponse | null | undefined;
        }>,
    ) => unknown;
    createPeerMediationObservabilitySubscription: (
        input: Readonly<{
            scope: PeerMediationObservabilityScopeV1;
            source: 'server' | 'daemon';
            featureDecision?: FeatureDecision | null;
            serverFeatures: FeaturesResponse | null | undefined;
            transport: {
                emit: (eventName: string, payload: unknown) => void;
                on: (eventName: string, handler: (payload: unknown) => void) => () => void;
            };
            onSnapshot: (snapshot: PeerMediationObservabilitySnapshotV1) => void;
            onDelta: (delta: PeerMediationObservabilityDeltaV1) => void;
            onUnavailable?: (reasonCode: string) => void;
        }>,
    ) => { close: () => void; state: unknown };
}>;

async function loadSubscriptionsModule(): Promise<Partial<SubscriptionModuleShape>> {
    const modulePath = './subscriptions';
    return import(modulePath).catch(() => ({})) as Promise<Partial<SubscriptionModuleShape>>;
}

const machineScope: PeerMediationObservabilityScopeV1 = {
    kind: 'machine',
    accountId: 'acct_1',
    machineId: 'machine_1',
};

function featuresResponse(enabled: boolean, available: boolean): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: true,
                    observability: { enabled },
                },
            },
        },
        capabilities: {
            machines: {
                peerMediation: {
                    observability: {
                        enabled,
                        available,
                        supportedFlowKinds: ['tcp_tunnel', 'live_stream'],
                        supportedEventKinds: ['flow.started', 'tunnel.bytes'],
                    },
                },
            },
        },
    });
}

function featuresResponseWithoutObservabilityCapability(enabled: boolean): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: true,
                    observability: { enabled },
                },
            },
        },
        capabilities: {
            machines: {
                peerMediation: {},
            },
        },
    });
}

function featureDecision(enabled: boolean): FeatureDecision {
    return createFeatureDecision({
        featureId: 'machines.peerMediation.observability',
        state: enabled ? 'enabled' : 'disabled',
        blockedBy: enabled ? null : 'server',
        blockerCode: enabled ? 'none' : 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'runtime' },
    });
}

describe('peer mediation observability subscriptions', () => {
    it('fails closed without opening a subscription when the feature bit is missing', async () => {
        const mod = await loadSubscriptionsModule();

        expect(mod.resolvePeerMediationObservabilitySubscriptionState).toBeTypeOf('function');
        expect(mod.createPeerMediationObservabilitySubscription).toBeTypeOf('function');
        if (!mod.resolvePeerMediationObservabilitySubscriptionState || !mod.createPeerMediationObservabilitySubscription) return;

        expect(mod.resolvePeerMediationObservabilitySubscriptionState({
            serverFeatures: featuresResponse(false, true),
        })).toEqual({
            status: 'unavailable',
            reasonCode: 'observability_unavailable',
        });

        const emitted: Array<{ eventName: string; payload: unknown }> = [];
        const unavailableReasons: string[] = [];
        const subscription = mod.createPeerMediationObservabilitySubscription({
            scope: machineScope,
            source: 'server',
            serverFeatures: featuresResponse(false, true),
            transport: {
                emit: (eventName, payload) => emitted.push({ eventName, payload }),
                on: () => () => undefined,
            },
            onSnapshot: () => undefined,
            onDelta: () => undefined,
            onUnavailable: (reasonCode) => unavailableReasons.push(reasonCode),
        });

        expect(subscription.state).toEqual({
            status: 'unavailable',
            reasonCode: 'observability_unavailable',
        });
        expect(emitted).toEqual([]);
        expect(unavailableReasons).toEqual(['observability_unavailable']);
    });

    it('subscribes from canonical feature bits even when capability metadata is missing or unavailable', async () => {
        const mod = await loadSubscriptionsModule();

        expect(mod.resolvePeerMediationObservabilitySubscriptionState).toBeTypeOf('function');
        expect(mod.createPeerMediationObservabilitySubscription).toBeTypeOf('function');
        if (!mod.resolvePeerMediationObservabilitySubscriptionState || !mod.createPeerMediationObservabilitySubscription) return;

        expect(mod.resolvePeerMediationObservabilitySubscriptionState({
            serverFeatures: featuresResponse(true, false),
        })).toEqual({ status: 'subscribed' });
        expect(mod.resolvePeerMediationObservabilitySubscriptionState({
            serverFeatures: featuresResponseWithoutObservabilityCapability(true),
        })).toEqual({ status: 'subscribed' });

        const emitted: Array<{ eventName: string; payload: unknown }> = [];
        const subscription = mod.createPeerMediationObservabilitySubscription({
            scope: machineScope,
            source: 'server',
            serverFeatures: featuresResponse(true, false),
            transport: {
                emit: (eventName, payload) => emitted.push({ eventName, payload }),
                on: () => () => undefined,
            },
            onSnapshot: () => undefined,
            onDelta: () => undefined,
        });

        expect(subscription.state).toEqual({ status: 'subscribed' });
        expect(emitted).toEqual([{
            eventName: PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
            payload: { scope: machineScope },
        }]);
        subscription.close();
    });

    it('fails closed when the resolved feature decision is not enabled', async () => {
        const mod = await loadSubscriptionsModule();

        expect(mod.resolvePeerMediationObservabilitySubscriptionState).toBeTypeOf('function');
        if (!mod.resolvePeerMediationObservabilitySubscriptionState) return;

        expect(mod.resolvePeerMediationObservabilitySubscriptionState({
            featureDecision: featureDecision(false),
            serverFeatures: featuresResponse(true, true),
        })).toEqual({
            status: 'unavailable',
            reasonCode: 'observability_unavailable',
        });
    });

    it('uses protocol socket constants for subscribe, unsubscribe, snapshot, and delta routing', async () => {
        const mod = await loadSubscriptionsModule();

        expect(mod.createPeerMediationObservabilitySubscription).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilitySubscription) return;

        const emitted: Array<{ eventName: string; payload: unknown }> = [];
        const handlers = new Map<string, (payload: unknown) => void>();
        const snapshots: PeerMediationObservabilitySnapshotV1[] = [];
        const deltas: PeerMediationObservabilityDeltaV1[] = [];
        const subscription = mod.createPeerMediationObservabilitySubscription({
            scope: machineScope,
            source: 'server',
            featureDecision: featureDecision(true),
            serverFeatures: featuresResponse(true, true),
            transport: {
                emit: (eventName, payload) => emitted.push({ eventName, payload }),
                on: (eventName, handler) => {
                    handlers.set(eventName, handler);
                    return () => handlers.delete(eventName);
                },
            },
            onSnapshot: (next) => snapshots.push(next),
            onDelta: (next) => deltas.push(next),
        });

        expect(subscription.state).toEqual({ status: 'subscribed' });
        expect(emitted).toEqual([{
            eventName: PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
            payload: { scope: machineScope },
        }]);
        expect(handlers.has(PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT)).toBe(true);
        expect(handlers.has(PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT)).toBe(true);

        handlers.get(PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT)?.({
            v: 1,
            scope: machineScope,
            sequence: 1,
            capturedAtMs: 1_000,
            flows: [],
        });
        handlers.get(PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT)?.({
            v: 1,
            scope: machineScope,
            sequence: 2,
            events: [],
        });
        subscription.close();

        expect(snapshots).toHaveLength(1);
        expect(deltas).toHaveLength(1);
        expect(emitted.at(-1)).toEqual({
            eventName: PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
            payload: { scope: machineScope },
        });
        expect(handlers.size).toBe(0);
    });

    it('drops deltas containing events for a different scope', async () => {
        const mod = await loadSubscriptionsModule();

        expect(mod.createPeerMediationObservabilitySubscription).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilitySubscription) return;

        const handlers = new Map<string, (payload: unknown) => void>();
        const deltas: PeerMediationObservabilityDeltaV1[] = [];
        const subscription = mod.createPeerMediationObservabilitySubscription({
            scope: machineScope,
            source: 'server',
            featureDecision: featureDecision(true),
            serverFeatures: featuresResponse(true, true),
            transport: {
                emit: () => undefined,
                on: (eventName, handler) => {
                    handlers.set(eventName, handler);
                    return () => handlers.delete(eventName);
                },
            },
            onSnapshot: () => undefined,
            onDelta: (next) => deltas.push(next),
        });

        handlers.get(PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT)?.({
            v: 1,
            scope: machineScope,
            sequence: 2,
            events: [{
                v: 1,
                eventId: 'event_other_scope',
                sequence: 2,
                emittedAtMs: 2_000,
                scope: {
                    kind: 'machine',
                    accountId: 'acct_1',
                    machineId: 'machine_other',
                },
                flow: {
                    flowId: 'flow_1',
                    flowKind: 'tcp_tunnel',
                    routeKind: 'server_relay',
                    tunnelId: 'tun_1',
                },
                kind: 'tunnel.bytes',
                data: { bytesIn: 1 },
                redaction: {
                    level: 'metadataOnly',
                    queryRedacted: true,
                    headersRedacted: true,
                    truncated: false,
                },
            }],
        });
        subscription.close();

        expect(deltas).toEqual([]);
    });
});
