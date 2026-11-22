import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceCredentialResolutionError } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';

import {
  ConnectedServiceProfileMissingError,
  classifyMissingConnectedServiceProfile,
  dropConnectedBindingsToMissingProfiles,
  resolveCredentialsClassifyingMissingProfile,
} from './classifyMissingConnectedServiceProfile';

const missingCredential = () => new ConnectedServiceCredentialResolutionError({
  serviceId: 'claude-subscription',
  profileId: 'Claude-2',
});

function api(profileIds: readonly string[] | Error) {
  return {
    listConnectedServiceProfiles: vi.fn(async () => {
      if (profileIds instanceof Error) throw profileIds;
      return { serviceId: 'claude-subscription', profiles: profileIds.map((profileId) => ({ profileId, status: 'connected' })) };
    }),
  };
}

describe('classifyMissingConnectedServiceProfile', () => {
  it('reports a profile that no longer exists as missing, not as needing a reconnect', async () => {
    const result = await classifyMissingConnectedServiceProfile({ api: api(['Claude1', 'Claude2']), error: missingCredential() });

    expect(result).toBeInstanceOf(ConnectedServiceProfileMissingError);
    expect(result).toMatchObject({ kind: 'profile_missing', serviceId: 'claude-subscription', profileId: 'Claude-2' });
  });

  it('keeps the original error when the profile still exists but its credential is missing', async () => {
    const original = missingCredential();

    const result = await classifyMissingConnectedServiceProfile({ api: api(['Claude-2', 'Claude2']), error: original });

    expect(result).toBe(original);
  });

  it('keeps the original error when the profile list cannot be read, rather than guessing', async () => {
    const original = missingCredential();

    const result = await classifyMissingConnectedServiceProfile({ api: api(new Error('offline')), error: original });

    expect(result).toBe(original);
  });

  it('passes unrelated errors through untouched without calling the server', async () => {
    const unrelated = new Error('something else');
    const client = api(['Claude2']);

    const result = await classifyMissingConnectedServiceProfile({ api: client, error: unrelated });

    expect(result).toBe(unrelated);
    expect(client.listConnectedServiceProfiles).not.toHaveBeenCalled();
  });
});

describe('resolveCredentialsClassifyingMissingProfile', () => {
  it('returns the resolved credentials untouched when the lookup succeeds', async () => {
    const client = api(['Claude2']);

    await expect(resolveCredentialsClassifyingMissingProfile({ api: client, resolve: async () => 'resolved' }))
      .resolves.toBe('resolved');
    expect(client.listConnectedServiceProfiles).not.toHaveBeenCalled();
  });

  it('rejects with the profile-missing error when the bound profile no longer exists', async () => {
    await expect(resolveCredentialsClassifyingMissingProfile({
      api: api(['Claude1', 'Claude2']),
      resolve: async () => { throw missingCredential(); },
    })).rejects.toBeInstanceOf(ConnectedServiceProfileMissingError);
  });

  it('rejects with the original error when the profile exists', async () => {
    const original = missingCredential();

    await expect(resolveCredentialsClassifyingMissingProfile({
      api: api(['Claude-2']),
      resolve: async () => { throw original; },
    })).rejects.toBe(original);
  });
});

describe('dropConnectedBindingsToMissingProfiles', () => {
  it('replaces a profile binding whose profile is gone with native and reports it', async () => {
    const result = await dropConnectedBindingsToMissingProfiles({
      api: api(['Claude1', 'Claude2']),
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'Claude-2' },
        },
      },
    });

    expect(result.bindings.bindingsByServiceId['claude-subscription']).toEqual({ source: 'native' });
    expect(result.dropped).toEqual([{ serviceId: 'claude-subscription', profileId: 'Claude-2' }]);
  });

  it('leaves existing profile bindings, native bindings and pool bindings alone', async () => {
    const bindings = {
      v: 1 as const,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'Claude2' },
        anthropic: { source: 'native' as const },
        'openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'pool' },
      },
    };

    const result = await dropConnectedBindingsToMissingProfiles({ api: api(['Claude2']), bindings });

    expect(result.bindings).toEqual(bindings);
    expect(result.dropped).toEqual([]);
  });
});
