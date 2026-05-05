import { describe, expect, it } from 'vitest';

import type { FeaturesResponse, MachineLiveStreamRelayCaps } from '@happier-dev/protocol';

import { resolveMachineLiveStreamAvailability } from './availability';

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

const directRouteAllowed = {
    directGrant: { status: 'valid' as const },
    daemonPolicy: null,
    accountMachinePreference: 'enabled' as const,
    accountDefaultPreference: 'enabled' as const,
    productDefaultPreference: 'enabled' as const,
};

function features(input: Readonly<{
    liveStream?: boolean;
    directPeer?: boolean;
    serverRouted?: boolean;
    caps?: MachineLiveStreamRelayCaps | null;
}> = {}): FeaturesResponse {
    return {
        features: {
            machines: {
                enabled: true,
                liveStream: {
                    enabled: input.liveStream ?? true,
                    directPeer: { enabled: input.directPeer ?? true },
                    serverRouted: { enabled: input.serverRouted ?? false },
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

describe('resolveMachineLiveStreamAvailability', () => {
    it('uses server feature gates and loopback route state instead of constructing routes in UI', () => {
        expect(resolveMachineLiveStreamAvailability({
            serverFeatures: features(),
            localCaptureAvailable: true,
            remoteDisplayAvailable: true,
            loopbackRoute: {
                status: 'viable' as const,
                checkedAt: 1_000,
                expiresAt: 31_000,
            },
            relayCaps: null,
            ...directRouteAllowed,
        })).toEqual({
            status: 'available',
            routeKind: 'loopback_direct',
            disabledReasons: [],
        });
    });

    it('does not silently hide server relay when caps are missing', () => {
        expect(resolveMachineLiveStreamAvailability({
            serverFeatures: features({ directPeer: false, serverRouted: true, caps: null }),
            localCaptureAvailable: true,
            remoteDisplayAvailable: true,
            loopbackRoute: { status: 'unknown' },
            relayCaps: null,
            ...directRouteAllowed,
        })).toEqual({
            status: 'disabled',
            reasonCode: 'relay_cap_missing',
            disabledReasons: ['server_direct_disabled', 'relay_cap_missing'],
        });
    });

    it('projects explicit local and remote disabled states', () => {
        expect(resolveMachineLiveStreamAvailability({
            serverFeatures: features({ serverRouted: true, caps: relayCaps }),
            localCaptureAvailable: false,
            remoteDisplayAvailable: true,
            loopbackRoute: { status: 'unknown' },
            relayCaps,
            ...directRouteAllowed,
        })).toMatchObject({
            status: 'disabled',
            reasonCode: 'local_capture_unavailable',
        });

        expect(resolveMachineLiveStreamAvailability({
            serverFeatures: features({ serverRouted: true, caps: relayCaps }),
            localCaptureAvailable: true,
            remoteDisplayAvailable: false,
            loopbackRoute: { status: 'unknown' },
            relayCaps,
            ...directRouteAllowed,
        })).toMatchObject({
            status: 'disabled',
            reasonCode: 'remote_display_unavailable',
        });
    });

    it('honors canonical direct route daemon policy denials', () => {
        const input = {
            serverFeatures: features(),
            localCaptureAvailable: true,
            remoteDisplayAvailable: true,
            loopbackRoute: {
                status: 'viable' as const,
                checkedAt: 1_000,
                expiresAt: 31_000,
            },
            relayCaps: null,
            directGrant: { status: 'valid' as const },
            daemonPolicy: false,
            accountMachinePreference: 'enabled' as const,
            accountDefaultPreference: 'enabled' as const,
            productDefaultPreference: 'enabled' as const,
        };

        expect(resolveMachineLiveStreamAvailability(input)).toEqual({
            status: 'disabled',
            reasonCode: 'daemon_policy_disabled',
            disabledReasons: ['daemon_policy_disabled', 'server_relay_disabled'],
        });
    });

    it('honors canonical direct route grant denials', () => {
        const input = {
            serverFeatures: features(),
            localCaptureAvailable: true,
            remoteDisplayAvailable: true,
            loopbackRoute: {
                status: 'viable' as const,
                checkedAt: 1_000,
                expiresAt: 31_000,
            },
            relayCaps: null,
            directGrant: { status: 'expired' as const },
            daemonPolicy: null,
            accountMachinePreference: 'enabled' as const,
            accountDefaultPreference: 'enabled' as const,
            productDefaultPreference: 'enabled' as const,
        };

        expect(resolveMachineLiveStreamAvailability(input)).toEqual({
            status: 'disabled',
            reasonCode: 'grant_rejected',
            disabledReasons: ['grant_rejected', 'server_relay_disabled'],
        });
    });

    it('honors canonical direct route account preference denials', () => {
        const input = {
            serverFeatures: features(),
            localCaptureAvailable: true,
            remoteDisplayAvailable: true,
            loopbackRoute: {
                status: 'viable' as const,
                checkedAt: 1_000,
                expiresAt: 31_000,
            },
            relayCaps: null,
            directGrant: { status: 'valid' as const },
            daemonPolicy: null,
            accountMachinePreference: 'disabled' as const,
            accountDefaultPreference: 'enabled' as const,
            productDefaultPreference: 'enabled' as const,
        };

        expect(resolveMachineLiveStreamAvailability(input)).toEqual({
            status: 'disabled',
            reasonCode: 'account_preference_disabled',
            disabledReasons: ['account_preference_disabled', 'server_relay_disabled'],
        });
    });
});
