import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrohError } from '@happier-dev/iroh-native';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';

import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

const acquireBrowserCarrierSpy = vi.hoisted(() => vi.fn());

// The browser carrier (worker/wasm) and storage/fetch are the only boundaries;
// profiles, the focused publication and the carrier policy run for real.
vi.mock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier')>()),
    acquireBrowserIrohHomeCarrier: (input: unknown) => acquireBrowserCarrierSpy(input),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock();
});

import { resolveServerScopedTransport } from './resolveServerScopedTransport';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('focused_home_transport');

const descriptor: HomeConnectionDescriptorV1 = {
    v: 1,
    homeServerIdentityId: 'srv_focused_home',
    canonicalServerUrl: 'https://focused-home.example.test',
    revision: 3,
    endpoints: [
        { kind: 'iroh', endpointId: 'c'.repeat(64), relayUrls: ['https://relay.example.test/'] },
        { kind: 'https', url: 'https://focused-home.example.test' },
    ],
};

function setBrowserHost(): void {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    } });
    Object.defineProperty(globalThis, 'SharedWorker', { configurable: true, value: function SharedWorkerStub() {} });
}

describe('resolveServerScopedTransport for the focused Home', () => {
    let restoreStorage: () => void;
    let restoreLocks: () => void;

    beforeEach(() => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        setBrowserHost();
        acquireBrowserCarrierSpy.mockReset();
        acquireBrowserCarrierSpy.mockRejectedValue(new IrohError('unavailable', 'relay unavailable'));
    });

    afterEach(async () => {
        await resetServerReachabilitySupervisors();
        resetRuntimeFetch();
        Reflect.deleteProperty(globalThis, 'navigator');
        Reflect.deleteProperty(globalThis, 'SharedWorker');
        restoreLocks();
        restoreStorage();
    });

    it('borrows the transport the connection owner already verified instead of re-proving the Home per read', async () => {
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = String(input);
            requests.push(new URL(url).pathname);
            return new Response(JSON.stringify(url.endsWith('/v1/features')
                ? { features: {}, capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } } }
                : {}), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const profile = await profiles.adoptHomeProfile({ descriptor, source: 'manual', descriptorAuthority: 'current_connection_observation' });
        await profiles.setActiveServerId(profile.id, { scope: 'device' });
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: profiles.captureActiveServerRuntimeTarget(),
            leaseId: 'https-fallback:focused', runtimeOrigin: 'https://focused-home.example.test', carrier: 'https',
        })).toBe(true);

        // Sequential, as screens issue them: each read used to re-acquire and re-prove the Home.
        const reads = [];
        for (let read = 0; read < 3; read += 1) {
            reads.push(await resolveServerScopedTransport({
                profile: profiles.getServerProfileById(profile.id)!,
                credentials: { token: 'focused-token' },
            }));
        }

        expect(reads.map((read) => [read.carrier, read.runtimeOrigin])).toEqual([
            ['https', 'https://focused-home.example.test'],
            ['https', 'https://focused-home.example.test'],
            ['https', 'https://focused-home.example.test'],
        ]);
        expect(requests.filter((path) => path === '/v1/features')).toHaveLength(0);
        expect(acquireBrowserCarrierSpy).not.toHaveBeenCalled();
    });

    it('gives a caller its own Iroh carrier, so the connection owner releasing its published one cannot strand the read', async () => {
        const carrierFor = (leaseId: string) => {
            let released = false;
            return {
                leaseId,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                endpointId: 'c'.repeat(64),
                appliedRelayUrls: ['https://relay.example.test/'],
                readObservedPath: () => 'relay' as const,
                request: async () => {
                    if (released) throw new Error(`lease ${leaseId} released`);
                    return new Response(null, { status: 200 });
                },
                createWebSocket: () => ({}),
                release: async () => { released = true; },
            };
        };
        acquireBrowserCarrierSpy.mockReset();
        acquireBrowserCarrierSpy.mockImplementation(async () => carrierFor('reader-lease'));
        const profile = await profiles.adoptHomeProfile({ descriptor, source: 'manual', descriptorAuthority: 'current_connection_observation' });
        await profiles.setActiveServerId(profile.id, { scope: 'device' });
        const target = profiles.captureActiveServerRuntimeTarget();
        const ownerCarrier = carrierFor('owner-lease');
        expect(profiles.publishActiveServerRuntimeOrigin({
            target, leaseId: ownerCarrier.leaseId, homeCarrier: ownerCarrier, carrier: 'iroh',
        })).toBe(true);

        // The scoped socket pool retains a transport for its socket's lifetime.
        const transport = await resolveServerScopedTransport({
            profile: profiles.getServerProfileById(profile.id)!,
            credentials: { token: 'focused-token' },
        });
        // Retry on the same Home: the connection owner releases its carrier and reacquires.
        profiles.releaseActiveServerRuntimeOrigin({ target, leaseId: ownerCarrier.leaseId });
        await ownerCarrier.release();

        await expect(transport.homeCarrier!.request('https://focused-home.example.test/v1/sessions', {}))
            .resolves.toMatchObject({ status: 200 });
        await transport.release();
    });
});
