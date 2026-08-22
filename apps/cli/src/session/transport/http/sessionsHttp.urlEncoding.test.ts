import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionsHttp URL encoding', () => {
  const envKeys = ['HAPPIER_SERVER_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('encodes sessionId path segments for fetchSessionById', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { fetchSessionById } = await import('./sessionsHttp');

    const sessionId = 'sess/../?x=1';
    const encoded = encodeURIComponent(sessionId);

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} } as any);
    await expect(fetchSessionById({ token: 't', sessionId })).resolves.toBeNull();

    expect(getSpy).toHaveBeenCalledWith(
      `http://server.example.test/v2/sessions/${encoded}`,
      expect.any(Object),
    );
  });

  it('encodes sessionId path segments for commitSessionStoredMessage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { commitSessionStoredMessage } = await import('./sessionsHttp');

    const sessionId = 'sess/../?x=1';
    const encoded = encodeURIComponent(sessionId);

    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 500, data: {} } as any);

    await expect(
      commitSessionStoredMessage({
        token: 't',
        sessionId,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
        localId: 'local-1',
      }),
    ).rejects.toThrow(/Unexpected status/);

    expect(postSpy.mock.calls[0]?.[0]).toBe(`http://server.example.test/v2/sessions/${encoded}/messages`);
  });

  it('sends transcript.import as one validated historical batch', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { importHistoricalSessionTranscript } = await import('./sessionsHttp');
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: { imported: 2, cursor: 8 },
    } as any);

    await expect(importHistoricalSessionTranscript({
      token: 't',
      sessionId: 'sess/../?x=1',
      items: [
        {
          id: ' first ',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one' } } },
        },
        {
          id: 'second',
          content: { t: 'encrypted', c: 'ciphertext' },
        },
      ],
    })).resolves.toEqual({ imported: 2, cursor: '8' });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith(
      `http://server.example.test/v2/sessions/${encodeURIComponent('sess/../?x=1')}/transcript/import`,
      {
        items: [
          {
            localId: 'first',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one' } } },
          },
          {
            localId: 'second',
            content: { t: 'encrypted', c: 'ciphertext' },
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
  });

  it('keeps an empty transcript.import as a local no-op', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { importHistoricalSessionTranscript } = await import('./sessionsHttp');
    const postSpy = vi.spyOn(axios, 'post');

    await expect(importHistoricalSessionTranscript({
      token: 't',
      sessionId: 'session-1',
      items: [],
    })).resolves.toEqual({ imported: 0, cursor: null });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('maps the server-v0.2.1 route-miss vector to an upgrade-required transcript.import error', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { importHistoricalSessionTranscript } = await import('./sessionsHttp');
    // Provenance: server-v0.2.1@4913c1e533c872a0712ba1c25b3104fd470aacc2 registers
    // POST /v2/sessions/:sessionId/messages but no transcript/import route.
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 404,
      data: {
        statusCode: 404,
        error: 'Not Found',
        message: 'Route POST:/v2/sessions/session-1/transcript/import not found',
      },
    } as any);

    await expect(importHistoricalSessionTranscript({
      token: 't',
      sessionId: 'session-1',
      items: [{
        id: 'history-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one' } } },
      }],
    })).rejects.toMatchObject({
      code: 'upgrade_required',
      response: { status: 404 },
    });
  });

  it('preserves current-server missing-session handling for transcript.import', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { importHistoricalSessionTranscript } = await import('./sessionsHttp');
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 404,
      data: { error: 'Session not found' },
    } as any);

    await expect(importHistoricalSessionTranscript({
      token: 't',
      sessionId: 'session-1',
      items: [{
        id: 'history-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one' } } },
      }],
    })).rejects.toMatchObject({ code: 'session_not_found' });
  });

  it('rejects the complete transcript.import batch before any request when one item is invalid', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { importHistoricalSessionTranscript } = await import('./sessionsHttp');
    const postSpy = vi.spyOn(axios, 'post');

    await expect(importHistoricalSessionTranscript({
      token: 't',
      sessionId: 'session-1',
      items: [
        {
          id: 'valid',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'valid' } } },
        },
        { id: 'invalid', content: { not: 'a stored content envelope' } },
      ],
    })).rejects.toThrow('Invalid transcript import item');

    expect(postSpy).not.toHaveBeenCalled();
  });
});
