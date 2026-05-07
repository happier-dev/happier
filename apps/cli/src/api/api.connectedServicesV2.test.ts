import { describe, expect, it, vi, beforeEach } from 'vitest';

import axios from 'axios';
import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, get: mockGet },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
  },
}));

function createTestCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

describe('ApiClient connected services v2', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    vi.clearAllMocks();
  });

  it('posts sealed credentials to the v2 connected services endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());

    await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      metadata: { kind: 'oauth', providerEmail: 'user@example.com', expiresAt: Date.now() + 3600_000 },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('c2VhbGVk');
  });

  it('posts sealed quota snapshots to the v2 connected services quotas endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());

    await api.registerConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
      metadata: { fetchedAt: Date.now(), staleAfterMs: 300_000, status: 'ok' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('cXVvdGEtY2lwaGVydGV4dA==');
  });

  it('gets sealed quota snapshots from the v2 connected services quotas endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
        metadata: { fetchedAt: Date.now(), staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    const res = await api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(res?.sealed?.ciphertext).toBe('cXVvdGEtY2lwaGVydGV4dA==');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('resolves machine SCM credentials from the primary connected profile when multiple profiles are available', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'github-work-access-token',
        refreshToken: 'github-work-refresh-token',
        idToken: null,
        scope: 'repo read:user',
        tokenType: 'Bearer',
        providerAccountId: '42',
        providerEmail: 'work@example.com',
      },
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: createTestCredentials().encryption,
      payload: record,
      randomBytes: (len) => new Uint8Array(len).fill(1),
    });

    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/v2/connect/github/profiles/work/credential')) {
        return {
          status: 200,
          data: {
            sealed: { format: 'account_scoped_v1', ciphertext },
            metadata: {
              kind: 'oauth',
              providerEmail: 'work@example.com',
              providerAccountId: '42',
            },
          },
        };
      }

      if (url.includes('/v2/connect/github/profiles')) {
        return {
          status: 200,
          data: {
            serviceId: 'github',
            profiles: [
              { profileId: 'work', status: 'connected', kind: 'oauth' },
              { profileId: 'personal', status: 'connected', kind: 'token' },
            ],
          },
        };
      }

      return {
        status: 404,
        data: { error: 'connect_credential_not_found' },
      };
    });

    const api = await ApiClient.create(createTestCredentials());
    const resolver = (
      api as unknown as { createConnectedAccountCredentialResolver(): ScmConnectedAccountCredentialResolver }
    ).createConnectedAccountCredentialResolver();

    await expect(resolver.resolveCredential('github')).resolves.toMatchObject({
      serviceId: 'github',
      profileId: 'work',
      kind: 'oauth',
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(String(mockGet.mock.calls[0]?.[0])).toContain('/v2/connect/github/profiles');
    expect(String(mockGet.mock.calls[1]?.[0])).toContain('/v2/connect/github/profiles/work/credential');
  });
});
