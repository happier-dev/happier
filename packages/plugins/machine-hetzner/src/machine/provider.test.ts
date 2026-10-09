import { describe, expect, it, vi } from 'vitest';
import { createHetznerNativeClient } from './nativeClient.js';

const resource = { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } };
const server = { id: 41, status: 'off', labels: { 'happier-managed': 'row-1' }, public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null }, volumes: [] };
const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
const acquire = { launch, name: 'work', correlation: 'row-1', bootstrapSshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest host' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('Hetzner native boundary', () => {
  it('retains create uncertainty after a dropped reply without replaying allocation', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('token-do-not-disclose'));
    const client = createHetznerNativeClient({ token: 'token-do-not-disclose', fetch: transport });
    expect(await client.acquire(acquire)).toEqual({ kind: 'unknown', code: 'native_transport_unknown', correlation: 'row-1' });
    expect(transport).toHaveBeenCalledTimes(1); // One HTTP allocation; replay would buy another server.
  });

  it('rejects undeclared launch fields before any vendor effect', async () => {
    const transport = vi.fn<typeof fetch>();
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    await expect(client.acquire({ ...acquire, launch: { ...launch, enrollmentBearer: 'private' } })).rejects.toMatchObject({ code: 'native_input_invalid' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('recovers one exact labeled candidate across native pages, but refuses ambiguous candidates', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ servers: [], meta: { pagination: { next_page: 2 } } }))
      .mockResolvedValueOnce(json({ servers: [server], meta: { pagination: { next_page: null } } }))
      .mockResolvedValueOnce(json({ servers: [server, { ...server, id: 42 }], meta: { pagination: { next_page: null } } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.recover('row-1')).toMatchObject({ kind: 'bound', resource });
    expect(await client.recover('row-1')).toEqual({ kind: 'unknown', code: 'native_identity_ambiguous', correlation: 'row-1' });
  });

  it('distinguishes exact absence from authorization and network failures', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404))
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'private' } }, 401))
      .mockRejectedValueOnce(new Error('private'));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.inspect(resource)).toEqual({ kind: 'absent' });
    await expect(client.inspect(resource)).rejects.toMatchObject({ code: 'native_authorization_failed' });
    await expect(client.inspect(resource)).rejects.toMatchObject({ code: 'native_transport_unavailable' });
  });

  it('binds accepted identity without equating a running action with readiness; injects only the public SSH key', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ server: { ...server, status: 'initializing' }, action: { id: 7, status: 'running' } }, 201));
    const client = createHetznerNativeClient({ token: 'private-bearer', fetch: transport });
    expect(await client.acquire(acquire)).toMatchObject({ kind: 'bound', resource: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [9] } }, nativeAction: { id: 7, status: 'running' }, power: 'transitioning' });
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(body.user_data).toContain(acquire.bootstrapSshPublicKey.split(' ').slice(0, 2).join(' '));
    expect(JSON.stringify(body)).not.toContain('private-bearer');
    expect(body).not.toHaveProperty('enrollment');
  });

  it('reports stopped compute charges independently and shutdown remains pending', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ server }))
      .mockResolvedValueOnce(json({ action: { id: 8, status: 'running' } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.inspect(resource)).toMatchObject({ kind: 'present', power: 'stopped', billing: { location: 'cloud', stoppedBilling: 'billed' } });
    expect(await client.power(resource, 'stop')).toEqual({ kind: 'pending', nativeAction: { id: 8, status: 'running' } });
    expect(String(transport.mock.calls[1][0])).toMatch(/\/servers\/41\/actions\/shutdown$/);
  });

  it('deletes only exact owned resources and retains partial cleanup after a native refusal', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ action: { id: 10, status: 'success' } }))
      .mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ error: { code: 'conflict' } }, 409));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.destroy({ serverId: 41, owned: { volumeIds: [3], primaryIpIds: [9] } })).toMatchObject({ kind: 'incomplete', remaining: [{ kind: 'primary-ip', id: 9 }] });
    expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/servers/41', '/v1/servers/41', '/v1/volumes/3', '/v1/primary_ips/9']);
  });

  it('preserves returned hourly and monthly prices rather than synthesizing a conversion', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ server_types: [{ id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86', prices: [{ location: 'fsn1', price_hourly: { net: '0.0048', gross: '0.0057' }, price_monthly: { net: '2.99', gross: '3.56' } }] }], meta: { pagination: { next_page: null } } }))
      .mockResolvedValueOnce(json({ images: [{ id: 2, name: 'ubuntu-24.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null }], meta: { pagination: { next_page: null } } }))
      .mockResolvedValueOnce(json({ locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein' }], meta: { pagination: { next_page: null } } }))
      .mockResolvedValueOnce(json({ pricing: { currency: 'EUR',
        primary_ips: [{ type: 'ipv4', prices: [{ location: 'fsn1', price_hourly: { net: '0.0008', gross: '0.0010' }, price_monthly: { net: '0.50', gross: '0.5950' } }] }],
        volume: { price_per_gb_month: { net: '0.0449', gross: '0.0535' } },
      } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    const retained = await client.options();
    expect(retained).toMatchObject({ sizes: [{ prices: [{ hourly: { amount: '0.0057', currency: 'EUR', unit: 'hour' }, monthly: { amount: '3.56', unit: 'month' } }] }] });
    expect(retained).toMatchObject({
      storageCharges: [{ amount: '0.0535', currency: 'EUR', unit: 'GB-month', source: 'https://api.hetzner.cloud/v1/pricing#volume', observedAt: expect.any(Number) }],
      primaryIpPrices: [{ type: 'ipv4', prices: [{ location: 'fsn1', hourly: { amount: '0.0010', unit: 'hour' }, monthly: { amount: '0.5950', unit: 'month' } }] }],
    });
  });

  it('does not infer absence from an arbitrary 404 or inspect a mismatched identity', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'unknown', message: 'private' } }, 404))
      .mockResolvedValueOnce(json({ server: { ...server, id: 42 } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    await expect(client.inspect(resource)).rejects.toMatchObject({ code: 'native_request_failed' });
    await expect(client.inspect(resource)).rejects.toMatchObject({ code: 'native_identity_mismatch' });
  });

  it('never binds an unrelated label and never adopts discovered attachments as owned', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({
      servers: [{ ...server, labels: { 'happier-managed': 'other' } }], meta: { pagination: { next_page: null } },
    }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.recover('row-1')).toEqual({ kind: 'unknown', code: 'native_identity_not_found', correlation: 'row-1' });
  });

  it('retains server and attachments until exact server absence is observed', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ action: { id: 10, status: 'running' } }))
      .mockResolvedValueOnce(json({ server: { ...server, status: 'deleting' } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.destroy({ serverId: 41, owned: { volumeIds: [3], primaryIpIds: [9] } })).toMatchObject({
      kind: 'incomplete', remaining: [{ kind: 'server', id: 41 }, { kind: 'volume', id: 3 }, { kind: 'primary-ip', id: 9 }],
    });
    expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/servers/41', '/v1/servers/41']);
  });

  it('redacts failed cleanup and never replays a lost delete reply', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('private'));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    const result = await client.destroy(resource);
    expect(result).toMatchObject({ kind: 'incomplete', code: 'native_transport_unavailable', remaining: [{ kind: 'server', id: 41 }] });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('retains uncertainty for a malformed accepted create response', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: { id: 'private' } }, 201));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.acquire(acquire)).toEqual({ kind: 'unknown', code: 'native_response_invalid', correlation: 'row-1' });
  });

  it('refuses private material disguised as a public SSH key before allocation', async () => {
    const transport = vi.fn<typeof fetch>();
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    await expect(client.acquire({ ...acquire, bootstrapSshPublicKey: '-----BEGIN OPENSSH PRIVATE KEY-----' })).rejects.toMatchObject({ code: 'native_input_invalid' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains accepted server identity when its returned action facts are malformed', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server, action: { id: 'broken', status: 'unknown' } }, 201));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.acquire(acquire)).toMatchObject({ kind: 'bound', resource: { serverId: 41 }, nativeActionUnavailable: true });
  });

  it('retains paid identity when accepted response readiness and network facts are incomplete', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: { id: 41 }, action: { id: 7, status: 'success' } }, 201));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.acquire(acquire)).toMatchObject({
      kind: 'bound', resource, power: 'unknown', nativeFactsUnavailable: true,
    });
  });

  it('retains attachment cleanup when deletion was only accepted asynchronously', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ action: { id: 10, status: 'success' } }))
      .mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404))
      .mockResolvedValueOnce(json({ action: { id: 11, status: 'running' } }, 202))
      .mockResolvedValueOnce(json({ volume: { id: 3 } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.destroy({ serverId: 41, owned: { volumeIds: [3], primaryIpIds: [] } })).toMatchObject({ kind: 'incomplete', remaining: [{ kind: 'volume', id: 3 }] });
  });

  it('accepts a native RFC1123 name spanning multiple labels', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server, action: { id: 7, status: 'success' } }, 201));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(await client.acquire({ ...acquire, name })).toMatchObject({ kind: 'bound', resource: { serverId: 41 } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).name).toBe(name);
  });
});
