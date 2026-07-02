import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  type ScmHostingProviderRef,
} from '@happier-dev/protocol';
import { materializeGithubScmHostingToken } from '@happier-dev/plugins-scm-github';

import type { Credentials } from '@/persistence';

const { mockApiCreate, mockReadCredentials } = vi.hoisted(() => ({
  mockApiCreate: vi.fn(),
  mockReadCredentials: vi.fn(),
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mockApiCreate,
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: mockReadCredentials,
}));

import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';

type RuntimeServicesInput = Parameters<typeof createHostScmHostingProviderRuntimeServices>[0];

beforeEach(() => {
  mockApiCreate.mockReset();
  mockReadCredentials.mockReset();
});

function createTestCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

function createRuntimeInput(): RuntimeServicesInput {
  return {
    contributes: {
      scmHostingProviders: [],
      connectedAccountDescriptors: [],
    },
    scmHostingProvidersById: new Map([[
      'scm.github',
      {
        pluginId: 'scm-github',
        registration: {
          id: 'scm.github',
          adapter: {},
          auth: {
            tokenMaterializer: {
              serviceId: 'github',
              materialize: materializeGithubScmHostingToken,
            },
          },
        },
      },
    ]]),
  };
}

const githubProvider = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  urlSafety: { allowedSchemes: ['https:'] },
} satisfies ScmHostingProviderRef;

function createCredentialCiphertext(credentials: Credentials) {
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

  return sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: credentials.encryption,
    payload: record,
    randomBytes: (len) => new Uint8Array(len).fill(1),
  });
}

describe('createHostScmHostingProviderRuntimeServices', () => {
  it('reuses fresh connected-service credential records across SCM hosting materialization calls', async () => {
    const credentials = createTestCredentials();
    const ciphertext = createCredentialCiphertext(credentials);
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => ({
        profiles: [{ profileId: 'work' }],
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { ciphertext },
      })),
    };
    mockReadCredentials.mockResolvedValue(credentials);
    mockApiCreate.mockResolvedValue(api);

    const services = createHostScmHostingProviderRuntimeServices(createRuntimeInput());

    await expect(services.resolveScmHostingTokenMaterialization?.({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      provider: githubProvider,
    })).resolves.toMatchObject({
      kind: 'available',
      profileKey: 'github:work',
    });
    await expect(services.resolveScmHostingTokenMaterialization?.({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      provider: githubProvider,
    })).resolves.toMatchObject({
      kind: 'available',
      profileKey: 'github:work',
    });

    expect(mockReadCredentials).toHaveBeenCalledTimes(1);
    expect(mockApiCreate).toHaveBeenCalledTimes(1);
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent SCM hosting connected-service credential reads', async () => {
    const credentials = createTestCredentials();
    const ciphertext = createCredentialCiphertext(credentials);
    let releaseProfiles!: () => void;
    const profilesReady = new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    });
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => {
        await profilesReady;
        return {
          profiles: [{ profileId: 'work' }],
        };
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { ciphertext },
      })),
    };
    mockReadCredentials.mockResolvedValue(credentials);
    mockApiCreate.mockResolvedValue(api);

    const services = createHostScmHostingProviderRuntimeServices(createRuntimeInput());

    const first = services.resolveScmHostingTokenMaterialization?.({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      provider: githubProvider,
    });
    const second = services.resolveScmHostingTokenMaterialization?.({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      provider: githubProvider,
    });
    await vi.waitFor(() => {
      expect(api.listConnectedServiceProfiles).toHaveBeenCalledTimes(1);
    });
    releaseProfiles();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(mockReadCredentials).toHaveBeenCalledTimes(1);
    expect(mockApiCreate).toHaveBeenCalledTimes(1);
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });
});
