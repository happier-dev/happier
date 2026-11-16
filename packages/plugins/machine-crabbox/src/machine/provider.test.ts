import { describe, expect, it } from 'vitest';
import { CrabboxCoordinatorClient, type CrabboxHttp } from './nativeClient.js';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema, type CrabboxLaunchV1, type CrabboxResourceV1 } from './schemas.js';
import { createCrabboxProvider } from './provider.js';
import { MachineProvisionerDestroyResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';

const resource: CrabboxResourceV1 = { backendId: 'aws', namespace: 'test-org', leaseId: 'cbx_abcdef123456', transport: 'coordinator' };
const launch: CrabboxLaunchV1 = { backendId: 'aws', namespace: 'test-org', transport: 'coordinator', nativeImageId: 'ami-test', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800, target: 'linux' };
const connection = { endpoint: 'https://coordinator.example.test', token: 'native-test-token', namespace: 'test-org' };
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample host-owned';
const lease = { id: resource.leaseId, provider: 'aws', org: resource.namespace, state: 'active', keep: true, cloudID: 'i-exact', host: '10.0.0.4', sshHostKey: 'ssh-ed25519 host-key', sshUser: 'crabbox', sshPort: '22', expiresAt: '2026-10-08T12:00:00Z', idleTimeoutSeconds: 1800 };

describe('Crabbox v0.71.0 retained native lease', () => {
    it.each(['aws', 'gcp'] as const)('launches an owned prepared %s checkpoint through checkpoint authorization', async backendId => {
        const checkpointID = 'chk_' + 'a'.repeat(32);
        const prepared = CrabboxLaunchV1Schema.parse({ ...launch, backendId, target: 'linux', nativeCheckpointId: checkpointID,
            ...(backendId === 'gcp' ? { gcpProject: 'selected-project', gcpZone: 'selected-zone' } : {}) });
        let existing = false;
        let claims = 0;
        const client = new CrabboxCoordinatorClient(connection, async (url, init) => {
            if (init.method === 'GET') return existing ? Response.json({ lease: { ...lease, provider: backendId, checkpointID } }) : new Response('', { status: 404 });
            const body = JSON.parse(String(init.body));
            if (url.endsWith('/use')) {
                expect(body).toEqual({ action: 'begin' }); claims++;
                return Response.json({ claim: 'private-native-use-token', checkpoint: { id: checkpointID, provider: backendId,
                    image: { id: prepared.nativeImageId, kind: backendId === 'aws' ? 'aws-ami' : 'gcp-machine-image' } } });
            }
            expect(url).toMatch(/\/from-checkpoint$/u);
            expect(body).toMatchObject({ checkpointID, checkpointUseClaim: 'private-native-use-token',
                [backendId === 'aws' ? 'awsAMI' : 'gcpMachineImage']: prepared.nativeImageId });
            expect(body).not.toHaveProperty('gcpImage');
            existing = true;
            // Native creation completed but its acknowledgement was lost.
            throw new Error('reply dropped');
        });
        expect(await client.acquire(prepared, { ...resource, backendId }, publicKey)).toMatchObject({ status: 'unknown' });
        expect(await client.acquire(prepared, { ...resource, backendId }, publicKey)).toMatchObject({ status: 'allocated' });
        expect(claims).toBe(1);
    });
    it('distinguishes accepted coordinator cleanup from unknown native delivery and observes its completion', async () => {
        let complete = false;
        const calls: string[] = [];
        const provider = createCrabboxProvider({ connection, observedAt: 1, http: async (_url, init) => {
            calls.push(String(init.method));
            return Response.json({ lease: { ...lease, state: 'released', cleanupStatus: complete ? 'complete' : 'pending',
                releaseDeletesServer: true, ...(complete ? { cleanupCompletedAt: '2026-10-08T12:01:00Z', host: '', sshHostKey: undefined } : {}) } });
        } });
        expect(MachineProvisionerDestroyResultV1Schema.parse(await provider.destroy(resource))).toEqual({ kind: 'pending' });
        expect(await provider.inspect(resource)).toMatchObject({ availability: 'unavailable', reason: 'native_cleanup_incomplete' });
        complete = true;
        expect(await provider.inspect(resource)).toMatchObject({ availability: 'absent' });
        expect(calls).toEqual(['GET', 'POST', 'GET', 'GET']);
        const missing = createCrabboxProvider({ connection, observedAt: 2, http: async () => new Response('', { status: 404 }) });
        expect(await missing.destroy(resource)).toEqual({ kind: 'unknown', code: 'native_transport_unknown',
            nativeCause: { httpStatusClass: '4xx' } });
    });
    it('waits for exact pending lease and SSH facts, while refusing malformed connection facts', async () => {
        const replies = [{ ...lease, state: 'provisioning', host: undefined }, { ...lease, host: undefined },
            { ...lease, sshPort: 'not-a-port' }, lease, { ...lease, state: 'released' }];
        const client = new CrabboxCoordinatorClient(connection, async () => Response.json({ lease: replies.shift() }));
        await expect(client.privateSshEndpoint(resource)).rejects.toMatchObject({ code: 'native_not_ready' });
        await expect(client.privateSshEndpoint(resource)).rejects.toMatchObject({ code: 'native_not_ready' });
        await expect(client.privateSshEndpoint(resource)).rejects.toMatchObject({ code: 'native_connection_invalid' });
        await expect(client.privateSshEndpoint(resource)).resolves.toMatchObject({ host: lease.host, port: 22, user: 'crabbox' });
        await expect(client.privateSshEndpoint(resource)).rejects.toMatchObject({ code: 'native_lease_ended', nativeCause: { localCause: 'native_lease_ended' } });
    });

    it('accepts the host RSA public half without transporting its private credential', async () => {
        const rsa = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned';
        let allocated = false;
        const client = new CrabboxCoordinatorClient(connection, async (_url, init) => {
            const body = JSON.parse(String(init.body));
            expect(body.sshPublicKey).toBe(rsa);
            expect(body).not.toHaveProperty('privateKey');
            allocated = true;
            return Response.json({ lease });
        });
        expect(await client.acquire(launch, resource, rsa)).toMatchObject({ status: 'allocated' });
        expect(allocated).toBe(true);
    });

    it('retains the exact native id after a dropped allocation reply; recovery only inspects it', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const http: CrabboxHttp = async (url, init) => {
            calls.push({ url, init });
            if (init.method === 'PUT') throw new Error('coordinator reply dropped');
            return Response.json({ lease });
        };
        const client = new CrabboxCoordinatorClient(connection, http);
        const acquired = await client.acquire(launch, resource, publicKey);
        expect(acquired).toMatchObject({ status: 'unknown', resource });
        const recovered = await client.inspect(acquired.resource);
        expect(recovered).toMatchObject({ state: 'unknown', leaseState: 'active', resource: { ...resource, nativeInstanceId: 'i-exact' }, idleTimeoutSeconds: 1800 });
        expect(calls.map(({ url, init }) => [init.method, new URL(url).pathname])).toEqual([
            ['PUT', `/v1/leases/${resource.leaseId}`], ['GET', `/v1/leases/${resource.leaseId}`],
        ]);
        const request = calls[0].init;
        expect(JSON.parse(String(request.body))).toMatchObject({ leaseID: resource.leaseId, provider: 'aws', sshPublicKey: publicKey, keep: true, ttlSeconds: 5400, idleTimeoutSeconds: 1800, awsAMI: 'ami-test', serverType: 'm7i.large' });
        expect(new Headers(request.headers).get('X-Crabbox-Org')).toBe(resource.namespace);
        expect(String(request.body)).not.toContain(connection.token);
        expect(String(request.body)).not.toContain('script');
    });

    it('binds deletion to id, backend and namespace and requires actual native cleanup evidence', async () => {
        const bodies: unknown[] = [];
        const http: CrabboxHttp = async (_url, init) => {
            if (init.method === 'POST') bodies.push(JSON.parse(String(init.body)));
            if (init.method === 'GET') return Response.json({ lease });
            return Response.json({ lease: { ...lease, state: 'released', host: '', sshHostKey: undefined, cleanupStatus: 'complete', cleanupCompletedAt: '2026-10-08T12:01:00Z', releaseDeletesServer: true } });
        };
        const observed = await new CrabboxCoordinatorClient(connection, http).destroy(resource);
        expect(observed).toMatchObject({ state: 'ended', cleanup: 'confirmed', resource: { ...resource, nativeInstanceId: 'i-exact' } });
        expect(bodies).toEqual([{ delete: true, expectedProvider: 'aws' }]);
        const retained = new CrabboxCoordinatorClient(connection, async () => Response.json({ lease: { ...lease, state: 'released', cleanupStatus: 'retained', releaseDeletesServer: false } }));
        expect(await retained.inspect(resource)).toMatchObject({ state: 'unknown', leaseState: 'released', cleanup: 'unknown' });
    });

    it('refuses identity drift before deletion and does not turn missing or expired records into absence', async () => {
        const calls: string[] = [];
        const client = new CrabboxCoordinatorClient(connection, async (_url, init) => {
            calls.push(String(init.method));
            return Response.json({ lease: { ...lease, org: 'other-org' } });
        });
        await expect(client.destroy(resource)).rejects.toMatchObject({ code: 'native_identity_mismatch' });
        expect(calls).toEqual(['GET']);
        const missing = new CrabboxCoordinatorClient(connection, async () => new Response('', { status: 404 }));
        expect(await missing.inspect(resource)).toMatchObject({ state: 'unknown', cleanup: 'unknown' });
        const expired = new CrabboxCoordinatorClient(connection, async () => Response.json({ lease }));
        expect(await expired.inspect(resource)).toMatchObject({ state: 'unknown', leaseState: 'active', cleanup: 'unknown' });
    });

    it('effect ingress requires a closed canonical lease identity', () => {
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, future: true }).success).toBe(false);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, leaseId: 'friendly-slug' }).success).toBe(false);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, leaseId: 'cbx_arbitrary' }).success).toBe(false);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, namespace: 'Research Team @ example' }).success).toBe(true);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, namespace: ' leading' }).success).toBe(false);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, backendId: 'blacksmith-testbox', transport: 'direct', leaseId: 'tbx_native123' }).success).toBe(true);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, backendId: 'blacksmith-testbox', leaseId: 'tbx_native123' }).success).toBe(false);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, backendId: 'local-container' }).success).toBe(false);
        expect(CrabboxResourceV1Schema.safeParse({ ...resource, leaseId: 'tbx_native123' }).success).toBe(false);
    });

    it('keeps SSH enrollment transport separate from nonsecret acquisition and safe observation', async () => {
        const calls: RequestInit[] = [];
        const client = new CrabboxCoordinatorClient(connection, async (_url, init) => {
            calls.push(init);
            return Response.json({ lease: { ...lease, providerMetadata: { token: 'must-not-publish' } } });
        });
        expect(await client.privateSshEndpoint(resource)).toEqual({ host: lease.host, port: 22, user: 'crabbox', hostKey: lease.sshHostKey });
        const acquired = await client.acquire(launch, resource, publicKey);
        expect(acquired.status).toBe('allocated');
        const published = JSON.stringify(acquired);
        for (const secret of [connection.token, 'must-not-publish', lease.host, lease.sshHostKey]) expect(published).not.toContain(secret);
        for (const call of calls) {
            expect(String(call.body)).not.toContain(connection.token);
            expect(String(call.body)).not.toContain('enrollment');
        }
        const unpinned = new CrabboxCoordinatorClient(connection, async () => Response.json({ lease: { ...lease, sshHostKey: '' } }));
        await expect(unpinned.privateSshEndpoint(resource)).rejects.toMatchObject({ code: 'native_not_ready' });
    });

    it('preserves native fixed-id terminal refusal; cancellation before dispatch has no native effect', async () => {
        const calls: RequestInit[] = [];
        const client = new CrabboxCoordinatorClient(connection, async (_url, init) => {
            calls.push(init);
            return Response.json({ error: 'fixed_lease_terminal', message: 'private-native-diagnostic' }, { status: 409 });
        });
        expect(await client.acquire(launch, resource, publicKey)).toMatchObject({ status: 'refused', code: 'native_lease_ended' });
        const controller = new AbortController();
        controller.abort();
        expect(await client.acquire(launch, resource, publicKey, controller.signal)).toMatchObject({ status: 'unknown' });
        expect(calls).toHaveLength(1);
    });

    it('does not treat null or remaining cleanup debt as native deletion confirmation', async () => {
        const terminal = { ...lease, state: 'released', host: '', sshHostKey: undefined, cleanupStatus: 'complete', cleanupCompletedAt: '2026-10-08T12:01:00Z' };
        for (const debt of [{ tailscale: null }, { providerAccessExpiresAt: '2026-10-08T12:01:00Z' }, { cleanupRetryAt: '2026-10-08T12:02:00Z' }, { cleanupCompletedAt: 'invalid' }]) {
            const client = new CrabboxCoordinatorClient(connection, async () => Response.json({ lease: { ...terminal, ...debt } }));
            expect(await client.inspect(resource)).toMatchObject({ cleanup: 'unknown' });
        }
    });

    it('preserves a native coordinator base path without redirecting its private credential', async () => {
        const urls: string[] = [];
        const client = new CrabboxCoordinatorClient({ ...connection, endpoint: 'https://coordinator.example.test/native/crabbox///' }, async (url, init) => {
            urls.push(url);
            expect(init.redirect).toBe('error');
            return Response.json({ lease });
        });
        await client.inspect(resource);
        expect(urls).toEqual([`https://coordinator.example.test/native/crabbox/v1/leases/${resource.leaseId}`]);
    });

    it('supports explicit native local coordinator URLs and native AWS macOS leases', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const client = new CrabboxCoordinatorClient({ ...connection, endpoint: 'http://127.0.0.1:8080/local/' }, async (url, init) => {
            calls.push({ url, init });
            return Response.json({ lease });
        });
        expect(await client.acquire({ ...launch, target: 'macos' }, resource, publicKey)).toMatchObject({ status: 'allocated', observation: { state: 'unknown', leaseState: 'active' } });
        expect(calls[0].url).toBe(`http://127.0.0.1:8080/local/v1/leases/${resource.leaseId}`);
        expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ target: 'macos', keep: true });
    });

    it('uses qualified native GCP and Hetzner image/scope fields, never AWS defaults', async () => {
        const selected = [
            { ...launch, backendId: 'gcp' as const, target: 'linux' as const, nativeImageId: 'projects/image-project/global/images/linux-image', nativeSizeId: 'n2-standard-4', gcpProject: 'selected-project', gcpZone: 'europe-west1-b' },
            { ...launch, backendId: 'hetzner' as const, target: 'linux' as const, nativeImageId: 'ubuntu-24.04', nativeSizeId: 'cx33', location: 'nbg1' },
        ];
        for (const configuration of selected) {
            const identity = { ...resource, backendId: configuration.backendId };
            const client = new CrabboxCoordinatorClient(connection, async (_url, init) => {
                const body = JSON.parse(String(init.body));
                const expected = configuration.backendId === 'gcp'
                    ? { gcpImage: configuration.nativeImageId, gcpProject: 'selected-project', gcpZone: 'europe-west1-b' }
                    : { image: configuration.nativeImageId, location: 'nbg1' };
                expect(body).toMatchObject({ ...expected, provider: configuration.backendId, leaseID: identity.leaseId, keep: true });
                expect(body.awsAMI).toBeUndefined();
                return Response.json({ lease: { ...lease, provider: configuration.backendId, cloudID: 'native-exact-id' } });
            });
            expect(await client.acquire(configuration, identity, publicKey)).toMatchObject({ status: 'allocated', resource: { ...identity, nativeInstanceId: 'native-exact-id' } });
        }
    });
});
