import { describe, expect, it, vi } from 'vitest';
import { createHetznerNativeClient } from './nativeClient.js';
import { createHetznerProvider } from './provider.js';

const resource = { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } };
const server = { id: 41, status: 'off', labels: { 'happier-managed': 'row-1' }, public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null }, volumes: [] };
const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
const acquire = { launch, name: 'work', correlation: 'row-1', bootstrapSshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest host' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('Hetzner native boundary', () => {
  it('reads one server for availability and preserves a multi-page catalog with minimum native requests', async () => {
    // Two maximum-size API pages plus a tail must preserve every image.
    const deprecation = { announced: '2026-08-31T00:00:00Z', unavailable_after: '2026-11-30T00:00:00Z' };
    const image = { name: 'ubuntu', architecture: 'x86', type: 'system', status: 'available' };
    const images = [
      { ...image, id: 1, deprecation: null },
      { ...image, id: 2, deprecated: null, deprecation },
      { ...image, id: 3, deprecated: deprecation.announced },
      ...Array.from({ length: 98 }, (_, index) => ({ ...image, id: index + 4, deprecated: null })),
    ];
    const transport = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/servers') return json({ servers: [] });
      if (url.pathname === '/v1/pricing') return json({ pricing: { currency: 'EUR' } });
      const key = url.pathname.slice('/v1/'.length);
      const values = key === 'images' ? images : [];
      const page = Number(url.searchParams.get('page') ?? 1);
      const perPage = Number(url.searchParams.get('per_page') ?? 25);
      const end = page * perPage;
      return json({ [key]: values.slice(end - perPage, end), meta: { pagination: { next_page: end < values.length ? page + 1 : null } } });
    });
    const client = createHetznerNativeClient({ token: 'fixture', fetch: transport });
    expect(await client.check()).toEqual({ available: true });
    expect.soft(new URL(String(transport.mock.calls[0][0])).searchParams.get('per_page')).toBe('1');
    const options = await client.options();
    expect(options.images.map(image => image.id)).toEqual(images.map(image => image.id));
    expect(options.images.slice(0, 3).map(image => image.deprecated)).toEqual([null, deprecation.announced, deprecation.announced]);
    expect(transport.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/images')).toHaveLength(3);
    expect(transport.mock.calls).toHaveLength(7); // One health read, three image pages, two empty catalogs, one pricing read.
  });

  it('rejects a catalog image with no native deprecation fact', async () => {
    const transport = vi.fn<typeof fetch>(async input => {
      const key = new URL(String(input)).pathname.slice('/v1/'.length);
      if (key === 'pricing') return json({ pricing: { currency: 'EUR' } });
      return json({ [key]: key === 'images' ? [{ id: 1, name: 'ubuntu', architecture: 'x86', type: 'system', status: 'available' }] : [],
        meta: { pagination: { next_page: null } } });
    });
    await expect(createHetznerNativeClient({ token: 'fixture', fetch: transport }).options())
      .rejects.toMatchObject({ code: 'native_response_invalid' });
  });

  it.each(['off', 'error', 'unknown', 'stopping', 'deleting', 'rebuilding', 'migrating'])(
    'settles bootstrap for native %s without claiming startup is pending', async status => {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ server: { ...server, status } }));
      await expect(createHetznerProvider({ token: 'fixture', fetch: transport }).bootstrap(resource))
        .rejects.toMatchObject({ code: 'native_resource_unavailable' });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]?.[1]?.method).toBe('GET');
    });

  it('waits for a running server address without retrying malformed IPv6 facts', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ server: { ...server, status: 'initializing' } }))
      .mockResolvedValueOnce(json({ server: { ...server, status: 'running', public_net: { ipv4: null, ipv6: null } } }))
      .mockResolvedValueOnce(json({ server: { ...server, status: 'running', public_net: { ipv4: null, ipv6: { ip: '2001:db8::/32' } } } }))
      .mockResolvedValueOnce(json({ server: { ...server, status: 'running' } }));
    const provider = createHetznerProvider({ token: 'fixture', fetch: transport });
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ code: 'native_not_ready' });
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ code: 'native_not_ready' });
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ code: 'native_ssh_address_unavailable' });
    await expect(provider.bootstrap(resource)).resolves.toMatchObject({ address: '192.0.2.1', username: 'happier-bootstrap' });
    expect(transport.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('projects documented invalid fields once without retaining messages, reflected labels or arbitrary content', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ error: {
      code: 'invalid_input', message: 'private native response', details: { fields: [
        { name: 'image', messages: ['private image value'] }, { name: 'public_net', messages: ['private'] },
        { name: 'image', messages: ['duplicate'] }, { name: 'private-token', messages: ['private'] },
        { name: 'labels.private-value', messages: ['private'] }, { name: 'ssh_keys', messages: ['not submitted'] }, null,
      ] },
    } }, 422));
    const result = await createHetznerNativeClient({ token: 'private-token', fetch: transport }).acquire(acquire);
    expect(result).toEqual({ kind: 'rejected', code: 'native_request_failed',
      nativeCause: { httpStatusClass: '4xx', code: 'invalid_input', fields: ['image', 'public_net'] } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps missing server custody until every owned volume and primary IP is absent', async () => {
    const owned = { serverId: 41, owned: { volumeIds: [3], primaryIpIds: [9] } };
    const missing = () => json({ error: { code: 'not_found' } }, 404);
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(missing()).mockResolvedValueOnce(json({ volume: { id: 3 } }))
      .mockResolvedValueOnce(missing()).mockResolvedValueOnce(missing()).mockResolvedValueOnce(json({ error: { code: 'unauthorized' } }, 401))
      .mockResolvedValueOnce(missing()).mockResolvedValueOnce(missing()).mockResolvedValueOnce(missing());
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    await expect(client.inspect(owned)).rejects.toMatchObject({ code: 'native_cleanup_unconfirmed' });
    await expect(client.inspect(owned)).rejects.toMatchObject({ code: 'native_authorization_failed' });
    expect(await client.inspect(owned)).toEqual({ kind: 'absent' });
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it.each([
    [422, 'invalid_input'], [403, 'resource_limit_exceeded'], [401, 'unauthorized'],
    [403, 'forbidden'], [422, 'placement_error'], [409, 'uniqueness_error'],
  ] as const)('retains safe native cause for HTTP %s %s without vendor content', async (status, code) => {
    // REST v1 Errors, fetched 2026-10-25: error.code is machine-parsable;
    // message/details can reflect request content and must never escape.
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ error: {
      code, message: 'private-request-content',
      ...(code === 'invalid_input' ? { details: { fields: [{ name: 'broken_field', messages: ['private-request-content'] }] } }
        : code === 'resource_limit_exceeded' ? { details: { limits: [{ name: 'project_limit' }] } } : {}),
    } }, status));
    const client = createHetznerNativeClient({ token: 'private-token', fetch: transport });
    const result = await client.acquire(acquire);
    expect(result).toEqual({ kind: 'rejected', code: status === 401 || status === 403 ? 'native_authorization_failed' : 'native_request_failed',
      nativeCause: { httpStatusClass: '4xx', code } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(transport).toHaveBeenCalledTimes(1); // A permanent refusal never repeats allocation.
  });

  it('retains HTTP class when a vendor code is unknown or its error body is invalid', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'secret-token-value', message: 'private' } }, 422))
      .mockResolvedValueOnce(new Response('private invalid JSON', { status: 503 }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.acquire(acquire)).toEqual({ kind: 'rejected', code: 'native_request_failed', nativeCause: { httpStatusClass: '4xx' } });
    expect(await client.acquire(acquire)).toEqual({ kind: 'unknown', code: 'native_service_unavailable', correlation: 'row-1', nativeCause: { httpStatusClass: '5xx' } });
  });

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

  it.each(['', 'a'.repeat(64), '_row', 'row-', 'row/value', 'row value'])(
    'rejects a correlation outside the documented label-value grammar before HTTP (%j)', async correlation => {
      const transport = vi.fn<typeof fetch>();
      const client = createHetznerNativeClient({ token: 'private', fetch: transport });
      await expect(client.acquire({ ...acquire, correlation })).rejects.toMatchObject({ code: 'native_input_invalid' });
      expect(transport).not.toHaveBeenCalled();
    });

  it('submits the valid 63-character label boundary without truncating correlation', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ server: { id: 41 } }, 201));
    const correlation = `a${'_.-'.repeat(20)}a1`;
    expect(correlation).toHaveLength(63);
    await createHetznerNativeClient({ token: 'private', fetch: transport }).acquire({ ...acquire, correlation });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).labels).toEqual({ 'happier-managed': correlation });
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
    expect(await client.acquire(acquire)).toMatchObject({ kind: 'bound', resource: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [9] } }, power: 'transitioning' });
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(body.user_data).toContain(acquire.bootstrapSshPublicKey.split(' ').slice(0, 2).join(' '));
    expect(body.user_data).toContain('"name":"happier-bootstrap"');
    expect(body).not.toHaveProperty('ssh_keys');
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
      .mockResolvedValueOnce(json({ server_types: [{ id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86',
        locations: [{ id: 1, name: 'fsn1', available: true, deprecation: null }],
        prices: [{ location: 'fsn1', price_hourly: { net: '0.0048', gross: '0.0057' }, price_monthly: { net: '2.99', gross: '3.56' } }] }], meta: { pagination: { next_page: null } } }))
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

  it.each(['present', 'unavailable'] as const)('does not settle empty server recovery while primary IP inventory is %s', async state => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ servers: [], meta: { pagination: { next_page: null } } }))
      .mockResolvedValueOnce(state === 'present'
        ? json({ primary_ips: [{ id: 9 }], meta: { pagination: { next_page: null } } })
        : json({ error: { code: 'unauthorized' } }, 401));
    const result = await createHetznerNativeClient({ token: 'private', fetch: transport }).recover('row-1');
    expect(result).toMatchObject({ kind: 'unknown', code: state === 'present' ? 'native_identity_not_found' : 'native_authorization_failed' });
    expect(transport.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('retains server and attachments while the native delete action runs', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ action: { id: 10, status: 'running' } }))
      .mockResolvedValueOnce(json({ server: { ...server, status: 'deleting' } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.destroy({ serverId: 41, owned: { volumeIds: [3], primaryIpIds: [9] } })).toMatchObject({
      kind: 'incomplete', remaining: [{ kind: 'server', id: 41 }, { kind: 'volume', id: 3 }, { kind: 'primary-ip', id: 9 }],
    });
    expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/servers/41']);
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
    expect(await client.acquire(acquire)).toMatchObject({ kind: 'bound', resource: { serverId: 41 } });
  });

  it('retains paid identity when accepted response readiness and network facts are incomplete', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: { id: 41 }, action: { id: 7, status: 'success' } }, 201));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    expect(await client.acquire(acquire)).toMatchObject({
      kind: 'bound', resource, power: 'unknown',
    });
  });

  it('retains attachment cleanup when deletion was only accepted asynchronously', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ action: { id: 10, status: 'success' } }))
      .mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404))
      .mockResolvedValueOnce(json({ volume: { id: 3 } }))
      .mockResolvedValueOnce(json({ action: { id: 11, status: 'running' } }, 202))
      .mockResolvedValueOnce(json({ volume: { id: 3 } }));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    const owned = { serverId: 41, owned: { volumeIds: [3], primaryIpIds: [] } };
    const result = await client.destroy({ ...owned, deleteActionId: 10 }, true);
    expect(result).toMatchObject({ kind: 'incomplete', remaining: [{ kind: 'volume', id: 3 }] });
    // Attachment continuation must not retain/re-poll the completed server action.
    expect(result.nativeOperation).toEqual(owned);
  });

  it('accepts a native RFC1123 name spanning multiple labels', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server, action: { id: 7, status: 'success' } }, 201));
    const client = createHetznerNativeClient({ token: 'private', fetch: transport });
    const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(await client.acquire({ ...acquire, name })).toMatchObject({ kind: 'bound', resource: { serverId: 41 } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).name).toBe(name);
  });
});
