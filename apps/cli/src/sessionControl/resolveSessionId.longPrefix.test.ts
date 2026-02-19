import { describe, expect, it, vi } from 'vitest';

const { mockAxiosGet } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
}));

vi.mock('axios', async () => {
  return {
    default: {
      get: mockAxiosGet,
      post: vi.fn(),
    },
  };
});

describe('resolveSessionIdOrPrefix', () => {
  it('falls back to prefix paging when a long id-or-prefix is not an exact session id', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/sess_integration')) {
        return { status: 404, data: {}, headers: {} };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [{ id: 'sess_integration_run_start_123' }],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'sess_integration',
      });

      expect(res).toEqual({ ok: true, sessionId: 'sess_integration_run_start_123' });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });
});

