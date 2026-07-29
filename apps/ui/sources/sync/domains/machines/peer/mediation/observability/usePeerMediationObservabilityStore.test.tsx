import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
    type FeaturesResponse,
    type PeerMediationObservabilityScopeV1,
} from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { selectPeerMediationObservabilityFlowSummaries, selectPeerMediationObservabilityScopeState } from './selectors';
import type { PeerMediationObservabilityTransport } from './subscriptions';

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({ status: 'loading' }),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onStatusChange: () => () => undefined,
        onMessage: () => () => undefined,
        send: () => true,
    },
}));

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

function createTransportHarness(): Readonly<{
    transport: PeerMediationObservabilityTransport;
    emitted: Array<Readonly<{ eventName: string; payload: unknown }>>;
    emitIncoming: (eventName: string, payload: unknown) => void;
}> {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const emitted: Array<Readonly<{ eventName: string; payload: unknown }>> = [];
    return {
        emitted,
        emitIncoming: (eventName, payload) => {
            for (const handler of handlers.get(eventName) ?? []) {
                handler(payload);
            }
        },
        transport: {
            emit: (eventName, payload) => {
                emitted.push({ eventName, payload });
            },
            on: (eventName, handler) => {
                const eventHandlers = handlers.get(eventName) ?? new Set<(payload: unknown) => void>();
                eventHandlers.add(handler);
                handlers.set(eventName, eventHandlers);
                return () => {
                    eventHandlers.delete(handler);
                    if (eventHandlers.size === 0) {
                        handlers.delete(eventName);
                    }
                };
            },
        },
    };
}

describe('usePeerMediationObservabilityStore', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('subscribes to the real PMS observability socket contract and materializes snapshot/delta state', async () => {
        const harness = createTransportHarness();
        const enabledFeatures = featuresResponse(true, true);
        const { usePeerMediationObservabilityStore } = await import('./usePeerMediationObservabilityStore');

        const hook = await renderHook(() => usePeerMediationObservabilityStore({
            scope: machineScope,
            source: 'server',
            serverFeatures: enabledFeatures,
            transport: harness.transport,
        }));

        expect(harness.emitted).toEqual([{
            eventName: PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
            payload: { scope: machineScope },
        }]);

        await act(async () => {
            harness.emitIncoming(PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT, {
                v: 1,
                scope: machineScope,
                sequence: 1,
                capturedAtMs: 1_000,
                flows: [{
                    flow: {
                        flowId: 'flow_1',
                        flowKind: 'tcp_tunnel',
                        routeKind: 'server_relay',
                        tunnelId: 'tunnel_1',
                        productRef: { kind: 'preview', id: 'preview_1', redacted: false },
                    },
                    lifecycleState: 'active',
                    startedAtMs: 900,
                    lastActivityAtMs: 1_000,
                    bytesIn: 10,
                    bytesOut: 20,
                    framesIn: 0,
                    framesOut: 0,
                    messagesIn: 0,
                    messagesOut: 0,
                    activeSubstreams: 1,
                }],
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(selectPeerMediationObservabilityFlowSummaries(hook.getCurrent(), machineScope)).toEqual([
            expect.objectContaining({ flowId: 'flow_1', bytesIn: 10, bytesOut: 20 }),
        ]);

        await act(async () => {
            harness.emitIncoming(PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT, {
                v: 1,
                scope: machineScope,
                sequence: 2,
                events: [{
                    v: 1,
                    eventId: 'event_2',
                    sequence: 2,
                    emittedAtMs: 1_100,
                    scope: machineScope,
                    flow: {
                        flowId: 'flow_1',
                        flowKind: 'tcp_tunnel',
                        routeKind: 'server_relay',
                        tunnelId: 'tunnel_1',
                        productRef: { kind: 'preview', id: 'preview_1', redacted: false },
                    },
                    kind: 'tunnel.bytes',
                    data: { bytesIn: 30, bytesOut: 40, activeSubstreams: 2 },
                    redaction: {
                        level: 'metadataOnly',
                        queryRedacted: true,
                        headersRedacted: true,
                        truncated: false,
                    },
                }],
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(selectPeerMediationObservabilityFlowSummaries(hook.getCurrent(), machineScope)).toEqual([
            expect.objectContaining({ flowId: 'flow_1', bytesIn: 30, bytesOut: 40, activeSubstreams: 2 }),
        ]);

        await hook.unmount();

        expect(harness.emitted.at(-1)).toEqual({
            eventName: PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
            payload: { scope: machineScope },
        });
    });

    it('materializes an unavailable scope without subscribing when the feature is unavailable', async () => {
        const harness = createTransportHarness();
        const unavailableFeatures = featuresResponse(false, true);
        const { usePeerMediationObservabilityStore } = await import('./usePeerMediationObservabilityStore');

        const hook = await renderHook(() => usePeerMediationObservabilityStore({
            scope: machineScope,
            source: 'server',
            serverFeatures: unavailableFeatures,
            transport: harness.transport,
        }));

        expect(harness.emitted).toEqual([]);
        expect(selectPeerMediationObservabilityScopeState(hook.getCurrent(), machineScope)).toMatchObject({
            status: 'unavailable',
            unavailableReasonCode: 'observability_unavailable',
        });
    });
});
