import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createCrabboxProvider } from './provider.js';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema } from './schemas.js';
import { prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const launch = { backendId: 'aws' as const, transport: 'coordinator' as const, namespace: 'test-org',
  target: 'linux' as const, nativeImageId: 'ami-test', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
const connection = { endpoint: 'https://coordinator.example.test/native/', namespace: launch.namespace, token: 'test-private-token' };
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample host-owned';
const hostKey = `ssh-ed25519 ${Buffer.from('native-host-key-wire').toString('base64')}`;
const credentialRef = { kind: 'shared_resource' as const, resourceId: 'host-retained-key' };

describe('Crabbox managed provisioner roles', () => {
  it('uses the durable host tag for fixed lease replay and preserves uncertain acquisition custody', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const provider = createCrabboxProvider({ connection, observedAt: 100, http: async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (requests.length === 1) throw new Error('dropped after native allocation');
      return Response.json({ lease: { id: new URL(url).pathname.split('/').at(-1), provider: 'aws', org: launch.namespace,
        state: 'active', keep: true, cloudID: 'i-exact', host: '10.0.0.1', sshPort: '22', sshUser: 'crabbox', sshHostKey: hostKey } });
    } });
    const uncertain = await provider.acquire({ launch, managedId: 'managed-host-row-1', bootstrapPublicKey: publicKey });
    expect(uncertain.kind).toBe('pending');
    const retried = await provider.acquire({ launch, managedId: 'managed-host-row-1', bootstrapPublicKey: publicKey });
    expect(retried).toMatchObject({ kind: 'bound', resource: { value: { backendId: 'aws', namespace: launch.namespace, nativeInstanceId: 'i-exact' } } });
    if (uncertain.kind !== 'pending' || retried.kind !== 'bound') throw new Error('exact native custody missing');
    expect(retried.resource.value.leaseId).toBe(uncertain.nativeOperationRef.value.leaseId);
    expect(retried.resource.value.leaseId).toMatch(/^cbx_[0-9a-f]{12}$/);
    expect(requests.map(value => value.url)).toEqual([requests[0].url, requests[0].url]);
    expect(requests.every(value => !JSON.stringify(value.body).includes(connection.token))).toBe(true);
  });

  it('requires host-retained identity and public key before native effect', async () => {
    let effects = 0;
    const provider = createCrabboxProvider({ connection, observedAt: 100, http: async () => { effects++; throw new Error('must not run'); } });
    expect(await provider.acquire({ launch, bootstrapPublicKey: publicKey })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(await provider.acquire({ launch, managedId: 'managed-host-row-1' })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(effects).toBe(0);
  });

  it('uses canonical tolerant stored readers while keeping native effect ingress closed', async () => {
    const schemas = await prepareMachineProvisionerStoredSchemas({ launch: CrabboxLaunchV1Schema, resource: CrabboxResourceV1Schema });
    const resource = { backendId: 'aws', namespace: launch.namespace, transport: 'coordinator', leaseId: 'cbx_abcdef123456' };
    expect(schemas.launchStored.parse({ ...launch, future: { secret: 'ignored' } })).toEqual(launch);
    expect(schemas.resourceStored.parse({ ...resource, future: true })).toEqual(resource);
    expect(CrabboxLaunchV1Schema.safeParse({ ...launch, future: true }).success).toBe(false);
    expect(schemas.resourceStored.safeParse({ ...resource, leaseId: 'friendly-slug' }).success).toBe(false);
  });

  it('returns only the retained host credential reference and native SSH host-key evidence', async () => {
    const provider = createCrabboxProvider({ connection, observedAt: 100, http: async (url, init) => {
      expect(init.method).toBe('GET');
      return Response.json({ lease: { id: new URL(url).pathname.split('/').at(-1), provider: 'aws', org: launch.namespace,
        state: 'active', host: '10.0.0.1', sshUser: 'crabbox', sshPort: '22', sshHostKey: hostKey } });
    } });
    const carrier = await provider.bootstrap({ resource: { backendId: 'aws', namespace: launch.namespace, transport: 'coordinator', leaseId: 'cbx_abcdef123456' }, credentialRef });
    expect(carrier).toMatchObject({ kind: 'ssh', address: '10.0.0.1', user: 'crabbox', port: 22, credentialRef,
      hostKeyEvidence: { hostKey, fingerprint: expect.stringMatching(/^SHA256:/) } });
    expect(JSON.stringify(carrier)).not.toContain(connection.token);
  });

  it('projects native lease expiry separately from compute readiness and never substitutes a new resource', async () => {
    const provider = createCrabboxProvider({ connection, observedAt: 100, http: async (_url, init) => {
      expect(init.method).toBe('GET');
      return Response.json({ lease: { id: 'cbx_abcdef123456', provider: 'aws', org: launch.namespace, state: 'active',
        expiresAt: '2026-10-08T12:00:00Z' } });
    } });
    expect(await provider.inspect({ backendId: 'aws', namespace: launch.namespace, transport: 'coordinator', leaseId: 'cbx_abcdef123456' }))
      .toMatchObject({ observedAt: 100, availability: 'present', power: 'unknown', nativeExpiry: Date.parse('2026-10-08T12:00:00Z') });
  });
});
