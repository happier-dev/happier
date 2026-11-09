import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { resolveManagedGuestHome } from './homeQualification';

// OS resolver IO is the boundary: the real descriptor/carrier owner stays loaded.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe('managed guest Home resolution', () => {
  it('uses the controller resolver for the descriptor-selected non-loopback carrier', async () => {
    const target = resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
      v: 1, homeServerIdentityId: 'srv_home', revision: 1, canonicalServerUrl: 'https://canonical.example.test',
      endpoints: [{ kind: 'https', url: 'https://localhost:9443' },
        { kind: 'https', url: 'https://home.example.test:9443' }],
    } });
    vi.mocked(lookup).mockResolvedValue([{ address: '100.64.0.5', family: 4 }, { address: 'fd00::5', family: 6 }]);
    expect(await resolveManagedGuestHome(target)).toEqual({ origin: 'https://home.example.test:9443',
      addresses: ['100.64.0.5', 'fd00::5'] });
    expect(lookup).toHaveBeenCalledWith('home.example.test', { all: true });
  });

  it('leaves carrier availability to enrollment when the controller cannot resolve a declared fallback', async () => {
    const target = resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
      v: 1, homeServerIdentityId: 'srv_home', revision: 1, canonicalServerUrl: 'https://home.example.test',
      endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
    } });
    vi.mocked(lookup).mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    expect(await resolveManagedGuestHome(target)).toEqual({ origin: 'https://home.example.test', addresses: [] });
  });
});
