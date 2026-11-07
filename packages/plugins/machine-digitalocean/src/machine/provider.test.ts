import { describe, expect, it, vi } from 'vitest';
import { createDigitalOceanNativeClient } from './nativeClient.js';
import { createDigitalOceanProvider } from './provider.js';

const resource = { dropletId: 42, ownedVolumeIds: [] };
const droplet = { id: 42, name: 'managed-42', status: 'active', volume_ids: ['existing-volume'], tags: ['managed-42'], networks: { v4: [{ type: 'public', ip_address: '203.0.113.42' }], v6: [] } };
const action = (status: string) => ({ id: 9, status, type: 'create', resource_id: 42, resource_type: 'droplet' });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function boundary(replies: (Response | Error)[]) {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    // DigitalOcean REST v2 droplets/parameters.yml forbids these selectors together.
    if (url.pathname === '/v2/droplets' && url.searchParams.has('tag_name') && url.searchParams.has('type')) {
      return response({ id: 'bad_request' }, 400);
    }
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Unexpected native request');
    return next;
  });
}
const launch = { regionSlug: 'nyc3', sizeSlug: 's-1vcpu-1gb', imageId: 'ubuntu-24-04-x64', publicNetworking: { ipv6: false } };
const optionResponses = () => [
  response({ sizes: [{ slug: launch.sizeSlug, memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.00893, price_monthly: 6, regions: ['nyc3'], available: true }], links: {} }),
  response({ regions: [{ slug: 'nyc3', name: 'New York 3', available: true, sizes: [launch.sizeSlug] }], links: {} }),
  response({ images: [{ id: 1, slug: launch.imageId, name: 'Ubuntu', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {} }),
];

describe('DigitalOcean provider admission', () => {
  it('sends retained host-key bytes only to cloud-init and retains the exact Droplet for cleanup', async () => {
    const guestHostKey = { publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nretained-host-key\n-----END OPENSSH PRIVATE KEY-----\n' };
    const network = boundary([response({ droplet: { id: 42 } }, 202), new Response(null, { status: 204 }), response({}, 404)]);
    const options = { token: 'private-vendor-token', fetch: network, guestHostKey };
    const provider = createDigitalOceanProvider(options);
    const result = await provider.acquire({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' });
    expect(result).toEqual({ kind: 'bound', resource });
    const submitted = JSON.parse(String(network.mock.calls[0][1]?.body));
    const config = JSON.parse(submitted.user_data.slice('#cloud-config\n'.length));
    expect(config.ssh_keys).toEqual({ ed25519_private: guestHostKey.privateKey, ed25519_public: guestHostKey.publicKey });
    expect(JSON.stringify(result)).not.toMatch(/retained-host-key|private-vendor-token/);
    expect(await provider.destroy(resource)).toMatchObject({ kind: 'deleted', resource });
    expect(network.mock.calls.slice(1).map(([url]) => url)).toEqual([
      'https://api.digitalocean.com/v2/droplets/42', 'https://api.digitalocean.com/v2/droplets/42',
    ]);
  });
  it('keeps missing Droplet custody until every owned volume is absent', async () => {
    const owned = { ...resource, ownedVolumeIds: ['owned-volume'] };
    const network = boundary([response(null, 404), response({ volume: { id: 'owned-volume' } }),
      response(null, 404), response({ id: 'unauthorized' }, 401), response(null, 404), response(null, 404)]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    expect(await client.inspect(owned)).toMatchObject({ kind: 'unavailable', reason: 'cleanup-unconfirmed' });
    expect(await client.inspect(owned)).toMatchObject({ kind: 'unavailable', reason: 'authorization' });
    expect(await client.inspect(owned)).toEqual({ kind: 'absent', resource: owned });
    expect(network.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it('creates the reviewed launch directly, retaining accepted identity', async () => {
    const network = boundary([response({ droplet, links: { actions: [{ id: 9 }] } }, 202)]);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect(await provider.acquire({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'bound', resource });
    expect(network.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'custom', distribution: 'Ubuntu', slug: 'ubuntu-24-04-x64' },
    { type: 'base', distribution: 'Unknown', slug: 'windows-x64' },
    { type: 'base', distribution: 'FreeBSD', slug: 'freebsd-x64' },
    { type: 'snapshot', distribution: 'Ubuntu', slug: 'ubuntu-24-04-x64' },
  ])('omits a guest image without documented root cloud-init support from review: %j', async image => {
    const replies = optionResponses();
    replies[2] = response({ images: [{ id: 1, name: 'Guest', regions: ['nyc3'], status: 'available', ...image }], links: {} });
    const network = boundary(replies);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect((await provider.options()).dimensions.image).toEqual([]);
    expect(network.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('leaves release architecture detection to the installer instead of inferring it from an image slug', async () => {
    const replies = optionResponses();
    replies[2] = response({ images: [{ id: 1, name: 'Ubuntu', distribution: 'Ubuntu', type: 'base', slug: 'ubuntu-latest', regions: ['nyc3'], status: 'available' }], links: {} });
    const network = boundary([...replies, response({ droplet, links: { actions: [{ id: 9 }] } }, 202)]);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect((await provider.options()).dimensions.image).toMatchObject([{ id: '1', guestPlatform: 'linux' }]);
    expect(await provider.acquire({ launch: { ...launch, imageId: 1 }, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'bound', resource });
  });

  it('rejects undeclared acquire fields before discovery or purchase', async () => {
    const network = boundary([]);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    const input = { launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public', privateKey: 'private-content' };
    await expect(provider.acquire(input)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});

describe('DigitalOcean native Droplet contract', () => {
  it.each([
    [400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'],
    [409, 'conflict'], [422, 'unprocessable_entity'], [429, 'too_many_requests'],
  ])('preserves only documented native error identity for rejected creation (%s)', async (status, code) => {
    const client = createDigitalOceanNativeClient({ token: 'private-vendor-token', fetch: boundary([
      response({ id: code, message: 'private-vendor-token request content', request_id: 'private-request' }, status),
    ]) });
    expect(await client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' }))
      .toEqual({ kind: 'unavailable', reason: status === 401 || status === 403 ? 'authorization' : 'native-error', status,
        nativeCause: { httpStatusClass: '4xx', code } });
  });

  it('keeps status evidence for uncertain create without leaking unknown ids or non-JSON errors', async () => {
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: boundary([
      response({ id: 'server_error', message: 'private-body' }, 500),
      response({ id: 'private-vendor-token', message: 'private-body' }, 503),
      new Response('<html>private-body</html>', { status: 502 }),
    ]) });
    const input = { launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' };
    expect(await client.create(input)).toEqual({ kind: 'unknown', recoveryTag: 'managed-42', reason: 'native-error',
      nativeCause: { httpStatusClass: '5xx', code: 'server_error' } });
    for (let index = 0; index < 2; index += 1) expect(await client.create(input)).toEqual({
      kind: 'unknown', recoveryTag: 'managed-42', reason: 'native-error', nativeCause: { httpStatusClass: '5xx' },
    });
  });

  it('retains safe native failure evidence in check and paged options reads', async () => {
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: boundary([
      response({ id: 'forbidden', message: 'private' }, 403),
      response({ id: 'too_many_requests', message: 'private' }, 429),
    ]) });
    expect(await client.check()).toEqual({ available: false, code: 'authorization', nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } });
    expect(await client.options()).toEqual({ kind: 'unavailable', reason: 'native-error', status: 429,
      nativeCause: { httpStatusClass: '4xx', code: 'too_many_requests' } });
  });

  it('retains exact identity but waits for create action completion before bootstrap readiness', async () => {
    const network = boundary([
      response({ droplet, links: { actions: [{ id: 9, rel: 'create', href: 'https://api.digitalocean.com/v2/actions/9' }] } }, 202),
      response({ action: action('in-progress') }),
      response({ action: action('errored') }),
    ]);
    const client = createDigitalOceanNativeClient({ token: 'private-vendor-token', fetch: network });
    expect(await client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'bound', resource });
    expect(await client.observeAction(resource, 9)).toMatchObject({ kind: 'pending', resource });
    expect(await client.observeAction(resource, 9)).toMatchObject({ kind: 'failed', resource });
    const body = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ tags: ['managed-42'] });
    expect(body.user_data).toContain('"name":"happier-bootstrap"');
    expect(body).not.toHaveProperty('ssh_keys');
    expect(JSON.stringify(body)).not.toContain('private-vendor-token');
  });

  it('never retries a lost create response and qualifies unique recovery without choosing ambiguous candidates', async () => {
    const network = boundary([
      new TypeError('connection lost'),
      response({ droplets: [droplet], links: {} }),
      response({ droplets: [], links: {} }),
      response({ droplets: [droplet, { ...droplet, id: 43 }], links: {} }),
      response({ droplets: [], links: {} }),
    ]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    expect(await client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'unknown', recoveryTag: 'managed-42' });
    expect(network.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(await client.recover('managed-42')).toMatchObject({ kind: 'bound', resource });
    expect(await client.recover('managed-42')).toMatchObject({ kind: 'unknown', reason: 'ambiguous' });
  });

  it.each([
    { droplet, links: { actions: [{ id: 'invalid' }] } },
    { droplet: { id: 42 } },
    { droplet: { ...droplet, status: null, networks: { v4: 'unavailable' } } },
  ])('retains returned identity without treating malformed ancillary facts as readiness: %j', async body => {
    const network = boundary([response(body, 202), response(body)]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    expect(await client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' }))
      .toEqual({ kind: 'bound', resource });
    const inspection = await client.inspect(resource);
    expect(inspection).toMatchObject('name' in body.droplet && body.droplet.status !== null
      ? { kind: 'present', ready: true } : { kind: 'unavailable', reason: 'invalid-response', resource });
  });

  it.each([undefined, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1])('refuses invalid create identity %s', async id => {
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: boundary([response({ droplet: { ...droplet, id } }, 202)]) });
    expect(await client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' }))
      .toEqual({ kind: 'unknown', recoveryTag: 'managed-42', reason: 'invalid-response' });
  });

  it('distinguishes exact-id absence from authorization and transport failures, preserving off billing', async () => {
    const network = boundary([response({}, 404), response({}, 401), new TypeError('network'), response({ droplet: { ...droplet, status: 'off' } })]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    expect(await client.inspect(resource)).toMatchObject({ kind: 'absent', resource });
    expect(await client.inspect(resource)).toMatchObject({ kind: 'unavailable', reason: 'authorization' });
    expect(await client.inspect(resource)).toMatchObject({ kind: 'unavailable', reason: 'transport' });
    expect(await client.inspect(resource)).toMatchObject({ kind: 'present', power: 'stopped', stoppedBilling: 'billed', resource });
  });

  it('keeps native hourly and separately returned monthly prices, without hourly multiplication', async () => {
    const network = boundary([
      response({ sizes: [{ slug: 's5-8vcpu-16gb-30gb', memory: 16384, vcpus: 8, disk: 30, transfer: 1, price_hourly: 0.1953, price_monthly: null, regions: ['nyc3'], available: true }, { slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.00893, price_monthly: 6, regions: ['nyc3'], available: true }], links: {} }),
      response({ regions: [{ slug: 'nyc3', name: 'New York 3', available: true, sizes: ['s5-8vcpu-16gb-30gb', 's-1vcpu-1gb'] }], links: {} }),
      response({ images: [{ id: 1, slug: 'ubuntu-24-04-x64', name: 'Ubuntu', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {} }),
    ]);
    const result = await createDigitalOceanNativeClient({ token: 'token', fetch: network }).options();
    expect(result).toMatchObject({ kind: 'available', sizes: [{ prices: [{ amount: '0.1953', currency: 'USD', unit: 'hour' }], monthlyCap: null, monthlyCapStatus: 'none' }, { prices: [{ amount: '0.00893', unit: 'hour' }, { amount: '6', unit: 'month' }], monthlyCap: null, monthlyCapStatus: 'unknown' }] });
  });

  it('rejects an invalid runtime power intent without submitting a shutdown', async () => {
    const network = boundary([]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    // @ts-expect-error JS action ingress can supply an intent outside the typed union.
    await expect(client.power(resource, 'restart')).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it('observes shutdown action and exact resource rather than reporting stopped at submission', async () => {
    const network = boundary([response({ action: { ...action('in-progress'), type: 'shutdown' } }, 201)]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).power(resource, 'stop')).toMatchObject({ kind: 'pending', resource, actionId: 9 });
    expect(network.mock.calls[0][0]).toBe('https://api.digitalocean.com/v2/droplets/42/actions');
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual({ type: 'shutdown' });
  });

  it('deletes only exact Droplet and owned volumes, retaining incomplete cleanup after volume failure', async () => {
    const network = boundary([new Response(null, { status: 204 }), response({}, 404), response({ id: 'forbidden', message: 'private' }, 403)]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).destroy({ ...resource, ownedVolumeIds: ['owned-volume'] })).toMatchObject({ kind: 'incomplete', resource: { ...resource, ownedVolumeIds: ['owned-volume'] }, remainingVolumeIds: ['owned-volume'],
      nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } });
    expect(network.mock.calls.map(([url]) => url)).toEqual(['https://api.digitalocean.com/v2/droplets/42', 'https://api.digitalocean.com/v2/droplets/42', 'https://api.digitalocean.com/v2/volumes/owned-volume']);
  });

  it('refuses action evidence for another Droplet even when the action is completed', async () => {
    const network = boundary([response({ action: { ...action('completed'), resource_id: 43 } })]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).observeAction(resource, 9)).toMatchObject({ kind: 'unavailable', reason: 'resource-mismatch', resource });
  });

  it('waits for an active addressable exact resource after a completed create action', async () => {
    const network = boundary([response({ action: action('completed') }), response({ droplet: { ...droplet, status: 'new' } }), response({ action: action('completed') }), response({ droplet })]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    expect(await client.observeAction(resource, 9)).toMatchObject({ kind: 'pending', resource });
    expect(await client.observeAction(resource, 9)).toMatchObject({ kind: 'completed', resource, ready: true, ssh: { address: '203.0.113.42', user: 'happier-bootstrap' } });
  });

  it('does not forward the vendor bearer to an untrusted native pagination URL', async () => {
    const network = boundary([response({ droplets: [], links: { pages: { next: 'https://other.example/v2/droplets?page=2' } } })]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).recover('managed-42')).toMatchObject({ kind: 'unavailable', reason: 'invalid-pagination' });
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('qualifies recovery across all pages and ignores unrelated or duplicate identities', async () => {
    const network = boundary([
      response({ droplets: [{ ...droplet, id: 99, tags: ['unrelated'] }], links: { pages: { next: 'https://api.digitalocean.com/v2/droplets?tag_name=managed-42&page=2' } } }),
      response({ droplets: [droplet, droplet], links: {} }),
      response({ droplets: [{ ...droplet, id: 100, tags: ['managed-420'] }], links: { pages: { next: 'https://api.digitalocean.com/v2/droplets?type=gpus&page=2' } } }),
      response({ droplets: [droplet], links: {} }),
    ]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).recover('managed-42')).toMatchObject({ kind: 'bound', resource });
    expect(network).toHaveBeenCalledTimes(4);
  });

  it('checks the separate GPU Droplet listing before accepting a unique recovery match', async () => {
    const network = boundary([response({ droplets: [droplet], links: {} }), response({ droplets: [
      { ...droplet, id: 43 }, { ...droplet, id: 99, tags: ['unrelated'] },
    ], links: {} })]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).recover('managed-42')).toMatchObject({ kind: 'unknown', reason: 'ambiguous' });
    expect(String(network.mock.calls[1][0])).toContain('type=gpus');
  });

  it('recovers the unique exact-tag GPU Droplet from an unfiltered GPU inventory', async () => {
    const network = boundary([
      response({ droplets: [], links: {} }),
      response({ droplets: [{ ...droplet, id: 99, tags: ['managed-420'] }, droplet, { ...droplet, id: 100, tags: [] }], links: {} }),
    ]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).recover('managed-42'))
      .toEqual({ kind: 'bound', resource });
  });

  it('keeps cleanup incomplete until exact Droplet absence and never deletes discovered neighbors', async () => {
    const network = boundary([new Response(null, { status: 204 }), response({ droplet })]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).destroy(resource)).toMatchObject({ kind: 'incomplete', dropletAbsent: false });
    expect(network.mock.calls.map(([url]) => url)).toEqual(['https://api.digitalocean.com/v2/droplets/42', 'https://api.digitalocean.com/v2/droplets/42']);
  });

  it('proves owned-volume absence after delete acceptance', async () => {
    const network = boundary([new Response(null, { status: 204 }), response({}, 404), new Response(null, { status: 204 }), response({ volume: { id: 'owned-volume' } })]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).destroy({ ...resource, ownedVolumeIds: ['owned-volume'] })).toMatchObject({ kind: 'incomplete', dropletAbsent: true, remainingVolumeIds: ['owned-volume'] });
  });

  it('rejects a private key or injected cloud-config before any request', async () => {
    const network = boundary([]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    await expect(client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: '-----BEGIN OPENSSH PRIVATE KEY-----' })).rejects.toThrow();
    await expect(client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public\nruncmd: [evil]' })).rejects.toThrow();
    const extraInput = { launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public', user_data: 'private-content' };
    await expect(client.create(extraInput)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it('checks all native create evidence before returning a private bootstrap address', async () => {
    const network = boundary([response({ actions: [action('in-progress')], links: {} }), response({ droplet }),
      response({ actions: [action('completed')], links: {} }), response({ droplet })]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    expect(await client.observeResourceActions(resource)).toMatchObject({ kind: 'pending', resource });
    expect(await client.observeResourceActions(resource)).toMatchObject({ kind: 'present', resource, ready: true });
  });

  it.each([
    { actions: [] },
    { actions: [{ ...action('in-progress'), type: 'snapshot' }] },
    { actions: [action('completed'), { ...action('in-progress'), id: 10, type: 'shutdown' }] },
  ])('uses current running evidence without waiting for unrelated or missing historical actions: %j', async ({ actions }) => {
    const network = boundary([response({ actions, links: {} }), response({ droplet })]);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect(await provider.bootstrap(resource)).toMatchObject({ kind: 'present', resource, ready: true });
    expect(network.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});
