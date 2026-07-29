import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionListResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const { axiosGetMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: axiosGetMock,
  },
  get: axiosGetMock,
}));

describe('sessionControl.sessionsHttp timeouts', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS']);

  afterEach(() => {
	    envScope.restore();
	    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS']);
	    vi.restoreAllMocks();
	    axiosGetMock.mockReset();
	    vi.resetModules();
	  });

  it('uses configuration.sessionControlHttpTimeoutMs for fetchSessionById and fetchSessionsPage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = '54321';

	    vi.resetModules();

	    axiosGetMock
	      // AxiosResponse typing is noisy; minimal stubs are sufficient for these timeout assertions.
	      .mockResolvedValueOnce({ status: 404, data: {} } as any)
      .mockResolvedValueOnce({ status: 200, data: createSessionListResponseFixture([]) } as any);

    const { fetchSessionById, fetchSessionsPage } = await import('./sessionsHttp');

    await expect(fetchSessionById({ token: 't', sessionId: 's1' })).resolves.toBeNull();
    await expect(fetchSessionsPage({ token: 't', limit: 1 })).resolves.toMatchObject({ sessions: [] });

	    expect(axiosGetMock).toHaveBeenCalledTimes(2);
	    expect(axiosGetMock.mock.calls[0]?.[1]?.timeout).toBe(54_321);
	    expect(axiosGetMock.mock.calls[1]?.[1]?.timeout).toBe(54_321);
	  });
});
