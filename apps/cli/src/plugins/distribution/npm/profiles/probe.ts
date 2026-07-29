import type { PersistedNpmRegistryProfile } from '@/plugins/store/npmRegistries/store';

import {
  createNpmRegistryHttpsClient,
  NpmRegistryHttpError,
  type NpmRegistryHttpsClient,
} from '../httpsClient';

type CreateClient = (options: Readonly<{
  registryOrigin: string;
  authorizationHeader?: string;
  allowPrivateNetwork?: boolean;
}>) => NpmRegistryHttpsClient;

export function createNpmRegistryProfileProbe(options: Readonly<{
  createClient?: CreateClient;
}> = {}): (input: Readonly<{
  profile: PersistedNpmRegistryProfile;
  authorizationHeader?: string;
}>) => Promise<Readonly<{ status: 'available' | 'authentication_failed' | 'offline' }>> {
  const createClient = options.createClient ?? createNpmRegistryHttpsClient;
  return async ({ profile, authorizationHeader }) => {
    const client = createClient({
      registryOrigin: profile.origin,
      allowPrivateNetwork: profile.allowPrivateNetwork,
      ...(authorizationHeader ? { authorizationHeader } : {}),
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
