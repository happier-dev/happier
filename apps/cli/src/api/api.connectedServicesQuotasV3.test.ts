import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('ApiClient connected services quotas v3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gets the account encryption mode from /v1/account/encryption', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const mode = await (api as any).getAccountEncryptionMode();
    expect(mode).toBe('plain');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/account/encryption'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('gets plaintext quota snapshots from the v3 connected services quotas endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: {
          t: 'plain',
          v: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 300_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
          },
        },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const res = await (api as any).getConnectedServiceQuotaSnapshotPlain({ serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.content?.v?.serviceId).toBe('openai-codex');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('posts plaintext quota snapshots to the v3 connected services quotas endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await (api as any).registerConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: {
        t: 'plain',
        v: {
          v: 1,
          serviceId: 'openai-codex',
          profileId: 'work',
          fetchedAt: Date.now(),
          staleAfterMs: 300_000,
          planLabel: null,
          accountLabel: null,
          meters: [],
        },
      },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/quotas'),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify((logger as any).debug.mock.calls);
    expect(serializedLogs).not.toContain('staleAfterMs');
  });
});

