import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { resolveManagedGuestHome } from './homeQualification';

// OS resolver IO is the boundary: the real descriptor/carrier owner stays loaded.
// Typed to the all-addresses overload the owner calls; vi.mocked(lookup) would select the single-address overload.
const { lookupAll } = vi.hoisted(() => ({ lookupAll: vi.fn<(hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>>() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupAll }));

beforeEach(() => vi.resetAllMocks());

describe('managed guest Home resolution', () => {
  it('gives a native Docker guest the declared tailnet ingress rather than the controller canonical URL', async () => {
    const target = resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
      v: 1, homeServerIdentityId: 'srv_home', revision: 4,
      canonicalServerUrl: 'http://happier-agent-qa-servers-deploy.localhost:3033',
      endpoints: [{ kind: 'https', url: 'https://nldw3-5-36-33.tailfce179.ts.net:9443' }],
    } });
    lookupAll.mockResolvedValue([{ address: '100.118.114.5', family: 4 }]);
    const hostIdentity = { homeMachineHost: 'home-host', controllerMachineHost: 'controller-host' };
    expect(await resolveManagedGuestHome(target, hostIdentity)).toEqual({
      origin: 'https://nldw3-5-36-33.tailfce179.ts.net:9443', addresses: ['100.118.114.5'],
      hostIdentity,
    });
  });
  it('uses the controller resolver for the descriptor-selected non-loopback carrier', async () => {
    const target = resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
      v: 1, homeServerIdentityId: 'srv_home', revision: 1, canonicalServerUrl: 'https://canonical.example.test',
      endpoints: [{ kind: 'https', url: 'https://localhost:9443' },
        { kind: 'https', url: 'https://home.example.test:9443' }],
    } });
    lookupAll.mockResolvedValue([{ address: '100.64.0.5', family: 4 }, { address: 'fd00::5', family: 6 }]);
    expect(await resolveManagedGuestHome(target)).toEqual({ origin: 'https://home.example.test:9443',
      addresses: ['100.64.0.5', 'fd00::5'] });
    expect(lookupAll).toHaveBeenCalledWith('home.example.test', { all: true });
  });

  it('leaves carrier availability to enrollment when the controller cannot resolve a declared fallback', async () => {
    const target = resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
      v: 1, homeServerIdentityId: 'srv_home', revision: 1, canonicalServerUrl: 'https://home.example.test',
      endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
    } });
    lookupAll.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    expect(await resolveManagedGuestHome(target)).toEqual({ origin: 'https://home.example.test', addresses: [] });
  });
});
