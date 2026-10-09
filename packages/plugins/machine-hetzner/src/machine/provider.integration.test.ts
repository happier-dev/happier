import { describe, expect, it, vi } from 'vitest';
import { createHetznerProvider } from './provider.js';

const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
const acquire = { launch, name: 'work', correlation: 'row-1', bootstrapSshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest host' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function optionTransport(imageArchitecture: string | readonly string[]) {
  const architectures = typeof imageArchitecture === 'string' ? [imageArchitecture] : imageArchitecture;
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json({ server_types: [{ id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86', prices: [{ location: 'fsn1', price_hourly: { net: '0.0048', gross: '0.0057' }, price_monthly: { net: '2.99', gross: '3.56' } }] }], meta: { pagination: { next_page: null } } }))
    .mockResolvedValueOnce(json({ images: architectures.map((architecture, index) => ({ id: 2 + index, name: 'ubuntu-24.04', architecture, type: 'system', status: 'available', deprecated: null })), meta: { pagination: { next_page: null } } }))
    .mockResolvedValueOnce(json({ locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein' }], meta: { pagination: { next_page: null } } }))
    .mockResolvedValueOnce(json({ pricing: { currency: 'EUR' } }));
}

describe('Hetzner reviewed launch', () => {
  it('refuses incompatible image architecture before a purchase', async () => {
    const transport = optionTransport('arm');
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.acquire(acquire)).toEqual({ kind: 'rejected', code: 'native_options_changed' });
    expect(transport.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('revalidates native choices and binds the accepted resource without publishing enrollment', async () => {
    const transport = optionTransport('x86').mockResolvedValueOnce(json({ server: {
      id: 41, status: 'initializing', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null }, volumes: [],
    }, action: { id: 7, status: 'running' } }, 201));
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.acquire(acquire)).toMatchObject({ kind: 'bound', resource: { serverId: 41 }, power: 'transitioning' });
  });

  it('returns private connection facts only after exact running-server inspection', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: {
      id: 41, status: 'running', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null }, volumes: [],
    } }));
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.bootstrap({ serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } })).toEqual({
      kind: 'ssh', address: '192.0.2.1', port: 22, username: 'root',
    });
    expect(transport.mock.calls).toHaveLength(1);
  });

  it('uses the assigned first IPv6 host address rather than its subnet', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: {
      id: 41, status: 'running', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: null, ipv6: { id: 9, ip: '2001:db8:1234::/64' } }, volumes: [],
    } }));
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.bootstrap({ serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } })).toMatchObject({ address: '2001:db8:1234::1' });
  });

  it('refuses a launch with no qualified SSH route before purchase', async () => {
    const transport = optionTransport('x86').mockResolvedValueOnce(json({ server: {
      id: 41, status: 'initializing', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: null, ipv6: null }, volumes: [],
    }, action: { id: 7, status: 'running' } }, 201));
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.acquire({ ...acquire, launch: { ...launch, publicNetworking: { ipv4: false, ipv6: false } } })).toEqual({ kind: 'rejected', code: 'native_ssh_network_unavailable' });
    expect(transport.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('qualifies an image alias for the selected server architecture regardless of list order', async () => {
    const transport = optionTransport(['arm', 'x86']).mockResolvedValueOnce(json({ server: { id: 41 } }, 201));
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.acquire(acquire)).toMatchObject({ kind: 'bound', resource: { serverId: 41 } });
  });
});
