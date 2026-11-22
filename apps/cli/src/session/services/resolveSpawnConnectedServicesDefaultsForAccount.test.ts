import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ bootstrapAccountSettingsContext: vi.fn() }));
vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: mocks.bootstrapAccountSettingsContext,
}));

import type { Credentials } from '@/persistence';

import { resolveSpawnConnectedServicesDefaultsForAccount } from './resolveSpawnConnectedServicesDefaultsForAccount';

const credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) } } as unknown as Credentials;
const claude = { kind: 'builtInAgent', agentId: 'claude' } as const;

function defaultsFor(profileId: string) {
  return {
    settings: {
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          claude: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': { source: 'connected', selection: 'profile', profileId },
            },
          },
        },
      },
    },
  };
}

const apiWith = (profileIds: readonly string[]) => ({
  listConnectedServiceProfiles: vi.fn(async () => ({
    profiles: profileIds.map((profileId) => ({ profileId, status: 'connected' })),
  })),
});

describe('resolveSpawnConnectedServicesDefaultsForAccount', () => {
  beforeEach(() => mocks.bootstrapAccountSettingsContext.mockReset());

  it('uses the account default when its profile exists', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue(defaultsFor('Claude2'));

    const result = await resolveSpawnConnectedServicesDefaultsForAccount({
      credentials,
      backendTarget: claude,
      deps: { createApi: async () => apiWith(['Claude1', 'Claude2']) },
    });

    expect(result?.connectedServices.bindingsByServiceId['claude-subscription'])
      .toEqual({ source: 'connected', selection: 'profile', profileId: 'Claude2' });
  });

  it('falls back to native auth when the default names a profile that no longer exists', async () => {
    // Binding a new session to a profile that is gone left it committed to an account that can
    // never start. Native is what the app already shows for such a default.
    mocks.bootstrapAccountSettingsContext.mockResolvedValue(defaultsFor('Claude-2'));

    const result = await resolveSpawnConnectedServicesDefaultsForAccount({
      credentials,
      backendTarget: claude,
      deps: { createApi: async () => apiWith(['Claude1', 'Claude2']) },
    });

    expect(result).toBeNull();
  });

  it('keeps the default when the account profile list cannot be read, rather than guessing', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue(defaultsFor('Claude-2'));

    const result = await resolveSpawnConnectedServicesDefaultsForAccount({
      credentials,
      backendTarget: claude,
      deps: { createApi: async () => { throw new Error('offline'); } },
    });

    expect(result?.connectedServices.bindingsByServiceId['claude-subscription'])
      .toEqual({ source: 'connected', selection: 'profile', profileId: 'Claude-2' });
  });
});
