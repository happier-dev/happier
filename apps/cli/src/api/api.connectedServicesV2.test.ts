import { describe, expect, it, vi, beforeEach } from 'vitest';

import axios from 'axios';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import { readHttpStatus } from './client/httpStatusError';
import { storeConnectedServiceCredentialForAccount } from '@/cloud/connectedServices/storeConnectedServiceCredentialForAccount';

const { mockPost, mockGet, mockPatch, mockFetchServerFeaturesSnapshot } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
  mockFetchServerFeaturesSnapshot: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, get: mockGet, patch: mockPatch, isAxiosError: vi.fn(() => true) },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: mockFetchServerFeaturesSnapshot,
}));

vi.mock('./configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
  },
}));

describe('ApiClient connected services v2', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    mockFetchServerFeaturesSnapshot.mockReset();
    mockFetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        features: {},
        capabilities: {
          connectedServices: {
            credentialDelete: { revisionGuard: true },
          },
        },
      },
    });
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  it('posts sealed credentials to the v2 connected services endpoint', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: { success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const outcome = await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      metadata: { kind: 'oauth', providerEmail: 'user@example.com', expiresAt: Date.now() + 3600_000 },
    });

    expect(outcome).toEqual({
      success: true,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
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

    const serializedLogs = JSON.stringify((logger as any).debug.mock.calls);
    expect(serializedLogs).not.toContain('c2VhbGVk');
  });

  it('preserves a sanitized deterministic 400 so bounded storage does not settle or retry', async () => {
    const responseError = Object.assign(new Error('request rejected'), {
      response: {
        status: 400,
        data: { error: 'invalid-params', echoedSecret: 'server-secret-echo' },
      },
      config: {
        headers: { Authorization: 'Bearer happy-token' },
        data: 'sealed-request-secret',
      },
    });
    mockGet
      .mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }));
    mockPost.mockRejectedValue(responseError);

    const credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    };
    const api = await ApiClient.create(credentials);
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'provider-request-secret', providerAccountId: null, providerEmail: null },
    });

    let thrown: unknown;
    try {
      await storeConnectedServiceCredentialForAccount({ api, credentials, record });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: 'HttpStatusError', response: { status: 400 } });
    expect(readHttpStatus(thrown)).toBe(400);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain('happy-token');
    expect(serialized).not.toContain('provider-request-secret');
    expect(serialized).not.toContain('sealed-request-secret');
    expect(serialized).not.toContain('server-secret-echo');
  });

  it('does not expose the retired sealed connected-service quota writer', async () => {
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    expect('registerConnectedServiceQuotaSnapshotSealed' in api).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('preserves status, retry-after, and cause for failed sealed quota reads', async () => {
    const cause = {
      response: {
        status: 429,
        headers: { 'retry-after': '2' },
        data: { error: 'rate_limited' },
      },
    };
    mockGet.mockRejectedValue(cause);

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 2_000,
      cause,
    });
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect((logger.debug as any).mock.calls[0]?.[0]).toContain('temporarily unavailable');
    expect((logger.debug as any).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect((logger.debug as any).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'rate_limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 2_000,
      },
    });
  });

  it('gets sealed quota snapshots from the v2 connected services quotas endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
        metadata: { fetchedAt: Date.now(), staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

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

  it('gets connected service auth groups from the v3 endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        group: {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          displayName: 'Codex main',
          policy: { v: 1 },
          activeProfileId: 'work',
          generation: 3,
          runtimeStateRevision: 0,
          state: { status: 'ready', lastSwitchAt: null },
          createdAt: 1,
          updatedAt: 2,
          members: [
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'codex-main',
              profileId: 'work',
              priority: 1,
              enabled: true,
              state: { cooldownUntilMs: null },
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.getConnectedServiceAuthGroup({
      serviceId: 'openai-codex',
      groupId: 'codex-main',
    });

    expect(group?.activeProfileId).toBe('work');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/codex-main'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('uses the canonical v3 credential health endpoint', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRuntimeAuthFailureAt: 1_000,
      },
    });

    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential/health'),
      {
        health: {
          v: 1,
          status: 'needs_reauth',
          reconnectRequired: true,
          lastRuntimeAuthFailureAt: 1_000,
        },
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('sends owner ids when acquiring connected service refresh leases', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: {
        acquired: true,
        leaseUntil: 2_000,
        ownerId: 'machine-1:daemon-a',
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const lease = await api.acquireConnectedServiceRefreshLease({
      serviceId: 'openai-codex',
      profileId: 'work',
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
      leaseMs: 10_000,
    });

    expect(lease).toEqual({
      acquired: true,
      leaseUntil: 2_000,
      ownerId: 'machine-1:daemon-a',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/refresh-lease'),
      { machineId: 'machine-1', ownerId: 'machine-1:daemon-a', leaseMs: 10_000 },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('posts active-profile group updates with expected generation', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: {
        group: {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          displayName: 'Codex main',
          policy: { v: 1 },
          activeProfileId: 'backup',
          generation: 4,
          runtimeStateRevision: 0,
          state: { status: 'ready', lastSwitchAt: 10 },
          createdAt: 1,
          updatedAt: 2,
          members: [
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'codex-main',
              profileId: 'backup',
              priority: 2,
              enabled: true,
              state: { cooldownUntilMs: null },
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      activeProfileId: 'backup',
      expectedGeneration: 3,
    });

    expect(group.generation).toBe(4);
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/codex-main/active-profile'),
      expect.objectContaining({
        profileId: 'backup',
        expectedGeneration: 3,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('shares concurrent and fresh connected-service profile list requests', async () => {
    let resolveProfiles: ((value: unknown) => void) | undefined;
    mockGet.mockReturnValueOnce(new Promise((resolve) => {
      resolveProfiles = resolve;
    }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const first = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });
    const second = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });

    expect(mockGet).toHaveBeenCalledTimes(1);

    resolveProfiles?.({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'connected', status: 'connected', kind: 'oauth' }],
      },
    });

    await expect(first).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });
    await expect(second).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'fresh', status: 'connected', kind: 'oauth' }],
      },
    });

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('invalidates connected-service profile list cache after sealed credential writes', async () => {
    mockGet
      .mockResolvedValueOnce({
        status: 200,
        data: {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'old', status: 'connected', kind: 'oauth' }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new', status: 'connected', kind: 'oauth' }],
        },
      });
    mockPost.mockResolvedValue({
      status: 200,
      data: { success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'old' })],
    });

    await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'new',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
    });

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'new' })],
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
