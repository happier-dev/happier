import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCompactSessionListRowFixture as compactRow, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { fetchSessionsPage, fetchSessionsQueryPage, fetchSessionRuntimeManagedSubtreeQueryPage } from './sessionsHttp';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionInventoryPage } from '@/daemon/sessions/sessionInventoryVisibility';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createCurrentSessionProjectionRecordFixture, createSessionRuntimeManagedSubtreeRecordFixture } from '@/testkit/backends/sessionFixtures';

afterEach(() => vi.restoreAllMocks());

describe('compact Session list document demand', () => {
  it('keeps the runtime subtree proof on the full snapshot demand', async () => {
    const session = createSessionRuntimeManagedSubtreeRecordFixture({ id: 'child' });
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 200, data: {
      sessions: [compactRow(session)], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    } }).mockResolvedValueOnce({ status: 200, data: {
      results: [{ sessionId: session.id, detail: { status: 200, body: { session } } }],
    } });
    const page = await runWithServerHttpBaseUrl('https://home.example.test', () => fetchSessionRuntimeManagedSubtreeQueryPage({
      token: 'runtime', query: { v: 1, underSessionId: 'root', storage: 'active', includeInactive: true,
        scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [] },
    }));
    expect(page.sessions).toEqual([session]);
    expect(post).toHaveBeenLastCalledWith('https://home.example.test/v2/sessions/read-batch',
      expect.objectContaining({ underSessionId: 'root', includeSnapshot: true, includeTurns: false, includeMessages: false }),
      expect.any(Object));
  });

  it('rejects Account-private data in a runtime subtree full snapshot', async () => {
    const session = createSessionRuntimeManagedSubtreeRecordFixture({ id: 'child' });
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 200, data: {
      sessions: [compactRow(session)], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    } }).mockResolvedValueOnce({ status: 200, data: {
      results: [{ sessionId: session.id, detail: { status: 200, body: { session: { ...session, receivedRuleCount: 3 } } } }],
    } });
    await expect(runWithServerHttpBaseUrl('https://home.example.test', () => fetchSessionRuntimeManagedSubtreeQueryPage({
      token: 'runtime', query: { v: 1, underSessionId: 'root', storage: 'active', includeInactive: true,
        scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [] },
    }))).rejects.toMatchObject({ code: 'session_read_batch_invalid_response' });
  });

  it('keeps id-only retained visibility compact with zero document requests', async () => {
    const row = compactRow(createSessionRecordFixture({ id: 'retained' }));
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      sessions: [row], nextCursor: null, hasNext: false,
    } });
    const post = vi.spyOn(axios, 'post');
    const page = await runWithServerHttpBaseUrl('https://home.example.test',
      () => fetchSessionInventoryPage({ token: 'token', scope: 'archived' }));
    expect(page.sessions).toEqual([row]);
    expect(post).not.toHaveBeenCalled();
  });

  it('hydrates strict-query documents through current access while preserving both frontiers', async () => {
    const session = createCurrentSessionProjectionRecordFixture({ id: 'query-row',
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
      viewer: { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: false, notificationLevel: null }, notification: { level: 'none', source: 'none' } },
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 200, data: {
      sessions: [compactRow(session)], nextCursor: 'ordinary', hasNext: true,
      attentionNextCursor: 'attention', attentionHasNext: true,
    } }).mockResolvedValueOnce({ status: 200, data: {
      results: [{ sessionId: session.id, detail: { status: 200, body: { session } } }],
    } });
    const page = await runWithServerHttpBaseUrl('https://home.example.test', () => fetchSessionsQueryPage({ token: 'token',
      query: { v: 1, underSessionId: 'query-root', storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [] } }));
    expect(page).toEqual({ sessions: [session], nextCursor: 'ordinary', hasNext: true,
      attentionNextCursor: 'attention', attentionHasNext: true });
    expect(post).toHaveBeenLastCalledWith('https://home.example.test/v2/sessions/read-batch',
      { sessionIds: [session.id], underSessionId: 'query-root', includeSnapshot: true, includeTurns: false, includeMessages: false, accessProjectionVersion: 1 },
      expect.any(Object));
  });

  it('reports unavailable indexed tag lookup without opening an Account inventory', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      sessions: [], nextCursor: null, hasNext: false,
    } });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 404, data: {
      statusCode: 404, error: 'Not Found', message: 'Route POST:/v2/sessions/lookup-by-tags not found',
    } });
    const result = await runWithServerHttpBaseUrl('https://home.example.test',
      () => resolveSessionIdOrPrefix({ reason: 'session-query', credentials: { token: 'token', encryption: null }, idOrPrefix: 'tag' }));
    expect(result).toEqual({ ok: false, code: 'unsupported' });
    expect(get).not.toHaveBeenCalled();
  });

  it('gathers 1000 needed full records into one snapshot-only batch and preserves documents and continuations', async () => {
    const sessions = Array.from({ length: 1000 }, (_, index) => createSessionRecordFixture({
      id: `session-${index}`, metadata: JSON.stringify({ name: `Session ${index}` }), agentState: '{"requests":{}}',
    }));
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      sessions: sessions.map(compactRow), nextCursor: 'ordinary-next', hasNext: true,
      attentionNextCursor: 'attention-next', attentionHasNext: true,
    } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
      results: sessions.map(session => ({ sessionId: session.id, detail: { status: 200, body: { session } } })),
    } });

    const page = await runWithServerHttpBaseUrl('https://home.example.test',
      () => fetchSessionsPage({ token: 'token' }));

    expect(page).toEqual({ sessions, nextCursor: 'ordinary-next', hasNext: true,
      attentionNextCursor: 'attention-next', attentionHasNext: true });
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledExactlyOnceWith('https://home.example.test/v2/sessions/read-batch', {
      sessionIds: sessions.map(session => session.id), includeSnapshot: true, includeTurns: false, includeMessages: false,
    }, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));
  });

  it.each([401, 403, 404, 409, 503])('keeps a per-session %s refusal observable rather than returning an empty document', async status => {
    const session = createSessionRecordFixture({ id: 'session' });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      sessions: [compactRow(session)], nextCursor: null, hasNext: false,
    } });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
      results: [{ sessionId: 'session', detail: { status, body: { error: 'not_available' } } }],
    } });

    await expect(runWithServerHttpBaseUrl('https://home.example.test',
      () => fetchSessionsPage({ token: 'token' }))).rejects.toMatchObject({
      response: { status }, sessionId: 'session',
    });
  });

  it.each(['missing', 'duplicate', 'foreign', 'mismatched-detail'])('rejects %s full detail membership', async kind => {
    const session = createSessionRecordFixture({ id: 'session' });
    const part = { sessionId: 'session', detail: { status: 200, body: { session } } };
    const results = kind === 'missing' ? [] : kind === 'duplicate' ? [part, part]
      : kind === 'foreign' ? [{ ...part, sessionId: 'foreign' }]
        : [{ ...part, detail: { status: 200, body: { session: { ...session, id: 'foreign' } } } }];
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      sessions: [compactRow(session)], nextCursor: null, hasNext: false,
    } });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { results } });
    await expect(runWithServerHttpBaseUrl('https://home.example.test',
      () => fetchSessionsPage({ token: 'token' }))).rejects.toMatchObject({ code: 'session_read_batch_invalid_response' });
  });
});
