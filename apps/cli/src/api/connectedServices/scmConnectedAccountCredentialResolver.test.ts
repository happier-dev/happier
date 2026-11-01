import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import { createScmConnectedAccountCredentialResolver } from './scmConnectedAccountCredentialResolver';

function createTestCredentials() {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  } satisfies Credentials;
}

function createSealedGithubCredential(credentials: ReturnType<typeof createTestCredentials>) {
  const record = buildConnectedServiceCredentialRecord({
    now: 1_000,
    serviceId: 'github',
    profileId: 'work',
    kind: 'token',
    token: {
      token: 'ghp_test',
      providerAccountId: '42',
      providerEmail: null,
    },
  });

  return {
    record,
    ciphertext: sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: credentials.encryption,
      payload: record,
      randomBytes: (len) => new Uint8Array(len).fill(1),
    }),
  };
}

describe('createScmConnectedAccountCredentialResolver', () => {
  it('reuses a fresh resolved SCM credential instead of rereading profiles and credential payloads', async () => {
    const credentials = createTestCredentials();
    const { record, ciphertext } = createSealedGithubCredential(credentials);
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'github' as const,
        profiles: [
          { profileId: 'work', status: 'connected' as const, kind: 'token' as const },
        ],
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: { kind: 'token' as const },
      })),
    } as unknown as ApiClient;

    const resolver = createScmConnectedAccountCredentialResolver({
      credentials,
      api,
    });

    await expect(resolver.resolveCredential('github')).resolves.toMatchObject({
      serviceId: record.serviceId,
      profileId: record.profileId,
      kind: record.kind,
    });
    await expect(resolver.resolveCredential('github')).resolves.toMatchObject({
      serviceId: record.serviceId,
      profileId: record.profileId,
      kind: record.kind,
    });

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent SCM credential resolutions for the same service', async () => {
    const credentials = createTestCredentials();
    const { ciphertext } = createSealedGithubCredential(credentials);
    let releaseProfiles!: () => void;
    const profilesReady = new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    });
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => {
        await profilesReady;
        return {
          serviceId: 'github' as const,
          profiles: [
            { profileId: 'work', status: 'connected' as const, kind: 'token' as const },
          ],
        };
      }),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: { kind: 'token' as const },
      })),
    } as unknown as ApiClient;

    const resolver = createScmConnectedAccountCredentialResolver({
      credentials,
      api,
    });

    const first = resolver.resolveCredential('github');
    const second = resolver.resolveCredential('github');
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledTimes(1);
    releaseProfiles();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });
});
