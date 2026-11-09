import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrohError } from '@happier-dev/iroh-native';

const acquireBrowserSpy = vi.hoisted(() => vi.fn());
const acquireNativeSpy = vi.hoisted(() => vi.fn());

// Only the carrier acquisition (worker/wasm) is a boundary here; the real
// eligibility decision and the real host decision run beneath it.
vi.mock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier')>()),
    acquireBrowserIrohHomeCarrier: (input: unknown) => acquireBrowserSpy(input),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock();
});

import {
    acquireEligibleHomeCarrier,
    drainRetainedHomeCarrierReleases,
} from './homeCarrierPolicy';
import { createIrohHomeTunnelSupervisor } from './nativeIrohTunnels/supervisor';
import type { IrohHomeTunnelAcquireInput } from './nativeIrohTunnels/types';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from './connectivity/serverReachabilitySupervisorPool';

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';
const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    + ' Chrome/150.0.0.0 Safari/537.36';

/** Describes the host through the same boundary globals the real host decision reads. */
function setHost(kind: 'browser' | 'desktop' | 'no_shared_worker'): void {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: BROWSER_USER_AGENT } });
    if (kind === 'no_shared_worker') {
        Reflect.deleteProperty(globalThis, 'SharedWorker');
    } else {
        Object.defineProperty(globalThis, 'SharedWorker', { configurable: true, value: function SharedWorkerStub() {} });
    }
    if (kind === 'desktop') {
        (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = { invoke: () => null };
    } else {
        Reflect.deleteProperty(globalThis, TAURI_INTERNALS_KEY);
    }
}

const endpoint = { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/'] };
const baseInput = {
    acquireNative: (input: IrohHomeTunnelAcquireInput) => acquireNativeSpy(input),
    applicationCarrierEligibility: 'automatic' as const,
    descriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_a',
        canonicalServerUrl: 'https://canonical.example.test',
        revision: 7,
        endpoints: [
            { kind: 'iroh' as const, ...endpoint },
            { kind: 'https' as const, url: 'https://public.example.test' },
        ],
    },
    verification: { kind: 'authenticated' as const, token: 'home-token' },
};

/** A declared origin at the fetch boundary: public identity plus readiness, recording every credential. */
function serveHome(options: Readonly<{ identity?: string; readinessStatus?: number }> = {}): Array<{ url: string; authorization: string | null }> {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    setRuntimeFetch(async (input, init) => {
        const url = String(input);
        requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
        return url.endsWith('/v1/features')
            ? new Response(JSON.stringify({
                features: {},
                capabilities: { serverIdentity: { serverIdentityId: options.identity ?? baseInput.descriptor.homeServerIdentityId } },
            }), { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response('{}', { status: options.readinessStatus ?? 200, headers: { 'content-type': 'application/json' } });
    });
    return requests;
}

describe('acquireEligibleHomeCarrier', () => {
    beforeEach(() => {
        acquireBrowserSpy.mockReset();
        acquireNativeSpy.mockReset();
        setHost('browser');
        setRuntimeFetch(async () => new Response('{}', { status: 503 }));
    });

    afterEach(async () => {
        await resetServerReachabilitySupervisors();
        resetRuntimeFetch();
        Reflect.deleteProperty(globalThis, TAURI_INTERNALS_KEY);
        Reflect.deleteProperty(globalThis, 'navigator');
        Reflect.deleteProperty(globalThis, 'SharedWorker');
    });

    it('prefers verified declared HTTPS in browsers without acquiring the relay carrier', async () => {
        acquireBrowserSpy.mockResolvedValue({
            leaseId: 'working-browser-relay', homeServerIdentityId: baseInput.descriptor.homeServerIdentityId,
            endpointId: endpoint.endpointId, release: async () => {},
        });
        const requests = serveHome();

        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toEqual({
            kind: 'https', runtimeOrigin: 'https://public.example.test',
        });
        expect(requests).toEqual([
            { url: 'https://public.example.test/v1/features', authorization: null },
            { url: 'https://public.example.test/v1/auth/ping', authorization: 'Bearer home-token' },
        ]);
        expect(acquireBrowserSpy).not.toHaveBeenCalled();
        expect(acquireNativeSpy).not.toHaveBeenCalled();
    });

    it.each(['auth', 'identity'])('stops browser selection on a declared HTTPS %s refusal', async (refusal) => {
        const requests = serveHome(refusal === 'auth' ? { readinessStatus: 401 } : { identity: 'wrong-home' });

        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toMatchObject({ kind: 'fail_closed', fallbackAllowed: false });
        if (refusal === 'identity') expect(requests.every((request) => request.authorization === null)).toBe(true);
        expect(acquireBrowserSpy).not.toHaveBeenCalled();
        expect(acquireNativeSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['after a relay outage', () => acquireNativeSpy.mockRejectedValue(new IrohError('home_unreachable', 'relay unavailable'))],
        ['after a degraded lease', () => acquireNativeSpy.mockResolvedValue({
            leaseId: 'degraded', homeServerIdentityId: baseInput.descriptor.homeServerIdentityId, endpointId: endpoint.endpointId,
            runtimeOrigin: 'http://127.0.0.1:43123', status: 'degraded', release: async () => {},
        })],
    ])('publishes native HTTPS %s only for the same Home, and sends a wrong Home no credential', async (_name, arrange) => {
        setHost('desktop');
        arrange();

        serveHome();
        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toEqual({
            kind: 'https', runtimeOrigin: 'https://public.example.test',
        });

        const wrongHome = serveHome({ identity: 'wrong-home' });
        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toMatchObject({ kind: 'fail_closed', fallbackAllowed: false });
        expect(wrongHome.map((request) => request.authorization)).toEqual([null]);
    });

    it('settles unavailable when the declared HTTPS origin cannot prove its Home after a native outage', async () => {
        setHost('desktop');
        acquireNativeSpy.mockRejectedValue(new IrohError('unavailable', 'relay unavailable'));

        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it('proves the Home once when Standard only reaches declared HTTPS without the browser preference', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const store = getStorage();
        const previous = store.getState().localSettings;
        store.setState({ localSettings: { ...previous, homeApplicationCarrierEligibility: 'standard_only' } });
        try {
            const sameHome = serveHome();
            await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toEqual({
                kind: 'https', runtimeOrigin: 'https://public.example.test',
            });
            expect(sameHome.filter((request) => request.url.endsWith('/v1/features'))).toHaveLength(1);

            serveHome({ identity: 'wrong-home' });
            await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toMatchObject({ kind: 'fail_closed', fallbackAllowed: false });
            expect(acquireBrowserSpy).not.toHaveBeenCalled();
            expect(acquireNativeSpy).not.toHaveBeenCalled();
        } finally {
            store.setState({ localSettings: previous });
        }
    });

    it('verifies the browser preference once rather than twice', async () => {
        const requests = serveHome();

        await acquireEligibleHomeCarrier(baseInput);
        expect(requests.filter((request) => request.url.endsWith('/v1/features'))).toHaveLength(1);
    });

    it('leaves a Standard Home with no Iroh endpoint unprobed', async () => {
        const requests = serveHome();

        await expect(acquireEligibleHomeCarrier({
            ...baseInput,
            descriptor: { ...baseInput.descriptor, endpoints: [{ kind: 'https', url: 'https://public.example.test' }] },
        })).resolves.toEqual({ kind: 'https', runtimeOrigin: 'https://public.example.test' });
        expect(requests).toEqual([]);
    });

    it('returns only the acquired browser carrier when the browser carrier is eligible', async () => {
        const release = vi.fn(async () => {});
        const carrier = {
            leaseId: 'browser-lease',
            homeServerIdentityId: baseInput.descriptor.homeServerIdentityId,
            endpointId: endpoint.endpointId,
            release,
        };
        acquireBrowserSpy.mockResolvedValue(carrier);

        const acquired = await acquireEligibleHomeCarrier(baseInput);
        expect(acquired).toEqual({
            kind: 'browser_iroh',
            carrier: { ...carrier, release: expect.any(Function) },
            release: expect.any(Function),
        });
        if (acquired.kind !== 'browser_iroh') return;
        expect(acquired.carrier.release).toBe(acquired.release);
        expect(acquireNativeSpy).not.toHaveBeenCalled();
    });

    it('returns only the acquired native runtime origin when the browser host is ineligible', async () => {
        const release = vi.fn(async () => {});
        const lease = {
            leaseId: 'native-lease',
            homeServerIdentityId: baseInput.descriptor.homeServerIdentityId,
            endpointId: endpoint.endpointId,
            runtimeOrigin: 'http://127.0.0.1:43123',
            status: 'ready',
            release,
        };
        setHost('desktop');
        acquireNativeSpy.mockResolvedValue(lease);

        const acquired = await acquireEligibleHomeCarrier(baseInput);
        expect(acquired).toEqual({
            kind: 'native_iroh',
            lease: { ...lease, release: expect.any(Function) },
            release: expect.any(Function),
        });
        if (acquired.kind !== 'native_iroh') return;
        expect(acquired.lease.release).toBe(acquired.release);
        expect(acquireBrowserSpy).not.toHaveBeenCalled();
    });

    it('retries a failed native lease release on the next explicit release, then stays released', async () => {
        const release = vi.fn()
            .mockRejectedValueOnce(new Error('native release failed'))
            .mockResolvedValueOnce(undefined);
        setHost('desktop');
        acquireNativeSpy.mockResolvedValue({
            leaseId: 'native-release-retry',
            homeServerIdentityId: baseInput.descriptor.homeServerIdentityId,
            endpointId: endpoint.endpointId,
            runtimeOrigin: 'http://127.0.0.1:43123',
            status: 'ready',
            release,
        });

        const acquired = await acquireEligibleHomeCarrier(baseInput);
        expect(acquired.kind).toBe('native_iroh');
        if (acquired.kind !== 'native_iroh') return;
        await expect(acquired.release()).rejects.toThrow('native release failed');
        await expect(acquired.release()).resolves.toBeUndefined();
        await expect(acquired.release()).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledTimes(2);
    });

    it('fails closed and releases a browser carrier whose returned endpoint differs from the requested endpoint', async () => {
        const release = vi.fn(async () => {});
        acquireBrowserSpy.mockResolvedValue({ leaseId: 'wrong-browser', endpointId: 'b'.repeat(64), release });

        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toMatchObject({
            kind: 'fail_closed',
            fallbackAllowed: false,
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('releases a native carrier that is not ready and uses declared HTTPS', async () => {
        const release = vi.fn(async () => {});
        setHost('desktop');
        serveHome();
        acquireNativeSpy.mockResolvedValue({
            leaseId: 'not-ready-native',
            homeServerIdentityId: baseInput.descriptor.homeServerIdentityId,
            endpointId: endpoint.endpointId,
            runtimeOrigin: 'http://127.0.0.1:43123',
            status: 'degraded',
            release,
        });

        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toEqual({
            kind: 'https', runtimeOrigin: 'https://public.example.test',
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('returns independently trusted HTTPS only for an allowed Iroh fallback', async () => {
        setHost('desktop');
        serveHome();
        acquireNativeSpy.mockRejectedValue(new IrohError('unavailable', 'native unavailable'));

        await expect(acquireEligibleHomeCarrier({
            ...baseInput,
            descriptor: {
                ...baseInput.descriptor,
                endpoints: [
                    { kind: 'iroh', ...endpoint },
                    { kind: 'https', url: 'HTTPS://Public.Example.test:443/api///?ignored=yes#fragment' },
                ],
            },
        })).resolves.toEqual({
            kind: 'https',
            runtimeOrigin: 'https://public.example.test/api',
        });
    });

    it('uses declared HTTPS after the native supervisor starts a tunnel whose health probe fails', async () => {
        setHost('desktop');
        serveHome();
        const releaseHomeTunnel = vi.fn(async () => undefined);
        const supervisor = createIrohHomeTunnelSupervisor({
            native: {
                ensureHomeTunnel: vi.fn(async (request: { homeServerIdentityId: string; endpointId: string }) => ({
                    leaseId: 'native-started-before-health-failure',
                    homeServerIdentityId: request.homeServerIdentityId,
                    homeEndpointId: request.endpointId,
                    runtimeOrigin: 'http://127.0.0.1:43124',
                    carrier: 'iroh' as const,
                    observedPath: 'direct' as const,
                    startedAtMs: 1,
                })),
                releaseHomeTunnel,
            },
            probe: async () => ({ ok: false, reason: 'health-unavailable' }),
        });

        const result = await acquireEligibleHomeCarrier({
            ...baseInput,
            acquireNative: async (input) => {
                const lease = await supervisor.ensureTunnel({
                    remoteHostId: input.homeServerIdentityId,
                    purpose: 'home',
                    homeServerIdentityId: input.homeServerIdentityId,
                    endpointId: input.endpoint.endpointId,
                    canonicalServerUrl: input.canonicalServerUrl,
                    policy: input.policy ?? 'automatic',
                    ...(input.endpoint.relayUrls ? { relayUrls: input.endpoint.relayUrls } : {}),
                    ...(input.endpoint.directAddresses ? { directAddresses: input.endpoint.directAddresses } : {}),
                    verification: input.verification,
                });
                if (!lease.localUrl) throw new Error('test supervisor returned no local origin');
                return {
                    ...lease,
                    runtimeOrigin: lease.localUrl,
                    release: async () => await supervisor.releaseTunnel(lease.leaseId),
                };
            },
        });

        expect(result).toEqual({ kind: 'https', runtimeOrigin: 'https://public.example.test' });
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
        expect(releaseHomeTunnel).toHaveBeenCalledWith('native-started-before-health-failure');
        expect(supervisor.listTunnels().leases).toEqual([]);
    });

    it('does not let unavailable cleanup mask a post-acquisition health failure', async () => {
        setHost('desktop');
        serveHome();
        const releaseHomeTunnel = vi.fn()
            .mockRejectedValueOnce(new IrohError('unavailable', 'desktop stop command unavailable'))
            .mockResolvedValueOnce(undefined);
        const supervisor = createIrohHomeTunnelSupervisor({
            native: {
                ensureHomeTunnel: vi.fn(async (request: { homeServerIdentityId: string; endpointId: string }) => ({
                    leaseId: 'native-started-before-cleanup-failure',
                    homeServerIdentityId: request.homeServerIdentityId,
                    homeEndpointId: request.endpointId,
                    runtimeOrigin: 'http://127.0.0.1:43125',
                    carrier: 'iroh' as const,
                    observedPath: 'direct' as const,
                    startedAtMs: 1,
                })),
                releaseHomeTunnel,
            },
            probe: async () => ({ ok: false, reason: 'health-unavailable' }),
        });

        const result = await acquireEligibleHomeCarrier({
            ...baseInput,
            acquireNative: async (input) => {
                const lease = await supervisor.ensureTunnel({
                    remoteHostId: input.homeServerIdentityId,
                    purpose: 'home',
                    homeServerIdentityId: input.homeServerIdentityId,
                    endpointId: input.endpoint.endpointId,
                    canonicalServerUrl: input.canonicalServerUrl,
                    policy: input.policy ?? 'automatic',
                    ...(input.endpoint.relayUrls ? { relayUrls: input.endpoint.relayUrls } : {}),
                    ...(input.endpoint.directAddresses ? { directAddresses: input.endpoint.directAddresses } : {}),
                    verification: input.verification,
                });
                if (!lease.localUrl) throw new Error('test supervisor returned no local origin');
                return {
                    ...lease,
                    runtimeOrigin: lease.localUrl,
                    release: async () => await supervisor.releaseTunnel(lease.leaseId),
                };
            },
        });

        expect(result).toEqual({ kind: 'https', runtimeOrigin: 'https://public.example.test' });
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
        expect(supervisor.listTunnels().leases).toEqual([
            expect.objectContaining({ status: 'failed' }),
        ]);
        await supervisor.dispose();
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(2);
    });

    it('treats missing browser carrier capability as unavailable without attempting the native carrier', async () => {
        setHost('no_shared_worker');
        setRuntimeFetch(async (input) => new Response(JSON.stringify(String(input).endsWith('/v1/features')
            ? { features: {}, capabilities: { serverIdentity: { serverIdentityId: baseInput.descriptor.homeServerIdentityId } } }
            : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toEqual({
            kind: 'https',
            runtimeOrigin: 'https://public.example.test',
        });
        expect(acquireBrowserSpy).not.toHaveBeenCalled();
        expect(acquireNativeSpy).not.toHaveBeenCalled();
    });

    it('treats an eligible browser host without relay reachability as unavailable without attempting either carrier', async () => {

        const result = await acquireEligibleHomeCarrier({
            ...baseInput,
            descriptor: {
                ...baseInput.descriptor,
                endpoints: [{ kind: 'iroh', ...endpoint, relayUrls: [] }],
            },
        });

        expect(result).toMatchObject({
            kind: 'unavailable',
            error: { name: 'IrohError', code: 'unavailable' },
        });
        expect(acquireBrowserSpy).not.toHaveBeenCalled();
        expect(acquireNativeSpy).not.toHaveBeenCalled();
    });

    it('fails typed when the browser carrier is unsupported and no trusted HTTPS origin exists', async () => {
        setHost('no_shared_worker');

        const result = await acquireEligibleHomeCarrier({
            ...baseInput,
            descriptor: {
                ...baseInput.descriptor,
                endpoints: [{ kind: 'iroh', ...endpoint }],
            },
        });

        expect(result).toMatchObject({
            kind: 'unavailable',
            error: { name: 'IrohError', code: 'unavailable' },
        });
        expect(acquireBrowserSpy).not.toHaveBeenCalled();
        expect(acquireNativeSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['credential', { verification: { kind: 'authenticated' as const, token: '' } }],
        ['identity', { descriptor: { ...baseInput.descriptor, homeServerIdentityId: '' } }],
        ['endpoint', {
            descriptor: {
                ...baseInput.descriptor,
                endpoints: [{ kind: 'iroh' as const, ...endpoint, endpointId: '' }],
            },
        }],
    ])('keeps a missing browser %s fail-closed', async (_name, override) => {
        const result = await acquireEligibleHomeCarrier({ ...baseInput, ...override });

        expect(result).toMatchObject({ kind: 'fail_closed', fallbackAllowed: false });
        expect(acquireBrowserSpy).not.toHaveBeenCalled();
        expect(acquireNativeSpy).not.toHaveBeenCalled();
    });

    it('returns fail-closed for identity failure even when HTTPS is independently trusted', async () => {
        const error = new IrohError('identity_mismatch', 'wrong endpoint');
        setHost('desktop');
        acquireNativeSpy.mockRejectedValue(error);

        await expect(acquireEligibleHomeCarrier(baseInput)).resolves.toEqual({
            kind: 'fail_closed',
            error,
            fallbackAllowed: false,
        });
    });

    it('settles unavailable when an allowed fallback has no trusted HTTPS destination', async () => {
        const error = new IrohError('unavailable', 'native unavailable');
        setHost('desktop');
        acquireNativeSpy.mockRejectedValue(error);

        await expect(acquireEligibleHomeCarrier({
            ...baseInput,
            descriptor: {
                ...baseInput.descriptor,
                endpoints: [
                    { kind: 'iroh', ...endpoint },
                    { kind: 'https', url: 'http://not-independent.example.test' },
                ],
            },
        })).resolves.toEqual({
            kind: 'unavailable',
            error,
        });
    });
});
