import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import {
  createSessionListResponseFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';

import { fetchSessionById, fetchSessionByIdCompat } from './sessionsHttp';

describe('sessionControl.sessionsHttp.fetchSessionByIdCompat', () => {
  it.each([fetchSessionById, fetchSessionByIdCompat])('rejects an inactive detail response for a different Session (%#)', async readSession => {
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200, data: { session: createSessionRecordFixture({ id: 'different-session', active: false }) },
    });
    try {
      await expect(readSession({ token: 'token', sessionId: 'requested-session', reason: 'prompt-dispatch-boundary' }))
        .rejects.toThrow();
    } finally { get.mockRestore(); }
  });

  it('surfaces HTTP 426 as a typed terminal upgrade requirement', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 426,
      data: {
        error: 'client-upgrade-required',
        requirement: {
          v: 1,
          clientKind: 'session-runner',
          minimumAppVersion: '9.0.0',
          updateUrl: null,
        },
      },
    } as any);

    await expect(fetchSessionByIdCompat({ token: 't', sessionId: 's1' })).rejects.toMatchObject({
      name: 'CliClientUpgradeRequiredError',
      statusCode: 426,
    });
  });

  it('sends a structured request-purpose header when a session detail reason is provided', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: { session: createSessionRecordFixture({ id: 's1', metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: 'dek' }) },
    } as any);

    await expect(fetchSessionByIdCompat({
      token: 't',
      sessionId: 's1',
      reason: 'prompt-dispatch-boundary',
    })).resolves.toMatchObject({ id: 's1' });

    expect(getSpy).toHaveBeenCalledWith(expect.stringContaining('/v2/sessions/s1'), expect.objectContaining({
      headers: expect.objectContaining({
        'X-Happier-Request-Purpose': 'session-detail:prompt-dispatch-boundary',
      }),
    }));
  });

  it('sends a structured legacy request-purpose header when no explicit reason is provided', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: { session: createSessionRecordFixture({ id: 's1', metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: 'dek' }) },
    } as any);

    await expect(fetchSessionByIdCompat({ token: 't', sessionId: 's1' })).resolves.toMatchObject({ id: 's1' });

    expect(getSpy).toHaveBeenCalledWith(expect.stringContaining('/v2/sessions/s1'), expect.objectContaining({
      headers: expect.objectContaining({
        'X-Happier-Request-Purpose': 'session-detail:legacy-compat-proof',
      }),
    }));
  });

  it('falls back to scanning /v2/sessions pages when the single-session route is missing (404 Not found)', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 404,
        data: { error: 'Not found', path: '/v2/sessions/s1', method: 'GET' },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: createSessionListResponseFixture([
          createSessionRecordFixture({ id: 's1', metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: 'dek' }),
        ]),
      } as any);

    const res = await fetchSessionByIdCompat({ token: 't', sessionId: 's1' });
    expect(res).toMatchObject({ id: 's1', dataEncryptionKey: 'dek' });

    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain('/v2/sessions/s1');
    expect(String(getSpy.mock.calls[1]?.[0])).toContain('/v2/sessions');
  });

  it('does not scan /v2/sessions when the session is missing (404 Session not found)', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 404,
      data: { error: 'Session not found' },
    } as any);

    const res = await fetchSessionByIdCompat({ token: 't', sessionId: 's1' });
    expect(res).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain('/v2/sessions/s1');
  });

  it('throws on malformed /v2/sessions payload when scanning fallback route', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({ status: 404, data: { error: 'Not found', path: '/v2/sessions/s1', method: 'GET' } } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { sessions: [{ id: 's1' }], nextCursor: null, hasNext: false },
      } as any);

    await expect(fetchSessionByIdCompat({ token: 't', sessionId: 's1' })).rejects.toThrow('Unexpected /v2/sessions response shape');
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('continues scanning beyond 20 pages when the compat fallback session appears later', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 404,
      data: { error: 'Not found', path: '/v2/sessions/s-final', method: 'GET' },
    } as any);

    for (let page = 0; page < 21; page += 1) {
      getSpy.mockResolvedValueOnce({
        status: 200,
        data: createSessionListResponseFixture(
          page === 20 ? [createSessionRecordFixture({ id: 's-final', metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: 'dek' })] : [],
          {
            nextCursor: page === 20 ? null : `cursor-${page + 1}`,
            hasNext: page !== 20,
          },
        ),
      } as any);
    }

    const res = await fetchSessionByIdCompat({ token: 't', sessionId: 's-final' });
    expect(res).toMatchObject({ id: 's-final', dataEncryptionKey: 'dek' });
    expect(getSpy).toHaveBeenCalledTimes(22);
  });
});
