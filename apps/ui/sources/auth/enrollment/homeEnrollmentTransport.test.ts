import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveHomeEnrollmentTransport } from './homeEnrollmentTransport';

import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { Platform } from 'react-native';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { disposeIrohHomeTunnelRuntime, getIrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/runtime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installBrowserIrohSharedWorkerBoundary } from '@/dev/testkit/mocks/browserIrohSharedWorker';

const HOME_ENDPOINT_ID = 'a'.repeat(64);
const OTHER_ENDPOINT_ID = 'b'.repeat(64);
const releaseSpy = vi.fn(async () => {});
const ensureHomeTunnel = vi.fn();
const network = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } });
});

describe('resolveHomeEnrollmentTransport', () => {
    beforeEach(() => {
        Platform.OS = 'ios';
        ensureHomeTunnel.mockReset();
        ensureHomeTunnel.mockResolvedValue({
            leaseId: 'lease-home-b',
            runtimeOrigin: 'http://127.0.0.1:43123',
            homeServerIdentityId: 'srv_home_b',
            homeEndpointId: HOME_ENDPOINT_ID,
            carrier: 'iroh', observedPath: 'direct', startedAtMs: 1,
        });
        releaseSpy.mockReset();
        releaseSpy.mockResolvedValue(undefined);
        network.mockReset();
        network.mockImplementation(async (input: RequestInfo | URL) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
            }));
            return Response.json({ ok: true });
        });
        setRuntimeFetch(network);
        getIrohHomeTunnelRuntime({ native: { ensureHomeTunnel, releaseHomeTunnel: releaseSpy } });
    });

    afterEach(async () => {
        await disposeIrohHomeTunnelRuntime();
        resetRuntimeFetch();
        vi.unstubAllGlobals();
    });

    it('acquires the shared browser carrier for credentialless enrollment without inventing a runtime origin', async () => {
        Platform.OS = 'web';
        vi.stubGlobal('location', { origin: 'https://app.test', href: 'https://app.test/enroll' });
        const browserBoundary = installBrowserIrohSharedWorkerBoundary({ localEndpointId: OTHER_ENDPOINT_ID });
        const descriptor = HomeConnectionDescriptorV1Schema.parse({
            v: 1 as const,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 7,
            endpoints: [{
                kind: 'iroh' as const,
                endpointId: HOME_ENDPOINT_ID,
                relayUrls: ['https://relay.example.test/'],
            }],
        });

        const result = await resolveHomeEnrollmentTransport(descriptor);

        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(ensureHomeTunnel).not.toHaveBeenCalled();
        expect(result.transport).toMatchObject({
            endpointUrl: 'http://localhost:3010',
            runtimeOrigin: null,
            carrier: 'iroh',
            authenticatedCredentialDestination: { kind: 'iroh', endpointId: HOME_ENDPOINT_ID },
            homeCarrier: { endpointId: HOME_ENDPOINT_ID, release: expect.any(Function) },
        });
        await Promise.all([result.transport.close(), result.transport.close()]);
        expect(browserBoundary.commands.filter((command) => command.kind === 'releaseLease')).toHaveLength(1);
    });

    it('selects one public HTTPS application endpoint while retaining canonical identity', async () => {
        const descriptor = HomeConnectionDescriptorV1Schema.parse({
            v: 1 as const,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 1,
            endpoints: [
                { kind: 'https' as const, url: 'http://localhost:3010' },
                { kind: 'https' as const, url: 'https://home-b.test' },
            ],
        });
        const result = await resolveHomeEnrollmentTransport(descriptor);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.transport).toMatchObject({
            descriptor,
            canonicalServerUrl: 'http://localhost:3010',
            homeServerIdentityId: 'srv_home_b',
            endpointUrl: 'http://localhost:3010',
            runtimeOrigin: 'https://home-b.test',
            carrier: 'https',
            authenticatedCredentialDestination: {
                kind: 'https',
                applicationUrl: 'https://home-b.test',
            },
        });
        await result.transport.close();
        expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('acquires a verified lease for pure Iroh while requests retain stable canonical identity', async () => {
        const descriptor = HomeConnectionDescriptorV1Schema.parse({
            v: 1 as const,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 7,
            endpoints: [{ kind: 'iroh' as const, endpointId: HOME_ENDPOINT_ID }],
        });
        const result = await resolveHomeEnrollmentTransport(descriptor);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(ensureHomeTunnel).toHaveBeenCalledWith(expect.objectContaining({
            homeServerIdentityId: 'srv_home_b',
            endpointId: HOME_ENDPOINT_ID,
        }));
        expect(result.transport.authenticatedCredentialDestination).toEqual({
            kind: 'iroh',
            endpointId: HOME_ENDPOINT_ID,
        });
        await result.transport.createRequest({ serverId: 'srv_home_b', credentials: null })('/enrollment-probe');
        expect(network).toHaveBeenCalledWith('http://127.0.0.1:43123/enrollment-probe', expect.anything());
        await Promise.all([result.transport.close(), result.transport.close()]);
        expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('fails closed on an Iroh identity mismatch even when an independent HTTPS endpoint exists', async () => {
        ensureHomeTunnel.mockRejectedValueOnce(
            Object.assign(new Error('identity mismatch'), { name: 'IrohError', code: 'identity_mismatch' }),
        );
        const result = await resolveHomeEnrollmentTransport(HomeConnectionDescriptorV1Schema.parse({
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 1,
            endpoints: [
                { kind: 'iroh', endpointId: HOME_ENDPOINT_ID },
                { kind: 'https', url: 'https://home-b.test' },
            ],
        }));
        expect(result).toEqual({
            ok: false,
            homeServerIdentityId: 'srv_home_b',
            reason: 'iroh_transport_failed_closed',
        });
        expect(releaseSpy).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
    });

    it('fails closed when the acquired Iroh lease does not authenticate the selected descriptor endpoint', async () => {
        releaseSpy.mockRejectedValueOnce(new Error('release failed'));
        // Ready and identity-matching, so only the EndpointId mismatch can close it.
        ensureHomeTunnel.mockResolvedValueOnce({
            leaseId: 'lease-wrong-endpoint',
            runtimeOrigin: 'http://127.0.0.1:43123',
            homeServerIdentityId: 'srv_home_b',
            homeEndpointId: OTHER_ENDPOINT_ID,
            carrier: 'iroh',
            observedPath: 'direct',
            startedAtMs: 1,
        });
        const result = await resolveHomeEnrollmentTransport(HomeConnectionDescriptorV1Schema.parse({
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 1,
            endpoints: [{ kind: 'iroh', endpointId: HOME_ENDPOINT_ID }],
        }));
        expect(result).toEqual({
            ok: false,
            homeServerIdentityId: 'srv_home_b',
            reason: 'iroh_transport_failed_closed',
        });
        expect(releaseSpy).toHaveBeenCalledWith('lease-wrong-endpoint');
        expect(network).not.toHaveBeenCalled();
    });

    it('fails typed without requesting canonical loopback when pure Iroh acquisition fails', async () => {
        ensureHomeTunnel.mockRejectedValueOnce(
            Object.assign(new Error('native unavailable'), { name: 'IrohError', code: 'unavailable' }),
        );
        const result = await resolveHomeEnrollmentTransport(HomeConnectionDescriptorV1Schema.parse({
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 1,
            endpoints: [{ kind: 'iroh', endpointId: HOME_ENDPOINT_ID }],
        }));
        expect(result).toEqual({
            ok: false,
            homeServerIdentityId: 'srv_home_b',
            reason: 'iroh_transport_unavailable',
        });
        expect(network).not.toHaveBeenCalled();
    });

    it('uses an already resolved runtime origin without double-acquiring Iroh', async () => {
        const result = await resolveHomeEnrollmentTransport(HomeConnectionDescriptorV1Schema.parse({
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'https://home-b.test',
            revision: 1,
            endpoints: [{ kind: 'iroh', endpointId: HOME_ENDPOINT_ID }],
        }), { runtimeOrigin: 'http://localhost:43123' });
        expect(result.ok && result.transport.runtimeOrigin).toBe('http://localhost:43123');
        expect(ensureHomeTunnel).not.toHaveBeenCalled();
    });

    it('keeps a supplied descriptor-declared HTTPS origin distinct from the canonical audience', async () => {
        const result = await resolveHomeEnrollmentTransport(HomeConnectionDescriptorV1Schema.parse({
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'https://canonical.home-b.test',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://ingress.home-b.test' }],
        }), {
            runtimeOrigin: 'https://ingress.home-b.test',
            runtimeCarrier: 'https',
        });

        expect(result).toMatchObject({ ok: true, transport: {
            endpointUrl: 'https://canonical.home-b.test',
            runtimeOrigin: 'https://ingress.home-b.test',
            authenticatedCredentialDestination: {
                kind: 'https',
                applicationUrl: 'https://ingress.home-b.test',
            },
        } });
    });
});
