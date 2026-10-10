import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import {
  projectLegacySessionAccessCapabilitiesV1,
} from '@happier-dev/protocol';
import {
  createSessionListResponseFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';

import {
  applySessionAgentTransitionCutover,
  fetchSessionById,
  fetchSessionByIdCompat,
} from './sessionsHttp';

describe('sessionControl.sessionsHttp.fetchSessionByIdCompat', () => {
  it('rejects a qualified current detail response that omits responsibility', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 's1',
          effectiveAccess: {
            v: 1,
            level: 'view',
            sources: [{ kind: 'direct', shareId: 'share-1' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
          },
          viewer: {
            readState: { state: 'not_started' },
            relevance: { relevant: false, reasons: [] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'none', source: 'none' },
          },
        }),
      },
    } as any);

    await expect(fetchSessionByIdCompat({
      token: 't',
      sessionId: 's1',
      accessProjectionVersion: 1,
    })).rejects.toMatchObject({
      code: 'session_detail_invalid_response',
      schema: 'current_access_projection_v1',
      issues: expect.arrayContaining([
        { path: ['responsibleAccountId'], code: 'invalid_type' },
        { path: ['responsibleAccount'], code: 'invalid_type' },
      ]),
    });
  });

  it('rejects a qualified detail response that omits the negotiated effective-access projection', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({ id: 's1' }),
      },
    } as any);

    await expect(fetchSessionByIdCompat({
      token: 't',
      sessionId: 's1',
      accessProjectionVersion: 1,
    })).rejects.toMatchObject({
      code: 'session_detail_invalid_response',
      schema: 'current_access_projection_v1',
      issues: expect.arrayContaining([{ path: ['effectiveAccess'], code: 'invalid_type' }]),
    });

    expect(getSpy.mock.calls[0]?.[0]).toContain('accessProjectionVersion=1');
  });

  it.each([
    { reader: 'direct', fetchDetail: fetchSessionById },
    { reader: 'compat', fetchDetail: fetchSessionByIdCompat },
  ])('identifies a qualified route miss without scanning the released list ($reader)', async ({ fetchDetail }) => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 404,
      data: { error: 'Not found', path: '/v2/sessions/s1', method: 'GET' },
    } as any);

    await expect(fetchDetail({
      token: 't',
      sessionId: 's1',
      accessProjectionVersion: 1,
    })).rejects.toMatchObject({
      code: 'session_detail_projection_unavailable',
      response: { status: 404 },
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('reports envelope schema paths without exposing rejected response values', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { session: { metadata: 'private-provider-text' } },
    });
    const error = await fetchSessionById({ token: 'private-token', sessionId: 's1' }).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'session_detail_invalid_response',
      schema: 'v2_session_detail',
      issues: expect.arrayContaining([{ path: ['session', 'id'], code: 'invalid_type' }]),
    });
    expect(String(error)).not.toContain('private-provider-text');
    expect(JSON.stringify(error)).not.toMatch(/private-provider-text|private-token/);
  });

  it('continues accepting the released owner/direct detail shape for a bare request', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({ id: 's1' }),
      },
    } as any);

    await expect(fetchSessionByIdCompat({ token: 't', sessionId: 's1' }))
      .resolves.toMatchObject({ id: 's1' });
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

  it('sends structured request-purpose telemetry for session-detail reads', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({ id: 's1', metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: 'dek' }),
      },
    } as any);

    const res = await fetchSessionByIdCompat({ token: 't', sessionId: 's1', reason: 'connect' });

    expect(res).toMatchObject({ id: 's1' });
    expect(getSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Happier-Request-Purpose': 'session-detail:socket-connect-catchup',
    });
  });

  it('labels unclassified compat session-detail reads with a legacy proof purpose', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({ id: 's1', metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: 'dek' }),
      },
    } as any);

    await fetchSessionByIdCompat({ token: 't', sessionId: 's1' });

    expect(getSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Happier-Request-Purpose': 'session-detail:legacy-compat-proof',
    });
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

describe('sessionControl.sessionsHttp.applySessionAgentTransitionCutover', () => {
  it('fails closed when a retired divider-verification field appears in a success body', async () => {
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        dividerSeq: 7,
        dividerVerificationRequired: true,
      },
    } as never);

    await expect(applySessionAgentTransitionCutover({
      token: 't',
      sessionId: 's1',
      currentView: {
        kind: 'legacy_v0',
        expectedMetadataVersion: 1,
        metadataCiphertext: 'metadata',
        expectedAgentStateVersion: 1,
        agentStateCiphertext: null,
      },
      divider: {
        localId: 'agent-transition:submitted-1',
        content: { t: 'encrypted', c: 'divider' },
      },
    })).resolves.toEqual({ ok: false, effect: 'unknown', error: 'transport' });
  });
});
