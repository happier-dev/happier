import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    type MachineLiveStreamRelayAuthorizationV1,
} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';

import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { deleteServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { startProductionMachineLiveStream } from './productionRoute';

await initializeRealAppRuntimeForTests();

afterEach(() => {
    vi.useRealTimers();
    resetServerFeaturesClientForTests();
});

const features = FeaturesResponseSchema.parse({
    features: {
        machines: { enabled: true, liveStream: {
            enabled: true, serverRouted: { enabled: true },
        } },
    },
    capabilities: {},
});

const relayAuthorization: MachineLiveStreamRelayAuthorizationV1 = {
    payload: {
        v: 1, grantId: 'relay_grant_stream_1', accountId: 'account_1',
        sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
        flowKind: 'live_stream', routeKind: 'server_relay', streamId: 'stream_1', streamFamily: 'screen',
        maxBitrateBps: 64_000, maxFramesPerSecond: 12, maxFrameBytes: 32_000,
        maxDurationMs: 60_000, maxTotalBytes: 128_000, iat: 1_000, exp: 61_000,
        aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    },
    signature: { keyId: 'relay_key_1', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
};

async function withHeldFeatureResponse(run: (peer: {
    start: (options?: { timeoutMs?: number; signal?: AbortSignal }) => ReturnType<typeof startProductionMachineLiveStream>;
    requested: Promise<void>;
    release: () => void;
    requests: () => Readonly<{ features: number; grants: number }>;
}) => Promise<void>) {
    let hold = false;
    let featureRequests = 0;
    let grantRequests = 0;
    let acknowledgeRequest!: () => void;
    const requested = new Promise<void>(resolve => { acknowledgeRequest = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const fixture = await serveAccountHomes({
        homes: [{ key: 'home', serverUrl: 'https://stream-feature-lifetime.example.test', accountId: 'account_1' }],
        route: async request => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') {
                if (hold && request.path === '/v1/features') {
                    featureRequests += 1;
                    acknowledgeRequest();
                    // The network is the only held boundary; feature caching, cancellation,
                    // credentials, availability and relay admission all run for real.
                    await held;
                }
                return Response.json(features);
            }
            if (request.path === '/v1/machines/peer/mediation/route-grants') {
                grantRequests += 1;
                return Response.json({ ok: true, relayAuthorization });
            }
            return undefined;
        },
    });
    try {
        deleteServerFeaturesSnapshot({ serverId: fixture.homes.home!.id });
        hold = true;
        await run({
            start: options => startProductionMachineLiveStream({
                serverId: fixture.homes.home!.id,
                sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
                routeKind: 'server_relay', streamId: 'stream_1', streamFamily: 'screen', caps: {},
                ...options,
            }),
            requested, release,
            requests: () => ({ features: featureRequests, grants: grantRequests }),
        });
    } finally {
        release();
        vi.useRealTimers();
        await fixture.dispose();
    }
}

describe('production stream feature request lifetime', () => {
    it.each([undefined, 10_000])('starts after a six-second feature response with caller timeout %s', async timeoutMs => {
        await withHeldFeatureResponse(async peer => {
            vi.useFakeTimers();
            let settled = false;
            const result = peer.start({ timeoutMs }).finally(() => { settled = true; });
            await peer.requested;
            await vi.advanceTimersByTimeAsync(6_000);
            expect(settled).toBe(false);
            expect(peer.requests()).toEqual({ features: 1, grants: 0 });
            vi.useRealTimers();
            peer.release();
            await expect(result).resolves.toMatchObject({ ok: true, routeKind: 'server_relay', startRequest: { streamId: 'stream_1' } });
            expect(peer.requests()).toEqual({ features: 1, grants: 1 });
        });
    });

    it('stops feature admission at the explicit caller deadline without minting a grant', async () => {
        await withHeldFeatureResponse(async peer => {
            vi.useFakeTimers();
            let settled = false;
            const result = peer.start({ timeoutMs: 4_000 }).finally(() => { settled = true; });
            await peer.requested;
            await vi.advanceTimersByTimeAsync(3_999);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(result).resolves.toEqual({ ok: false, reasonCode: 'server_features_unavailable' });
            expect(peer.requests().grants).toBe(0);
        });
    });

    it('settles caller cancellation while the feature response remains pending', async () => {
        await withHeldFeatureResponse(async peer => {
            const controller = new AbortController();
            const result = peer.start({ signal: controller.signal });
            await peer.requested;
            controller.abort();
            await expect(result).resolves.toEqual({ ok: false, reasonCode: 'server_features_unavailable' });
            expect(peer.requests()).toEqual({ features: 1, grants: 0 });
        });
    });
});
