import { describe, expect, it } from 'vitest';
import { definePlugin, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ConnectedAccountReadContext, ConnectedAccountMaterializationRequest } from '@happier-dev/plugin-sdk/connected-accounts';
import { executeManagedMachineAcquire } from '@happier-dev/cli-common/machines/managed';
import { connectedAccountRuntime } from './account.js';
import * as plugin from './index.js';

const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
const credentialRef = { kind: 'shared_resource', resourceId: 'retained-bootstrap-key' } as const;
const guestHostPublicKey = 'ssh-ed25519 AQIDBA== generated-host';
const resource = { serverId: 41, owned: { volumeIds: [], primaryIpIds: [9] } };

async function accountHost() {
  const requests: HttpRequest[] = [];
  let leases = 0;
  let disposed = 0;
  const credentialContext = { signal: new AbortController().signal,
    credentials: { get: async () => 'private-account-token' } } as unknown as ConnectedAccountReadContext;
  // Only host HTTP and private byte custody are replaced; public registration,
  // Account-to-Account dispatch, schemas, native decoding and cloud-init stay real.
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin,
    resolveCurrentPluginMaterializationRef: () => null,
    services: {
      connectedAccounts: { materialize: async (_purpose: string, request: ConnectedAccountMaterializationRequest) =>
        connectedAccountRuntime.materialize(request, credentialContext) },
      machineProvisioners: { materializeGuestHostCredential: async () => {
        leases++;
        const bytes = new TextEncoder().encode('private-guest-host-key');
        return { kind: 'bytes', bytes, dispose: async () => { disposed++; bytes.fill(0); } };
      } },
      http: createPluginHttpFixture({ request: async request => {
        requests.push(request);
        // Account HTTP has no daemon purpose sink; Account roles materialize the
        // captured purpose through connectedAccounts before sending HTTP.
        expect(request.credentialBinding).toBeUndefined();
        expect(new Headers(request.headers).get('authorization')).toBe('Bearer private-account-token');
        const path = new URL(request.url).pathname;
        if (path !== '/v1/servers' && path !== '/v1/servers/41') throw new Error(`Unexpected native path: ${path}`);
        return { status: request.method === 'POST' ? 201 : 200, body: new TextEncoder().encode(JSON.stringify({ server: {
          id: 41, status: 'running', labels: { 'happier-managed': 'row-1' }, volumes: [],
          public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null },
        } })) };
      } }),
    },
  });
  const caller = definePlugin({ id: 'test.hetzner.account-caller', version: '1.0.0', actions: {
    forward: { title: 'Invoke the retained Hetzner role', surfaces: ['plugin'], dangerLevel: 'destructive',
      confirmation: { title: 'Invoke the fixture role?', body: 'HTTP effects use the fixture.' },
      execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
      async run(input, context) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string' || input.body === undefined) {
          throw new Error('Invalid fixture invocation');
        }
        return context.services.actions.execute({ pluginId: plugin.PLUGIN_MANIFEST.id, localId: input.action, typeProjection: undefined }, input.body);
      },
    },
  } });
  const client = await createPluginTestkit({ manifest: caller.manifest, module: caller, actionTargets: [kit],
    resolveCurrentPluginMaterializationRef: () => null });
  return { requests, custody: () => ({ leases, disposed }),
    invoke: (action: string, body: Exclude<Parameters<typeof client.invokeAction>[1], undefined>) => client.invokeAction('forward', { action, body }, { surface: 'plugin' }),
    dispose: async () => { await client.dispose(); await kit.dispose(); },
  };
}

describe('Hetzner Account SSH roles without an execution Machine', () => {
  it('registers the same token materializer in the portable Account artifact', async () => {
    let runtime: Parameters<PluginAccountApi['connectedAccounts']['register']>[1] | undefined;
    await plugin.PLUGIN.activateAccount({ actions: { register: () => ({ dispose() {} }) },
      connectedAccounts: { register(_id, value) { runtime = value; return { dispose() {} }; } },
    } as PluginAccountApi);
    expect(runtime?.materialize).toBeTypeOf('function');
    if (!runtime?.materialize) throw new Error('Missing portable token materializer');
    const context = { signal: new AbortController().signal,
      credentials: { get: async () => 'private-account-token' } } as unknown as ConnectedAccountReadContext;
    expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.hetzner.cloud', headerNames: ['authorization'] }, context))
      .toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer private-account-token' } });
  });
  it('creates the pinned cloud-init guest through Account placement and reuses its exact resource', async () => {
    const host = await accountHost();
    try {
      const acquired = plugin.ROLE_SCHEMAS.acquireResult.parse(await host.invoke('acquire', {
        managedId: 'row-1', launch, bootstrapPublicKey: 'ssh-ed25519 AQIDBA== login', guestHostPublicKey,
      }));
      expect(acquired).toMatchObject({ kind: 'bound', resource: { value: resource } });
      const created = JSON.parse(new TextDecoder().decode(host.requests[0]!.body));
      expect(JSON.parse(created.user_data.replace(/^#cloud-config\n/u, ''))).toMatchObject({
        ssh_keys: { ed25519_private: 'private-guest-host-key', ed25519_public: guestHostPublicKey },
      });
      expect(host.custody()).toEqual({ leases: 1, disposed: 1 });
      expect(await host.invoke('bootstrap', { resource, credentialRef, guestHostPublicKey })).toMatchObject({
        kind: 'ssh', address: '192.0.2.1', credentialRef, hostKeyEvidence: { hostKey: '192.0.2.1 ssh-ed25519 AQIDBA==' },
      });
      expect(host.requests.map(request => [request.method, new URL(request.url).pathname]))
        .toEqual([['POST', '/v1/servers'], ['GET', '/v1/servers/41']]);
      expect(JSON.stringify(acquired)).not.toContain('private-guest-host-key');
    } finally { await host.dispose(); }
  });

  it('retries a retained no-pin server without allocating or generating replacement keys', async () => {
    const host = await accountHost();
    try {
      const input = { resource, credentialRef };
      const first = await host.invoke('bootstrap', input);
      expect(first).toMatchObject({ kind: 'ssh', address: '192.0.2.1', user: 'happier-bootstrap', credentialRef });
      expect(first).not.toHaveProperty('hostKeyEvidence');
      expect(await host.invoke('bootstrap', input)).toEqual(first);
      expect(host.requests.map(request => [request.method, new URL(request.url).pathname]))
        .toEqual([['GET', '/v1/servers/41'], ['GET', '/v1/servers/41']]);
      expect(host.custody()).toEqual({ leases: 0, disposed: 0 });
    } finally { await host.dispose(); }
  });

  it('refuses a browser before admission or vendor allocation', async () => {
    const host = await accountHost();
    let admissions = 0;
    try {
      const provisioner = plugin.PLUGIN_MANIFEST.contributes.machineProvisioners![0]!;
      await expect(executeManagedMachineAcquire({ host: 'browser', provisioner,
        admit: async () => { admissions++; throw new Error('Unexpected admission'); }, onAccepted: () => {},
        run: async () => host.invoke('acquire', { managedId: 'row-1', launch, bootstrapPublicKey: 'ssh-ed25519 AQIDBA==' }),
      })).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(admissions).toBe(0);
      expect(host.requests).toHaveLength(0);
      expect(host.custody()).toEqual({ leases: 0, disposed: 0 });
    } finally { await host.dispose(); }
  });
});
