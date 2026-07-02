import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';

const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./configuration', () => ({
  configuration: {
    apiServerUrl: 'https://api.example.com',
  },
}));

describe('ApiClient connected services v3 credentials', () => {
  beforeEach(() => {
    mockPost.mockReset();
    vi.clearAllMocks();
  });

  it('posts plaintext credentials without logging credential secrets', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        content: { t: 'plain', v: record },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });
});
