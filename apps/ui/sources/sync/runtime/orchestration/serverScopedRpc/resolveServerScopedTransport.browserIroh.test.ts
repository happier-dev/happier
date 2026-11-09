import { afterEach, describe, expect, it, vi } from 'vitest';

import { IrohError } from '@happier-dev/iroh-native';

const acquireBrowserCarrierSpy = vi.fn();
const acquireNativeOriginSpy = vi.fn();

const FIRST_ENDPOINT_ID = 'a'.repeat(64);
const SECOND_ENDPOINT_ID = 'b'.repeat(64);

function carrierFor(leaseId: string, homeServerIdentityId: string, endpointId: string) {
    return {
        leaseId,
        homeServerIdentityId,
        endpointId,
        appliedRelayUrls: ['https://relay.happier.test/'],
        readObservedPath: () => 'relay' as const,
        request: async () => new Response(null, { status: 200 }),
        createWebSocket: () => ({}),
        release: vi.fn(async () => {}),
    };
}

function homeDescriptor(
    identity: string,
    canonicalServerUrl: string,
    endpointId: string,
    options: Readonly<{ relayUrls?: readonly string[]; httpsUrl?: string }> = {},
) {
    return {
        v: 1 as const,
        homeServerIdentityId: identity,
        canonicalServerUrl,
        revision: 1,
        endpoints: [
            {
                kind: 'iroh' as const,
                endpointId,
                ...(options.relayUrls ? { relayUrls: [...options.relayUrls] } : {}),
            },
            ...(options.httpsUrl ? [{ kind: 'https' as const, url: options.httpsUrl }] : []),
        ],
    };
}

function mockHost(browserHost: boolean): void {
    vi.doMock('@/sync/runtime/browserIroh/hostEligibility', () => ({
        resolveBrowserIrohHostDecision: () => (
            browserHost ? { eligible: true } : { eligible: false, reason: 'desktop_host' }
        ),
    }));
    vi.doMock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier', async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier')
        >();
        return { ...actual, acquireBrowserIrohHomeCarrier: acquireBrowserCarrierSpy };
    });
    vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/runtime/nativeIrohTunnels/runtime')>();
        return { ...actual, acquireIrohHomeRuntimeOrigin: acquireNativeOriginSpy };
    });
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    acquireBrowserCarrierSpy.mockReset();
    acquireNativeOriginSpy.mockReset();
});

describe('resolveServerScopedTransport on a browser host', () => {
    it('resolves a cold secondary Home to its own carrier and canonical URL, with no runtime origin', async () => {
        vi.resetModules();
        mockHost(true);
        acquireBrowserCarrierSpy
            .mockResolvedValueOnce(carrierFor('lease-1', 'srv_first', FIRST_ENDPOINT_ID))
            .mockResolvedValueOnce(carrierFor('lease-2', 'srv_second', SECOND_ENDPOINT_ID));

        const { resolveServerScopedTransport } = await import('./resolveServerScopedTransport');
        const first = await resolveServerScopedTransport({
            profile: {
                serverUrl: 'https://first.example.test',
                homeConnectionDescriptor: homeDescriptor(
                    'srv_first',
                    'https://first.example.test',
                    FIRST_ENDPOINT_ID,
                    { relayUrls: ['https://relay.happier.test/'] },
                ),
            },
            credentials: { token: 'first-token' },
        });
        const second = await resolveServerScopedTransport({
            profile: {
                serverUrl: 'https://second.example.test',
                homeConnectionDescriptor: homeDescriptor(
                    'srv_second',
                    'https://second.example.test',
                    SECOND_ENDPOINT_ID,
                    { relayUrls: ['https://relay.happier.test/'] },
                ),
            },
            credentials: { token: 'second-token' },
        });

        expect(acquireNativeOriginSpy).not.toHaveBeenCalled();
        expect(first.carrier).toBe('iroh');
        expect(first.homeCarrier?.endpointId).toBe(FIRST_ENDPOINT_ID);
        expect(second.homeCarrier?.endpointId).toBe(SECOND_ENDPOINT_ID);
        // Each Home keeps its own canonical identity; no loopback origin exists
        // for either, so the request base stays the canonical URL.
        expect(first.runtimeOrigin).toBe('https://first.example.test');
        expect(second.runtimeOrigin).toBe('https://second.example.test');
    });

    it('falls back to an independent HTTPS ingress when the browser carrier is unavailable', async () => {
        vi.resetModules();
        mockHost(true);
        acquireBrowserCarrierSpy.mockRejectedValue(new IrohError('unavailable', 'worker unavailable'));
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input) => new Response(JSON.stringify(String(input).endsWith('/v1/features')
            ? { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_first' } } }
            : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

        const { resolveServerScopedTransport } = await import('./resolveServerScopedTransport');
        const resolved = await resolveServerScopedTransport({
            profile: {
                serverUrl: 'https://first.example.test',
                homeConnectionDescriptor: homeDescriptor(
                    'srv_first',
                    'https://first.example.test',
                    FIRST_ENDPOINT_ID,
                    {
                        relayUrls: ['https://relay.happier.test/'],
                        httpsUrl: 'https://public.example.test',
                    },
                ),
            },
            credentials: { token: 'first-token' },
        });

        expect(resolved.carrier).toBe('https');
        expect(resolved.runtimeOrigin).toBe('https://public.example.test');
        expect(resolved.homeCarrier).toBeUndefined();
    });

    it('returns the typed unavailable result for an ingress-less Home with no relays', async () => {
        vi.resetModules();
        mockHost(true);

        const { resolveServerScopedTransport, ServerScopedTransportUnavailableError } =
            await import('./resolveServerScopedTransport');

        await expect(resolveServerScopedTransport({
            profile: {
                serverUrl: 'https://first.example.test',
                // A browser has no direct transport, so an endpoint published
                // without relays is unreachable from here.
                homeConnectionDescriptor: homeDescriptor(
                    'srv_first',
                    'https://first.example.test',
                    FIRST_ENDPOINT_ID,
                ),
            },
            credentials: { token: 'first-token' },
        })).rejects.toBeInstanceOf(ServerScopedTransportUnavailableError);
        expect(acquireBrowserCarrierSpy).not.toHaveBeenCalled();
        expect(acquireNativeOriginSpy).not.toHaveBeenCalled();
    });

    it('leaves a desktop or native host on the native loopback lease', async () => {
        vi.resetModules();
        mockHost(false);
        acquireNativeOriginSpy.mockResolvedValue({
            leaseId: 'native-lease-1',
            localUrl: 'http://127.0.0.1:46101',
            runtimeOrigin: 'http://127.0.0.1:46101',
            homeServerIdentityId: 'srv_first',
            endpointId: FIRST_ENDPOINT_ID,
            carrier: 'iroh',
            observedPath: 'direct',
            status: 'ready',
            release: vi.fn(async () => {}),
        });

        const { resolveServerScopedTransport } = await import('./resolveServerScopedTransport');
        const resolved = await resolveServerScopedTransport({
            profile: {
                serverUrl: 'https://first.example.test',
                homeConnectionDescriptor: homeDescriptor(
                    'srv_first',
                    'https://first.example.test',
                    FIRST_ENDPOINT_ID,
                    { relayUrls: ['https://relay.happier.test/'] },
                ),
            },
            credentials: { token: 'first-token' },
        });

        expect(acquireBrowserCarrierSpy).not.toHaveBeenCalled();
        expect(resolved.runtimeOrigin).toBe('http://127.0.0.1:46101');
        expect(resolved.homeCarrier).toBeUndefined();
    });

    it('keeps release retry custody after a rejection: coalesces concurrent callers, propagates the first rejection, retries once on the next explicit call, then idles', async () => {
        vi.resetModules();
        mockHost(true);
        const release = vi.fn(async () => {}).mockRejectedValueOnce(new Error('release failed'));
        acquireBrowserCarrierSpy.mockResolvedValueOnce({
            ...carrierFor('lease-1', 'srv_first', FIRST_ENDPOINT_ID),
            release,
        });

        const { resolveServerScopedTransport } = await import('./resolveServerScopedTransport');
        const resolved = await resolveServerScopedTransport({
            profile: {
                serverUrl: 'https://first.example.test',
                homeConnectionDescriptor: homeDescriptor(
                    'srv_first',
                    'https://first.example.test',
                    FIRST_ENDPOINT_ID,
                    { relayUrls: ['https://relay.happier.test/'] },
                ),
            },
            credentials: { token: 'first-token' },
        });

        // Concurrent callers coalesce one in-flight underlying release and both
        // observe its rejection instead of the second caller resolving early.
        const settled = await Promise.allSettled([resolved.release(), resolved.release()]);
        expect(settled).toEqual([
            { status: 'rejected', reason: expect.objectContaining({ message: 'release failed' }) },
            { status: 'rejected', reason: expect.objectContaining({ message: 'release failed' }) },
        ]);
        expect(release).toHaveBeenCalledTimes(1);

        // The next explicit call retries the underlying release exactly once.
        await expect(resolved.release()).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledTimes(2);

        // After a success, later calls are idempotent.
        await expect(resolved.release()).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledTimes(2);
    });
});
