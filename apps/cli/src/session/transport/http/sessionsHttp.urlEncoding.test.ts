import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import fastify from 'fastify';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { SessionHistoricalTranscriptImportV3Schema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';

describe('sessionControl.sessionsHttp URL encoding', () => {
  const envKeys = ['HAPPIER_SERVER_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let releaseHome: () => void;

  beforeEach(() => {
    releaseHome = publishServerHttpRuntimeOrigin('http://server.example.test', 'https');
  });

  afterEach(() => {
    releaseHome();
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.restoreAllMocks();
  });

  it('encodes sessionId path segments for fetchSessionById', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    const { fetchSessionById } = await import('./sessionsHttp');

    const sessionId = 'sess/../?x=1';
    const encoded = encodeURIComponent(sessionId);

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} } as any);
    await expect(fetchSessionById({ reason: 'session-query', token: 't', sessionId })).resolves.toBeNull();

    expect(getSpy).toHaveBeenCalledWith(
      `http://server.example.test/v2/sessions/${encoded}`,
      expect.any(Object),
    );
  });

  it('uses the captured Home for an exact Session hydration', async () => {
    const { fetchSessionById } = await import('./sessionsHttp');
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} });
    await expect(fetchSessionById({ reason: 'session-query', token: 't', sessionId: 'session', serverUrl: 'https://captured.example' })).resolves.toBeNull();
    expect(get.mock.calls[0]?.[0]).toBe('https://captured.example/v2/sessions/session');
  });

  it('requests effective access only after the exact Home decision opts in', async () => {
    const { fetchSessionById } = await import('./sessionsHttp');
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} });
    await expect(fetchSessionById({
      reason: 'session-query',
      token: 't',
      sessionId: 'session',
      serverUrl: 'https://captured.example',
      accessProjectionVersion: 1,
    })).resolves.toBeNull();
    expect(get.mock.calls[0]?.[0]).toBe('https://captured.example/v2/sessions/session?accessProjectionVersion=1');
  });

  it('does not report a qualified detail route miss as an absent Session', async () => {
    const { fetchSessionById } = await import('./sessionsHttp');
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 404,
      data: { error: 'Not found', path: '/v2/sessions/session', method: 'GET' },
    });

    await expect(fetchSessionById({
      reason: 'session-query',
      token: 't',
      sessionId: 'session',
      serverUrl: 'https://captured.example',
      accessProjectionVersion: 1,
    })).rejects.toMatchObject({ code: 'session_detail_projection_unavailable' });
  });

  it('derives effective-access detail from the exact Home collaboration snapshot', async () => {
    const { fetchSessionById } = await import('./sessionsHttp');
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} });
    await expect(fetchSessionById({
      reason: 'session-query',
      token: 't',
      sessionId: 'session',
      serverUrl: 'https://captured.example',
      serverFeaturesSnapshot: {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true },
            sharing: { session: { enabled: true } },
          },
          capabilities: {},
        }),
      },
    })).resolves.toBeNull();
    expect(get.mock.calls[0]?.[0]).toBe('https://captured.example/v2/sessions/session?accessProjectionVersion=1');
  });

  it.each([
    ['absent', undefined],
    ['unsupported', { status: 'unsupported' as const, reason: 'endpoint_missing' as const }],
  ])('keeps the released bare detail projection when the exact Home decision is %s', async (_label, snapshot) => {
    const { fetchSessionById } = await import('./sessionsHttp');
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data: {} });
    await expect(fetchSessionById({
      reason: 'session-query',
      token: 't',
      sessionId: 'session',
      serverUrl: 'https://captured.example',
      ...(snapshot ? { serverFeaturesSnapshot: snapshot } : {}),
    })).resolves.toBeNull();
    expect(get.mock.calls[0]?.[0]).toBe('https://captured.example/v2/sessions/session');
  });

  it('encodes sessionId path segments for commitSessionStoredMessage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

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

  it('negotiates the reference-bearing import epoch and preserves old-Home transcript fallback without references', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const { importHistoricalSessionTranscript } = await import('./sessionsHttp');
    const surfaceItemReference = { v: 1 as const, itemId: 'child', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      sourceAddress: { serverId: 'origin-home', sessionId: 'parent' } };
    const content = { t: 'encrypted' as const, c: 'child-sealed' };
    const postSpy = vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ status: 404, data: { message: 'Route not found' } })
      .mockResolvedValueOnce({ status: 200, data: { imported: 1, cursor: 8 } });
    await expect(importHistoricalSessionTranscript({ token: 't', sessionId: 'child-session',
      items: [{ id: 'row', content, surfaceItemReference }] })).resolves.toEqual({ imported: 1, cursor: '8' });
    expect(postSpy.mock.calls.map(([url, body]) => ({ url, body }))).toEqual([
      { url: 'http://server.example.test/v3/sessions/child-session/transcript/import',
        body: { items: [{ localId: 'row', content, surfaceItemReference: { v: 1, references: [surfaceItemReference] } }] } },
      { url: 'http://server.example.test/v2/sessions/child-session/transcript/import',
        body: { items: [{ localId: 'row', content }] } },
    ]);
  });

  it.each(['current', 'older', 'later-failure', 'retry'] as const)(
    'preserves ordered transcript.import rows through the real HTTP batch boundary on a %s Home', async (mode) => {
      process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
      const { importHistoricalSessionTranscript } = await import('./sessionsHttp');
      const app = fastify();
      const accepted: Array<ReturnType<typeof SessionHistoricalTranscriptImportV3Schema.parse>['items'][number]> = [];
      const requestPaths: string[] = [];
      app.addHook('onRequest', async (request) => { requestPaths.push(request.url); });
      for (const epoch of mode === 'older' ? [2] : [2, 3]) {
        app.post(`/v${epoch}/sessions/child/transcript/import`, async (request, reply) => {
          const body = SessionHistoricalTranscriptImportV3Schema.safeParse(request.body);
          if (!body.success) return reply.code(400).send({ error: 'Invalid parameters' });
          if (mode === 'later-failure' && accepted.length > 0) {
            return reply.code(500).send({ error: 'Failed to import transcript' });
          }
          accepted.push(...body.data.items);
          // The canonical stable-localId retry returns the original row sequence, not a new one.
          return { imported: body.data.items.length, cursor: mode === 'retry' && accepted.length > 500 ? 1 : accepted.length };
        });
      }
      const restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://server.example.test' });
      const surfaceItemReference = { v: 1 as const, references: ['first', 'second'].map(sourceItemId => ({
        v: 1 as const, itemId: `child-${sourceItemId}`, itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        sourceAddress: { serverId: 'origin-home', sessionId: 'parent' }, sourceItemId,
        sourceItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' })) };
      const items = Array.from({ length: 501 }, (_, index) => {
        const sourceIndex = mode === 'retry' && index === 500 ? 0 : index;
        return { id: `native-row-${sourceIndex}`,
          content: { t: 'encrypted' as const, c: `child-sealed-raw-row-${sourceIndex}` }, surfaceItemReference };
      });
      try {
        const result = importHistoricalSessionTranscript({ token: 't', sessionId: 'child', items });
        if (mode === 'later-failure') {
          await expect(result).rejects.toThrow('Unexpected status from /v3/sessions/child/transcript/import: 500');
        } else {
          await expect(result).resolves.toEqual({ imported: 501, cursor: mode === 'retry' ? '500' : '501' });
        }
        expect(accepted).toEqual(items.slice(0, mode === 'later-failure' ? 500 : undefined).map(({ id, ...item }) => ({
          localId: id, content: item.content,
          ...(mode === 'older' ? {} : { surfaceItemReference: item.surfaceItemReference }),
        })));
        expect(requestPaths).toEqual(mode === 'older'
          ? ['/v3/sessions/child/transcript/import', '/v2/sessions/child/transcript/import', '/v2/sessions/child/transcript/import']
          : ['/v3/sessions/child/transcript/import', '/v3/sessions/child/transcript/import']);
      } finally {
        restoreAdapter();
        await app.close();
      }
    },
  );

  it('keeps an empty transcript.import as a local no-op', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

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
