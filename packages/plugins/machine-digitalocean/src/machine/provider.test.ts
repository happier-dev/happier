import { describe, expect, it, vi } from 'vitest';
import { createDigitalOceanNativeClient } from './nativeClient.js';
import { createDigitalOceanProvider } from './provider.js';

const resource = { dropletId: 42, ownedVolumeIds: [] };
const droplet = { id: 42, name: 'managed-42', status: 'active', volume_ids: ['existing-volume'], tags: ['managed-42'], networks: { v4: [{ type: 'public', ip_address: '203.0.113.42' }], v6: [] } };
const action = (status: string) => ({ id: 9, status, type: 'create', resource_id: 42, resource_type: 'droplet' });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function boundary(replies: (Response | Error)[]) {
  return vi.fn<typeof fetch>(async () => {
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
  it('revalidates launch against native options before an effect and refuses an unavailable recipe', async () => {
    const network = boundary(optionResponses());
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect(await provider.acquire({ launch: { ...launch, sizeSlug: 'removed-size' }, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'rejected', reason: 'launch-unavailable' });
    expect(network.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('creates only after native availability is verified, retaining accepted identity', async () => {
    const network = boundary([...optionResponses(), response({ droplet, links: { actions: [{ id: 9 }] } }, 202)]);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect(await provider.acquire({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'bound', resource, ready: false });
    expect(network.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { type: 'custom', distribution: 'Ubuntu', slug: 'ubuntu-24-04-x64' },
    { type: 'base', distribution: 'Unknown', slug: 'windows-x64' },
    { type: 'base', distribution: 'FreeBSD', slug: 'freebsd-x64' },
    { type: 'snapshot', distribution: 'Ubuntu', slug: 'ubuntu-24-04-x64' },
  ])('refuses a guest image without documented root cloud-init support: %j', async image => {
    const replies = optionResponses();
    replies[2] = response({ images: [{ id: 1, name: 'Guest', regions: ['nyc3'], status: 'available', ...image }], links: {} });
    const network = boundary(replies);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect(await provider.acquire({ launch: { ...launch, imageId: 1 }, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'rejected', reason: 'launch-unavailable' });
    expect(network.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('leaves release architecture detection to the installer instead of inferring it from an image slug', async () => {
    const replies = optionResponses();
    replies[2] = response({ images: [{ id: 1, name: 'Ubuntu', distribution: 'Ubuntu', type: 'base', slug: 'ubuntu-latest', regions: ['nyc3'], status: 'available' }], links: {} });
    const network = boundary([...replies, response({ droplet, links: { actions: [{ id: 9 }] } }, 202)]);
    const provider = createDigitalOceanProvider({ token: 'token', fetch: network });
    expect(await provider.acquire({ launch: { ...launch, imageId: 1 }, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'bound', resource, ready: false });
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
  it('retains exact identity but waits for create action completion before bootstrap readiness', async () => {
    const network = boundary([
      response({ droplet, links: { actions: [{ id: 9, rel: 'create', href: 'https://api.digitalocean.com/v2/actions/9' }] } }, 202),
      response({ action: action('in-progress') }),
      response({ action: action('errored') }),
    ]);
    const client = createDigitalOceanNativeClient({ token: 'private-vendor-token', fetch: network });
    expect(await client.create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'bound', resource, actionIds: [9], ready: false });
    expect(await client.observeAction(resource, 9)).toMatchObject({ kind: 'pending', resource });
    expect(await client.observeAction(resource, 9)).toMatchObject({ kind: 'failed', resource });
    const body = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ tags: ['managed-42'] });
    expect(body.user_data).toBe('#cloud-config\nssh_authorized_keys:\n  - "ssh-ed25519 public"\n');
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

  it('retains a returned Droplet identity even if native action references are malformed', async () => {
    const network = boundary([response({ droplet, links: { actions: [{ id: 'invalid' }] } }, 202)]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).create({ launch, name: 'managed-42', recoveryTag: 'managed-42', bootstrapSshPublicKey: 'ssh-ed25519 public' })).toMatchObject({ kind: 'bound', resource, ready: false });
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
    const network = boundary([new Response(null, { status: 204 }), response({}, 404), response({}, 403)]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).destroy({ ...resource, ownedVolumeIds: ['owned-volume'] })).toMatchObject({ kind: 'incomplete', resource: { ...resource, ownedVolumeIds: ['owned-volume'] }, remainingVolumeIds: ['owned-volume'] });
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
    expect(await client.observeAction(resource, 9)).toMatchObject({ kind: 'completed', resource, ready: true, ssh: { address: '203.0.113.42', user: 'root' } });
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
      response({ droplets: [], links: {} }),
    ]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).recover('managed-42')).toMatchObject({ kind: 'bound', resource });
    expect(network).toHaveBeenCalledTimes(3);
  });

  it('checks the separate GPU Droplet listing before accepting a unique recovery match', async () => {
    const network = boundary([response({ droplets: [droplet], links: {} }), response({ droplets: [{ ...droplet, id: 43 }], links: {} })]);
    expect(await createDigitalOceanNativeClient({ token: 'token', fetch: network }).recover('managed-42')).toMatchObject({ kind: 'unknown', reason: 'ambiguous' });
    expect(String(network.mock.calls[1][0])).toContain('type=gpus');
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
    const network = boundary([response({ actions: [action('in-progress')], links: {} }), response({ actions: [action('completed')], links: {} }), response({ droplet })]);
    const client = createDigitalOceanNativeClient({ token: 'token', fetch: network });
    expect(await client.observeResourceActions(resource)).toMatchObject({ kind: 'pending', resource });
    expect(await client.observeResourceActions(resource)).toMatchObject({ kind: 'present', resource, ready: true });
  });
});
