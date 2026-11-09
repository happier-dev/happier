import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    adoptHomeProfile,
    captureActiveServerRuntimeTarget,
    getActiveServerSnapshot,
    publishActiveServerRuntimeOrigin,
    releaseActiveServerRuntimeOrigin,
    setActiveServerId,
} from '@/sync/domains/server/serverProfiles';
import { resetServerReachabilitySupervisors, startServerReachabilitySupervisor, waitForServerReachable } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { acquireEligibleHomeCarrier } from '@/sync/runtime/homeCarrierPolicy';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { createServerFetchAtEndpoint, serverFetch } from './client';

const socketDialUrls = vi.hoisted(() => [] as string[]);
// Socket.IO construction is the network boundary. The real readiness pool,
// socket orchestration and publication admission remain exercised below.
vi.mock('socket.io-client', () => ({ io: (url: string) => {
    socketDialUrls.push(url);
    throw new Error('Unexpected socket network dial');
} }));

afterEach(async () => {
    apiSocket.disconnect();
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    socketDialUrls.length = 0;
});

describe('focused Home transport publication admission', () => {
    it.each([false, true])('does not inherit prior online readiness after unpublication (stale capture: %s)', async (staleCapture) => {
        const home = await adoptHomeProfile({ source: 'manual', descriptor: {
            v: 1, homeServerIdentityId: 'srv_publication_prior_online', canonicalServerUrl: 'https://prior-identity.example.test',
            revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64) }],
        } });
        await setActiveServerId(home.id, { scope: 'device' });
        const target = captureActiveServerRuntimeTarget();
        publishActiveServerRuntimeOrigin({ target, leaseId: 'prior-live', carrier: 'iroh', runtimeOrigin: 'http://127.0.0.1:45102' });
        setRuntimeFetch(async () => new Response('{"ok":true}', { status: 200 }));
        await startServerReachabilitySupervisor({ serverUrl: home.serverUrl, token: 'prior-token', runtimeOrigin: 'http://127.0.0.1:45102' });
        await waitForServerReachable({ serverUrl: home.serverUrl, token: 'prior-token', timeoutMs: 1000 });
        releaseActiveServerRuntimeOrigin({ target, leaseId: 'prior-live' });
        const snapshot = getActiveServerSnapshot();
        apiSocket.initialize({
            endpoint: snapshot.serverUrl, token: 'prior-token', serverId: snapshot.serverId, generation: snapshot.generation,
            ...(staleCapture ? { carrier: 'iroh' as const, runtimeOrigin: 'http://127.0.0.1:45102' } : {}),
        }, null);
        expect(socketDialUrls).toEqual([]);
    });

    it('fences HTTP and socket readiness after Iroh unpublication until policy publishes a permitted endpoint', async () => {
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_publication_recovery',
            canonicalServerUrl: 'https://identity.example.test',
            revision: 1,
            endpoints: [
                { kind: 'iroh' as const, endpointId: 'a'.repeat(64) },
                { kind: 'https' as const, url: 'https://ingress.example.test' },
            ],
        };
        const home = await adoptHomeProfile({ descriptor, source: 'manual' });
        await setActiveServerId(home.id, { scope: 'device' });
        const target = captureActiveServerRuntimeTarget();
        publishActiveServerRuntimeOrigin({
            target, leaseId: 'native-live', carrier: 'iroh', runtimeOrigin: 'http://127.0.0.1:45101',
        });
        const requests: string[] = [];
        // The only substituted boundary is network I/O. Real profile, request,
        // socket and reachability owners execute; 503 keeps Socket.IO unopened.
        setRuntimeFetch(async (input) => {
            requests.push(String(input));
            return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
        });
        const snapshot = getActiveServerSnapshot();
        apiSocket.initialize({
            endpoint: descriptor.canonicalServerUrl, token: 'test-token',
            serverId: snapshot.serverId, generation: snapshot.generation,
            carrier: 'iroh', runtimeOrigin: snapshot.runtimeOrigin,
        }, null);
        await serverFetch('/health', undefined, { includeAuth: false, retry: 'none' });
        expect(requests.some((url) => url.startsWith('http://127.0.0.1:45101/'))).toBe(true);

        releaseActiveServerRuntimeOrigin({ target, leaseId: 'native-live' });
        apiSocket.updateToken('replacement-token');
        await expect(serverFetch('/health', undefined, { includeAuth: false, retry: 'none' }))
            .rejects.toMatchObject({ name: 'ServerScopedTransportUnavailableError' });
        expect(requests.some((url) => url.startsWith(descriptor.canonicalServerUrl))).toBe(false);
        expect(requests.some((url) => url.startsWith('https://ingress.example.test'))).toBe(false);

        // HTTPS-only policy is independently valid. Its admitted ingress, not
        // the canonical authentication audience, resumes these same consumers.
        const httpsDescriptor = { ...descriptor, endpoints: [descriptor.endpoints[1]!] };
        const admitted = await acquireEligibleHomeCarrier({
            applicationCarrierEligibility: 'automatic',
            descriptor: httpsDescriptor, verification: { kind: 'authenticated', token: 'test-token' },
        });
        expect(admitted.kind).toBe('https');
        if (admitted.kind !== 'https') throw new Error('HTTPS policy must select the declared ingress');
        publishActiveServerRuntimeOrigin({ target, leaseId: 'https-admitted', carrier: 'https', runtimeOrigin: admitted.runtimeOrigin });
        await serverFetch('/health', undefined, { includeAuth: false, retry: 'none' });
        expect(requests.some((url) => url.startsWith('https://ingress.example.test/'))).toBe(true);
        expect(requests.some((url) => url.startsWith(descriptor.canonicalServerUrl))).toBe(false);
        releaseActiveServerRuntimeOrigin({ target, leaseId: 'https-admitted' });
    });

    it('keeps explicit first-contact HTTPS requests independent from a focused Home awaiting publication', async () => {
        const home = await adoptHomeProfile({ source: 'manual', descriptor: {
            v: 1, homeServerIdentityId: 'srv_publication_first_contact', canonicalServerUrl: 'https://other-identity.example.test',
            revision: 1, endpoints: [{ kind: 'https', url: 'https://other-ingress.example.test' }],
        } });
        await setActiveServerId(home.id, { scope: 'device' });
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            requests.push(String(input));
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://enrollment.example.test', credentials: null });
        await request('/v1/features', undefined, { includeAuth: false, retry: 'none' });
        expect(requests).toEqual(['https://enrollment.example.test/v1/features']);
    });
});
