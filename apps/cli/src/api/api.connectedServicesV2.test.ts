import { describe, expect, it, vi, beforeEach } from 'vitest';

import axios from 'axios';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';

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

describe('ApiClient connected services v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts sealed credentials to the v2 connected services endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

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

    const serializedLogs = JSON.stringify((logger as any).debug.mock.calls);
    expect(serializedLogs).not.toContain('c2VhbGVk');
  });

  it('posts sealed quota snapshots to the v2 connected services quotas endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

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

    const serializedLogs = JSON.stringify((logger as any).debug.mock.calls);
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
});
