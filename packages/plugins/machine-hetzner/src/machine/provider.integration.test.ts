import { describe, expect, it, vi } from 'vitest';
import { createHetznerProvider } from './provider.js';

const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
const acquire = { launch, name: 'work', correlation: 'row-1', bootstrapSshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest host' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe('Hetzner reviewed launch', () => {
  it('installs the retained guest host key through early cloud-init without returning its private material', async () => {
    const guestHostKey = { publicKey: 'ssh-ed25519 AQIDBA==', privateKey: 'fixture-private-host-key' };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: {
      id: 41, status: 'initializing', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null },
    } }, 201));
    const provider = createHetznerProvider({ token: 'private', fetch: transport, guestHostKey });
    const result = await provider.acquire(acquire);
    expect(result).toMatchObject({ kind: 'bound', resource: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [9] } } });
    const create = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
    const cloudInit = JSON.parse(create.user_data.replace(/^#cloud-config\n/, ''));
    expect(cloudInit.ssh_keys).toEqual({ ed25519_private: guestHostKey.privateKey, ed25519_public: guestHostKey.publicKey });
    expect(cloudInit.users[0].ssh_authorized_keys).toEqual([acquire.bootstrapSshPublicKey.split(' ').slice(0, 2).join(' ')]);
    expect(cloudInit.runcmd).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(guestHostKey.privateKey);
  });
  it('submits native selectors directly and binds the accepted resource without publishing enrollment', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: {
      id: 41, status: 'initializing', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null }, volumes: [],
    }, action: { id: 7, status: 'running' } }, 201));
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.acquire(acquire)).toMatchObject({ kind: 'bound', resource: { serverId: 41 }, power: 'transitioning' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toMatchObject({
      server_type: launch.serverTypeId, image: launch.imageId, location: launch.locationId,
    });
  });

  it('returns private connection facts only after exact running-server inspection', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ server: {
      id: 41, status: 'running', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null }, volumes: [],
    } }));
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.bootstrap({ serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } })).toEqual({
      kind: 'ssh', address: '192.0.2.1', port: 22, username: 'happier-bootstrap',
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
    const transport = vi.fn<typeof fetch>();
    const provider = createHetznerProvider({ token: 'private', fetch: transport });
    expect(await provider.acquire({ ...acquire, launch: { ...launch, publicNetworking: { ipv4: false, ipv6: false } } })).toEqual({ kind: 'rejected', code: 'native_ssh_network_unavailable', nativeCause: { localCause: 'native_ssh_network_unavailable' } });
    expect(transport).not.toHaveBeenCalled();
  });
});
