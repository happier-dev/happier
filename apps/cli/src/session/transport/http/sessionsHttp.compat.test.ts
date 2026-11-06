import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { z } from 'zod';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  projectLegacySessionAccessCapabilitiesV1,
  SessionStoredMessageContentSchema,
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

afterEach(() => vi.restoreAllMocks());

describe('sessionControl.sessionsHttp.fetchSessionByIdCompat', () => {
  it('accepts additive detail fields but still rejects a missing required id', async () => {
    const session = createSessionRecordFixture({ id: 's1' });
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200,
      data: { futureEnvelopeField: { ignored: true }, session: { ...session, futureCoordinationField: { ignored: true } } },
    }).mockResolvedValueOnce({ status: 200, data: { session: { ...session, id: undefined, futureCoordinationField: true } } });
    await expect(fetchSessionById({ reason: 'session-query', token: 't', sessionId: 's1' })).resolves.toMatchObject({ id: 's1' });
    await expect(fetchSessionById({ reason: 'session-query', token: 't', sessionId: 's1' })).rejects.toMatchObject({
      code: 'session_detail_invalid_response',
      issues: expect.arrayContaining([{ path: ['session', 'id'], code: 'invalid_type' }]),
    });
  });

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
            latestFailureSeq: null,
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
      reason: 'session-query',
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
      reason: 'session-query',
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

  it('identifies a qualified route miss without scanning the released list', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 404,
      data: { error: 'Not found', path: '/v2/sessions/s1', method: 'GET' },
    } as any);

    await expect(fetchSessionByIdCompat({
      reason: 'session-query',
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
    const error = await fetchSessionById({ reason: 'session-query', token: 'private-token', sessionId: 's1' }).catch((error: unknown) => error);
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

    await expect(fetchSessionByIdCompat({ reason: 'session-query', token: 't', sessionId: 's1' }))
      .resolves.toMatchObject({ id: 's1' });
  });

  it('does not scan Account lists when the single-session route is missing', async () => {
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

    const res = await fetchSessionByIdCompat({ reason: 'session-query', token: 't', sessionId: 's1' });
    expect(res).toBeNull();

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain('/v2/sessions/s1');
  });

  it('does not scan /v2/sessions when the session is missing (404 Session not found)', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 404,
      data: { error: 'Session not found' },
    } as any);

    const res = await fetchSessionByIdCompat({ reason: 'session-query', token: 't', sessionId: 's1' });
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

    await fetchSessionByIdCompat({ token: 't', sessionId: 's1', reason: 'legacy-compat-proof' });

    expect(getSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Happier-Request-Purpose': 'session-detail:legacy-compat-proof',
    });
  });

});

describe('sessionControl.sessionsHttp.applySessionAgentTransitionCutover', () => {
  // Prospective 0.2 wire contract, inspected at 1321319f311da3d44931afd39eeac7252b6350a4:
  // apps/server/sources/app/api/routes/session/registerSessionAgentTransitionRoute.ts:55-68.
  const predecessorBodySchema = z.object({
    v: z.literal(1),
    currentView: z.object({
      kind: z.literal('legacy_v0'),
      expectedMetadataVersion: z.number().int().min(0),
      metadataCiphertext: z.string().min(1),
      expectedAgentStateVersion: z.number().int().min(0),
      agentStateCiphertext: z.null(),
    }).strict(),
    divider: z.object({
      localId: z.string().min(1),
      content: SessionStoredMessageContentSchema,
    }).strict(),
  }).strict();
  const timing = { v: 1, minMs: 200, maxMs: 200 } as const;
  const sessionTiming = { v: 1, metadata: timing, agentState: null } as const;

  it.each(['plain', 'e2ee'] as const)('sends one legacy cutover accepted by the strict 0.2 server (%s)', async mode => {
    const currentView = {
      kind: 'legacy_v0' as const,
      expectedMetadataVersion: 1,
      metadataCiphertext: 'sealed-metadata',
      expectedAgentStateVersion: 1,
      agentStateCiphertext: null,
      usageTimingV1: sessionTiming,
    };
    const divider = {
      localId: 'agent-transition:submitted-1',
      usageTimingV1: timing,
      content: sealSessionStoredContent({
        payload: { role: 'agent', content: { type: 'event', id: 'agent-transition:submitted-1',
          data: { type: 'message', message: 'Continuing with another Agent' } } },
        idempotencyKey: 'agent-transition:submitted-1',
        ...(mode === 'plain' ? { mode, ctx: null } : { mode, ctx: {
          encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' as const,
        } }),
      }),
    };
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) =>
      predecessorBodySchema.safeParse(body).success
        ? { status: 200, data: { success: true, dividerSeq: 7 } }
        : { status: 400, data: { error: 'Invalid parameters' } });

    await expect(applySessionAgentTransitionCutover({ token: 't', sessionId: 's1', currentView, divider }))
      .resolves.toEqual({ ok: true, dividerSeq: 7 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toEqual({ v: 1,
      currentView: { kind: 'legacy_v0', expectedMetadataVersion: 1, metadataCiphertext: 'sealed-metadata',
        expectedAgentStateVersion: 1, agentStateCiphertext: null },
      divider: { localId: divider.localId, content: divider.content },
    });
    expect(currentView.usageTimingV1).toEqual(sessionTiming);
    expect(divider).toHaveProperty('usageTimingV1');
  });

  it('retains timing in the existing envelope-layout cutover', async () => {
    const ownerMetadata = { t: 'plain', v: { v: 1 } } as const;
    const currentView = {
      kind: 'envelope_tuple_v1' as const,
      ownerPatch: { mode: 'owner_inactive_model_intent' as const, metadataLayoutVersion: 1 as const,
        sessionExpectation: { kind: 'inactive_model_intent' as const },
        expectedOwnerMetadata: ownerMetadata, ownerMetadata,
        sharedMetadata: { ciphertext: 'shared-ciphertext', expectedVersion: 3 },
        agentState: { ciphertext: null, expectedVersion: 5 }, usageTimingV1: sessionTiming },
    };
    const divider = { localId: 'agent-transition:submitted-1', content: { t: 'encrypted', c: 'divider' }, usageTimingV1: timing };
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, dividerSeq: 7 } });
    await expect(applySessionAgentTransitionCutover({ token: 't', sessionId: 's1', currentView, divider }))
      .resolves.toEqual({ ok: true, dividerSeq: 7 });
    expect(post.mock.calls[0]?.[1]).toEqual({ v: 1, currentView, divider });
  });

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
