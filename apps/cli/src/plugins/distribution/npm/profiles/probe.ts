import type { PersistedNpmRegistryProfile } from '@/plugins/store/npmRegistries/store';

import { createNpmRegistryHttpsClient, NpmRegistryHttpError } from '../httpsClient';

export function createNpmRegistryProfileProbe(http: Pick<Parameters<typeof createNpmRegistryHttpsClient>[0], 'request' | 'lookup'> = {}): (input: Readonly<{
  profile: PersistedNpmRegistryProfile;
  authorizationHeader?: string;
  signal?: AbortSignal;
}>) => Promise<Readonly<{ status: 'available' | 'authentication_failed' | 'offline' }>> {
  return async ({ profile, authorizationHeader, signal }) => {
    const client = createNpmRegistryHttpsClient({
      ...http,
      registryOrigin: profile.origin,
      allowPrivateNetwork: profile.allowPrivateNetwork,
      ...(authorizationHeader ? { authorizationHeader } : {}),
      signal,
    });
    try {
      await client.getJson({
        url: `${profile.origin}/-/ping`,
        maxBytes: 64 * 1024,
        headers: { accept: 'application/json' },
      });
      return { status: 'available' };
    } catch (error) {
      return error instanceof NpmRegistryHttpError && error.code === 'authentication_failed'
        ? { status: 'authentication_failed' }
        : { status: 'offline' };
    }
  };
}
