import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { projectLegacySessionAccessCapabilitiesV1, type SessionListQueryV1 } from '@happier-dev/protocol';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCompactSessionListRowFixture, createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const query: SessionListQueryV1 = {
  v: 1,
  storage: 'active',
  includeInactive: false,
  scope: 'assigned_to_me',
  attention: 'needs_my_attention',
  audiences: [{ kind: 'team', teamId: 'team-1' }],
  tagIds: ['tag-1'],
  limit: 10,
};

function createStrictQueryRow() {
  return createCompactSessionListRowFixture(createCurrentSessionProjectionRecordFixture({
    id: 'session-1',
    effectiveAccess: {
      v: 1 as const,
      level: 'view' as const,
      sources: [{ kind: 'direct' as const, shareId: 'share-1' }],
      capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
    },
    viewer: {
      latestFailureSeq: null,
      readState: { state: 'not_started' as const },
      relevance: { relevant: false, reasons: [] },
      attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
      follow: { follows: false, notificationLevel: null },
      notification: { level: 'none' as const, source: 'none' as const },
    },
  }));
}

describe('fetchSessionsQueryPage', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
  });

  it('posts the canonical query and preserves both cursor families', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://home.example.test';
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        sessions: [],
        nextCursor: 'cursor_v1_ordinary',
        hasNext: true,
        attentionNextCursor: 'cursor_v1_attention',
        attentionHasNext: true,
      },
    });
    const { fetchSessionsQueryPage } = await import('./sessionsHttp');

    await expect(runWithServerHttpBaseUrl(
      'https://home.example.test',
      () => fetchSessionsQueryPage({ token: 'token-1', query }),
    )).resolves.toEqual({
      sessions: [],
      nextCursor: 'cursor_v1_ordinary',
      hasNext: true,
      attentionNextCursor: 'cursor_v1_attention',
      attentionHasNext: true,
    });
    expect(post).toHaveBeenCalledWith(
      'https://home.example.test/v2/sessions/query',
      query,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
  });

  it('does not relabel an absent route or malformed body as strict query unavailability', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://home.example.test';
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 404,
      data: { error: 'route missing', privateDiagnostic: 'secret-sentinel' },
    });
    const get = vi.spyOn(axios, 'get');
    const { fetchSessionsQueryPage } = await import('./sessionsHttp');

    const rejection = await fetchSessionsQueryPage({ token: 'token-1', query })
      .catch((error: unknown) => error);
    expect(rejection).toMatchObject({ response: { status: 404 } });
    expect(rejection).not.toHaveProperty('code');
    expect(rejection).not.toHaveProperty('details');
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves a valid strict unavailable body as typed secret-free details', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://home.example.test';
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 404,
      data: {
        error: 'not_found',
        code: 'filtered_session_listing_unavailable',
        reason: 'audience',
      },
    });
    const get = vi.spyOn(axios, 'get');
    const { fetchSessionsQueryPage } = await import('./sessionsHttp');

    await expect(fetchSessionsQueryPage({ token: 'token-1', query })).rejects.toMatchObject({
      code: 'filtered_session_listing_unavailable',
      details: {
        error: 'not_found',
        code: 'filtered_session_listing_unavailable',
        reason: 'audience',
      },
      response: { status: 404 },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ['the ordinary continuation', {
      sessions: [],
      hasNext: false,
      attentionNextCursor: null,
      attentionHasNext: false,
    }],
    ['the attention continuation', {
      sessions: [],
      nextCursor: null,
      hasNext: false,
      attentionHasNext: false,
    }],
    ['the required current access projection', (() => {
      const { effectiveAccess: _effectiveAccess, ...row } = createStrictQueryRow();
      return {
        sessions: [row],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
      };
    })()],
    ['the required viewer projection', (() => {
      const { viewer: _viewer, ...row } = createStrictQueryRow();
      return {
        sessions: [row],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
      };
    })()],
    ['the required responsibility projection', (() => {
      const {
        responsibleAccountId: _responsibleAccountId,
        responsibleAccount: _responsibleAccount,
        ...row
      } = createStrictQueryRow();
      return {
        sessions: [row],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
      };
    })()],
  ])('rejects a successful filtered response missing %s', async (_label, data) => {
    process.env.HAPPIER_SERVER_URL = 'https://home.example.test';
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 200, data });
    const get = vi.spyOn(axios, 'get');
    const { fetchSessionsQueryPage } = await import('./sessionsHttp');

    await expect(fetchSessionsQueryPage({ token: 'token-1', query })).rejects.toThrow(
      'Unexpected /v2/sessions/query response shape',
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe('fetchSessionsPage attention continuation compatibility', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
  });

  it.each([
    ['attentionNextCursor', {
      sessions: [],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: 'cursor_v1_attention',
    }],
    ['attentionHasNext', {
      sessions: [],
      nextCursor: null,
      hasNext: false,
      attentionHasNext: true,
    }],
  ])('rejects a V2 response containing only %s', async (_field, data) => {
    process.env.HAPPIER_SERVER_URL = 'https://home.example.test';
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data });
    const { fetchSessionsPage } = await import('./sessionsHttp');

    await expect(fetchSessionsPage({ token: 'token-1' })).rejects.toThrow(
      'Session list response included a partial attention continuation',
    );
  });

  it('preserves the complete attention pair independently from the ordinary cursor', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://home.example.test';
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        sessions: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: 'cursor_v1_attention',
        attentionHasNext: true,
      },
    });
    const { fetchSessionsPage } = await import('./sessionsHttp');

    await expect(fetchSessionsPage({ token: 'token-1' })).resolves.toEqual({
      sessions: [],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: 'cursor_v1_attention',
      attentionHasNext: true,
    });
  });

  it('preserves predecessor compatibility when both attention fields are absent', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://home.example.test';
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { sessions: [], nextCursor: null, hasNext: false },
    });
    const { fetchSessionsPage } = await import('./sessionsHttp');

    await expect(fetchSessionsPage({ token: 'token-1' })).resolves.toEqual({
      sessions: [],
      nextCursor: null,
      hasNext: false,
    });
  });
});
