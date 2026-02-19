import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { fetchSessionByIdCompat } from './sessionsHttp';

describe('sessionControl.sessionsHttp.fetchSessionByIdCompat', () => {
  it('falls back to scanning /v2/sessions pages when the single-session route is missing (404 Not found)', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 404,
        data: { error: 'Not found', path: '/v2/sessions/s1', method: 'GET' },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          sessions: [{ id: 's1', metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: 'dek' }],
          hasNext: false,
          nextCursor: null,
        },
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
});

