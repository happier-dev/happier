import { describe, expect, it, vi } from 'vitest';

import { NpmRegistryHttpError } from '../httpsClient';
import { createNpmRegistryProfileProbe } from './probe';

const profile = {
  profileId: 'registry_acme', displayName: 'Acme', origin: 'https://registry.acme.test', scopes: ['@acme'],
  useAsDefault: false, allowPrivateNetwork: true, credentialSecretRef: null, credentialRevision: 0,
  availability: 'unknown' as const, lastSuccessfulCheckAtMs: null, updatedAtMs: 1,
};

describe('npm registry profile probe', () => {
  it('checks the selected origin with ephemeral authorization and private-network policy', async () => {
    const getJson = vi.fn(async () => ({ ok: true }));
    const createClient = vi.fn(() => ({
      getJson,
      getBody: async () => { throw new Error('not used by the profile probe'); },
    }));
    const probe = createNpmRegistryProfileProbe({ createClient });
    await expect(probe({ profile, authorizationHeader: 'Bearer boundary-secret' })).resolves.toEqual({ status: 'available' });
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      registryOrigin: profile.origin,
      authorizationHeader: 'Bearer boundary-secret',
      allowPrivateNetwork: true,
    }));
    expect(getJson).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://registry.acme.test/-/ping' }));
  });

  it('classifies only typed authentication failures as authentication failures', async () => {
    const authProbe = createNpmRegistryProfileProbe({
      createClient: () => ({
        getJson: async () => { throw new NpmRegistryHttpError(401); },
        getBody: async () => { throw new Error('not used by the profile probe'); },
      }),
    });
    await expect(authProbe({ profile })).resolves.toEqual({ status: 'authentication_failed' });

    const offlineProbe = createNpmRegistryProfileProbe({
      createClient: () => ({
        getJson: async () => { throw new Error('network down'); },
        getBody: async () => { throw new Error('not used by the profile probe'); },
      }),
    });
    await expect(offlineProbe({ profile })).resolves.toEqual({ status: 'offline' });
  });
});
