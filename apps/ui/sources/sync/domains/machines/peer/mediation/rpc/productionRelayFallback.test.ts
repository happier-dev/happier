import { describe, expect, it } from 'vitest';
import {
    FeaturesResponseSchema,
    RPC_METHODS,
    resolveMachineRpcRoutePolicy,
    type FeaturesResponse,
} from '@happier-dev/protocol';

import { resolveProductionMachineRpcRelayFallback } from './productionRelayFallback';

const relayCaps = {
    maxBitrateBps: 64_000,
    maxFramesPerSecond: 50,
    maxFrameBytes: 16_000,
    maxDurationMs: 60_000,
    maxTotalBytes: 1_000_000,
    maxConcurrentStreamsPerAccount: 2,
    maxConcurrentStreamsPerSocket: 1,
    maxConcurrentStreamsPerMachine: 1,
};

function createFeatures(input: Readonly<{
    serverRoutedEnabled: boolean;
    caps?: unknown;
}>) {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                liveStream: {
                    enabled: true,
                    serverRouted: { enabled: input.serverRoutedEnabled },
                },
            },
        },
        capabilities: {
            machines: {
                liveStream: {
                    serverRouted: {
                        caps: input.caps ?? null,
                        disabledReason: input.serverRoutedEnabled ? null : 'server_routed_live_stream_disabled',
                    },
                },
            },
        },
    });
}

function createMalformedFeatures(input: Readonly<{
    serverRoutedEnabled: boolean;
    caps: unknown;
}>): FeaturesResponse {
    return {
        features: {
            machines: {
                enabled: true,
                liveStream: {
                    enabled: true,
                    serverRouted: { enabled: input.serverRoutedEnabled },
                },
            },
        },
        capabilities: {
            machines: {
                liveStream: {
                    serverRouted: {
                        caps: input.caps,
                        disabledReason: null,
                    },
                },
            },
        },
    } as unknown as FeaturesResponse;
}

describe('resolveProductionMachineRpcRelayFallback', () => {
    it('allows heavy daemon voice relay fallback only when server-routed live-stream relay is enabled with valid caps', () => {
        const policy = resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);

        const decision = resolveProductionMachineRpcRelayFallback({
            policy,
            features: createFeatures({
                serverRoutedEnabled: true,
                caps: relayCaps,
            }),
        });

        expect(decision).toMatchObject({
            ok: true,
            routeKind: 'server_relay',
            caps: relayCaps,
        });
    });

    it('fails closed when the server-routed live-stream feature bit is disabled', () => {
        const policy = resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);

        const decision = resolveProductionMachineRpcRelayFallback({
            policy,
            features: createFeatures({
                serverRoutedEnabled: false,
                caps: relayCaps,
            }),
        });

        expect(decision).toMatchObject({
            ok: false,
            routeKind: 'server_relay',
            reasonCode: 'relay_disabled_by_policy',
        });
    });

    it('fails closed when relay caps are missing or malformed', () => {
        const policy = resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);

        expect(resolveProductionMachineRpcRelayFallback({
            policy,
            features: createFeatures({
                serverRoutedEnabled: true,
            }),
        })).toMatchObject({
            ok: false,
            reasonCode: 'relay_caps_required',
        });

        expect(resolveProductionMachineRpcRelayFallback({
            policy,
            features: createMalformedFeatures({
                serverRoutedEnabled: true,
                caps: { ...relayCaps, maxFrameBytes: -1 },
            }),
        })).toMatchObject({
            ok: false,
            reasonCode: 'relay_caps_required',
        });
    });
});
