import { describe, expect, it } from 'vitest';

import type { FeaturesResponse, MachineLiveStreamRelayCaps } from '@happier-dev/protocol';

import { resolveLiveStreamRouteDecision } from './route';

const relayCaps: MachineLiveStreamRelayCaps = {
    maxBitrateBps: 64_000,
    maxFramesPerSecond: 12,
    maxFrameBytes: 32_000,
    maxDurationMs: 60_000,
    maxTotalBytes: 128_000,
    maxConcurrentStreamsPerAccount: 2,
    maxConcurrentStreamsPerSocket: 1,
    maxConcurrentStreamsPerMachine: 1,
};

function features(input: Readonly<{
    liveStream?: boolean;
    directPeer?: boolean;
    serverRouted?: boolean;
    caps?: MachineLiveStreamRelayCaps | null;
}> = {}): FeaturesResponse {
    const liveStream = input.liveStream ?? true;
    const directPeer = input.directPeer ?? true;
    const serverRouted = input.serverRouted ?? false;
    return {
        features: {
            machines: {
                enabled: true,
                liveStream: {
                    enabled: liveStream,
                    directPeer: { enabled: directPeer },
                    serverRouted: { enabled: serverRouted },
                },
            },
        },
        capabilities: {
            machines: {
                liveStream: {
                    serverRouted: {
                        caps: input.caps ?? null,
                    },
                },
            },
        },
    } as FeaturesResponse;
}

const baseInput = {
    serverFeatures: features(),
    preferredRouteKinds: ['loopback_direct', 'server_relay'] as const,
    directRouteKind: 'loopback_direct' as const,
    directRouteViability: { status: 'viable', checkedAt: 1_000, expiresAt: 31_000 } as const,
    directGrant: { status: 'valid' as const },
    daemonPolicy: null,
    accountMachinePreference: 'enabled' as const,
    accountDefaultPreference: 'inherit' as const,
    productDefaultPreference: 'disabled' as const,
    localCaptureAvailable: true,
    remoteDisplayAvailable: true,
    relayCaps: null,
};

describe('resolveLiveStreamRouteDecision', () => {
    it('selects loopback direct only after direct gate, topology, and grant pass', () => {
        expect(resolveLiveStreamRouteDecision(baseInput)).toEqual({
            kind: 'selected',
            flowKind: 'live_stream',
            routeKind: 'loopback_direct',
            disabledReasons: [],
        });
    });

    it('does not bypass loopback viability or grant status with account preference', () => {
        expect(resolveLiveStreamRouteDecision({
            ...baseInput,
            directRouteViability: {
                status: 'unavailable',
                checkedAt: 1_000,
                expiresAt: 2_000,
                failureReason: 'endpoint_unreachable',
            },
        })).toMatchObject({
            kind: 'unavailable',
            reasonCode: 'endpoint_unavailable',
        });

        expect(resolveLiveStreamRouteDecision({
            ...baseInput,
            directGrant: { status: 'expired' },
        })).toMatchObject({
            kind: 'unavailable',
            reasonCode: 'grant_rejected',
        });
    });

    it('denies direct on unprobed topology here, not in the direct-route policy', () => {
        // Sole owner of the topology denial. `resolveEffectivePeerDirectRoutePolicy` no longer
        // models topology at all: this branch returns before the policy is consulted, so the
        // policy could never observe an unavailable topology. Deleting this case would silently
        // admit an unprobed route, which the policy will not catch.
        expect(resolveLiveStreamRouteDecision({
            ...baseInput,
            directRouteViability: { status: 'unknown' },
            preferredRouteKinds: ['loopback_direct'],
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'topology_unavailable',
            disabledReasons: ['topology_unavailable'],
        });
    });

    it('uses server relay only when server-routed gate is enabled and caps are present', () => {
        expect(resolveLiveStreamRouteDecision({
            ...baseInput,
            serverFeatures: features({ directPeer: false, serverRouted: true, caps: null }),
            accountMachinePreference: 'disabled',
            relayCaps: null,
        })).toMatchObject({
            kind: 'unavailable',
            reasonCode: 'relay_cap_missing',
        });

        expect(resolveLiveStreamRouteDecision({
            ...baseInput,
            serverFeatures: features({ directPeer: false, serverRouted: true, caps: relayCaps }),
            accountMachinePreference: 'disabled',
            relayCaps,
        })).toEqual({
            kind: 'selected',
            flowKind: 'live_stream',
            routeKind: 'server_relay',
            relayCaps,
            disabledReasons: ['server_direct_disabled'],
        });
    });

    it('projects local and remote stream support as structured disabled reasons', () => {
        expect(resolveLiveStreamRouteDecision({
            ...baseInput,
            localCaptureAvailable: false,
        })).toMatchObject({
            kind: 'unavailable',
            reasonCode: 'local_capture_unavailable',
        });

        expect(resolveLiveStreamRouteDecision({
            ...baseInput,
            remoteDisplayAvailable: false,
        })).toMatchObject({
            kind: 'unavailable',
            reasonCode: 'remote_display_unavailable',
        });
    });
});
