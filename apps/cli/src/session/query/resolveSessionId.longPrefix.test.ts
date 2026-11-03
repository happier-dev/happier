import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  FeaturesResponseSchema,
  projectSessionAccessCapabilitiesV1,
  SessionOwnerMetadataV1Schema,
  type SessionAccessSourceV1,
  type SessionListQueryV1,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCompactSessionListRowFixture, createCurrentSessionProjectionRecordFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { mockAxiosGet, mockAxiosPost } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

vi.mock('axios', async () => {
  return {
    default: {
      get: mockAxiosGet,
      post: mockAxiosPost,
    },
  };
});

describe('resolveSessionIdOrPrefix', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { sessions: [] },
      headers: {},
    });
  });

  describe('current Home access scope', () => {
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const serverFeaturesSnapshot = {
      status: 'ready' as const,
      features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true }, sharing: { session: { enabled: true } } },
        capabilities: {},
      }),
    };
    const teamSessionId = 'cteam00000000000000000000';

    function currentRow(id: string, source: SessionAccessSourceV1) {
      return createCurrentSessionProjectionRecordFixture({
        id,
        effectiveAccess: {
          v: 1,
          level: source.kind === 'owner' ? 'owner' : 'edit',
          sources: [source],
          capabilities: projectSessionAccessCapabilitiesV1({
            owner: source.kind === 'owner',
            grants: [{ accessLevel: 'edit', canApprovePermissions: false }],
          }),
        },
        viewer: {
          latestFailureSeq: null,
          readState: { state: 'not_started' },
          relevance: { relevant: false, reasons: [] },
          attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
          follow: { follows: false, notificationLevel: null },
          notification: { level: 'none', source: 'none' },
        },
      });
    }

    function serveCurrentHome(rows: ReturnType<typeof currentRow>[], storage: 'active' | 'archived' = 'active') {
      // Axios is the network boundary: keep selector, feature decision and strict parsers real.
      // Bare released listing sees only owner/direct grants, never Team-only access.
      const legacyRows = rows.filter((row) => row.effectiveAccess.sources.some((source) =>
        source.kind === 'owner' || source.kind === 'direct'));
      mockAxiosGet.mockImplementation(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/v2/sessions' || parsed.pathname === '/v2/sessions/archived') {
          return { status: 200, data: { sessions: legacyRows.map(createCompactSessionListRowFixture), nextCursor: null, hasNext: false } };
        }
        const row = parsed.searchParams.get('accessProjectionVersion') === '1'
          ? rows.find((entry) => parsed.pathname === `/v2/sessions/${entry.id}`)
          : undefined;
        return row ? { status: 200, data: { session: row } } : { status: 404, data: {} };
      });
      mockAxiosPost.mockImplementation(async (url: string, query: SessionListQueryV1) => {
        if (new URL(url).pathname === '/v2/sessions/lookup-by-tags') {
          return { status: 200, data: { sessions: [] } };
        }
        expect(new URL(url).pathname).toBe('/v2/sessions/query');
        return {
          status: 200,
          data: {
            sessions: query.storage === storage ? rows.map(createCompactSessionListRowFixture) : [],
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: null,
            attentionHasNext: false,
          },
        };
      });
    }

    it.each(['active', 'archived'] as const)('resolves a Team-only %s recipient by full ID and unique prefix in the same Home', async (storage) => {
      const row = currentRow(teamSessionId, { kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false });
      serveCurrentHome([row], storage);
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const signal = new AbortController().signal;
      const resolveAuthorizationHeaders = () => ({ Authorization: 'Bearer scoped-action-token' });

      await runWithServerHttpBaseUrl('https://selected-home.example.test', async () => {
        await expect(resolveSessionIdOrPrefix({
          reason: 'session-query',
          credentials, idOrPrefix: teamSessionId, serverFeaturesSnapshot, signal, resolveAuthorizationHeaders,
        })).resolves.toMatchObject({ ok: true, sessionId: teamSessionId, rawSession: row });
        await expect(resolveSessionIdOrPrefix({
          reason: 'session-query',
          credentials, idOrPrefix: 'cteam', serverFeaturesSnapshot, signal, resolveAuthorizationHeaders,
        })).resolves.toEqual({ ok: true, sessionId: teamSessionId });
      });
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://selected-home.example.test/v2/sessions/query',
        { v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [], limit: 200 },
        expect.objectContaining({ signal, headers: expect.objectContaining({ Authorization: 'Bearer scoped-action-token' }) }),
      );
      expect(mockAxiosGet.mock.calls.every(([url]) => new URL(url).searchParams.get('accessProjectionVersion') === '1')).toBe(true);
    });

    it.each([
      { kind: 'owner' } as const,
      { kind: 'direct', shareId: 'share-1' } as const,
    ])('reports ambiguity between Team-only and $kind prefix matches', async (source) => {
      serveCurrentHome([
        currentRow(teamSessionId, { kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }),
        currentRow('cteam-neighbor', source),
      ]);
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      await expect(runWithServerHttpBaseUrl('https://selected-home.example.test', () => resolveSessionIdOrPrefix({
        reason: 'session-query',
        credentials, idOrPrefix: 'cteam', serverFeaturesSnapshot,
      }))).resolves.toEqual({
        ok: false, code: 'session_id_ambiguous', candidates: [teamSessionId, 'cteam-neighbor'],
      });
    });

    it('does not fall back to an owner/direct list when the negotiated query fails', async () => {
      serveCurrentHome([currentRow('cteam-owner', { kind: 'owner' })]);
      mockAxiosPost.mockImplementation(async (url: string) => new URL(url).pathname === '/v2/sessions/lookup-by-tags'
        ? { status: 200, data: { sessions: [] } }
        : { status: 403, data: { privateDiagnostic: 'secret-sentinel' } });
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      await expect(runWithServerHttpBaseUrl('https://selected-home.example.test', () => resolveSessionIdOrPrefix({
        reason: 'session-query',
        credentials, idOrPrefix: 'cteam', serverFeaturesSnapshot,
      }))).rejects.toMatchObject({ response: { status: 403 } });
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });
  });

  it('returns a missing full session id before the outer tool budget expires', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/c000000000000000000000000')) {
        return { status: 404, data: {}, headers: {} };
      }
      return {
        status: 200,
        data: { sessions: [], nextCursor: null, hasNext: false },
        headers: {},
      };
    });

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await Promise.race([
        resolveSessionIdOrPrefix({
          reason: 'session-query',
          credentials: {
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          },
          idOrPrefix: 'c000000000000000000000000',
        }),
        new Promise<'outer_budget_exceeded'>((resolve) => {
          budgetTimer = setTimeout(() => resolve('outer_budget_exceeded'), 250);
        }),
      ]);

      expect(res).toEqual({ ok: false, code: 'session_not_found' });
      expect(mockAxiosGet).toHaveBeenCalledTimes(3);
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('preserves caller cancellation while a full-id fallback lookup remains pending', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/c000000000000000000000000')) {
        return { status: 404, data: {}, headers: {} };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const cancellation = new AbortController();
    let notifyFallbackRequested!: () => void;
    const fallbackRequested = new Promise<void>(resolve => { notifyFallbackRequested = resolve; });
    mockAxiosPost.mockImplementation(async (_url: string, _body: unknown, config?: { signal?: AbortSignal }) => {
      return await new Promise((_resolve, reject) => {
        config?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        notifyFallbackRequested();
      });
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const resultPromise = resolveSessionIdOrPrefix({
        reason: 'session-query',
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'c000000000000000000000000',
        signal: cancellation.signal,
      });

      const rejected = expect(resultPromise).rejects.toThrow('request aborted');
      await fallbackRequested;
      cancellation.abort();
      await rejected;
      expect(mockAxiosGet).toHaveBeenCalledOnce();
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('preserves indexed exact tag resolution when the tag is shaped like a full session id', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const cuidShapedTag = 'c000000000000000000000000';
    const indexedSession = createSessionRecordFixture({ id: 'session-with-cuid-shaped-tag' });

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockResolvedValue({ status: 404, data: {}, headers: {} });
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { sessions: [indexedSession] },
      headers: {},
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        reason: 'session-query',
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: cuidShapedTag,
      });

      expect(res).toMatchObject({ ok: true, sessionId: 'session-with-cuid-shaped-tag' });
      expect(mockAxiosGet).toHaveBeenCalledOnce();
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('prefers the indexed exact layout-v1 tag over an id prefix match', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const secret = new Uint8Array(32).fill(1);
    const tag = 'layout-tag';
    const indexedSession = createSessionRecordFixture({
      id: 'session-indexed-layout-tag',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      share: null,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
        SessionOwnerMetadataV1Schema.parse({
          v: 1,
          nativeSession: { tag },
        }),
      ),
    });

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { sessions: [indexedSession] },
      headers: {},
    });
    mockAxiosGet.mockResolvedValue({
      status: 200,
      data: {
        sessions: [
          createSessionRecordFixture({ id: 'layout-tag-prefix-session' }),
        ],
        nextCursor: null,
        hasNext: false,
      },
      headers: {},
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        reason: 'session-query',
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret },
        },
        idOrPrefix: tag,
        accountEncryptionMode: 'plain',
      });

      expect(res).toMatchObject({
        ok: true,
        sessionId: 'session-indexed-layout-tag',
      });
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://example.test/v2/sessions/lookup-by-tags',
        { tags: [tag] },
        expect.any(Object),
      );
      expect(mockAxiosGet).not.toHaveBeenCalled();
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('reports unsupported indexed lookup without scanning private owner metadata', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const secret = new Uint8Array(32).fill(1);
    const tag = 'legacy-layout-tag';
    const fallbackSession = createSessionRecordFixture({
      id: 'session-from-layout-v1-owner',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      share: null,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
        SessionOwnerMetadataV1Schema.parse({
          v: 1,
          nativeSession: { tag },
        }),
      ),
    });

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosPost.mockResolvedValue({ status: 404, data: {
      statusCode: 404, error: 'Not Found', message: 'Route POST:/v2/sessions/lookup-by-tags not found',
    } });

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes(`/v2/sessions/${tag}`)) {
        return { status: 404, data: {}, headers: {} };
      }
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: { sessions: [], nextCursor: null, hasNext: false },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [fallbackSession],
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
        reason: 'session-query',
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret },
        },
        idOrPrefix: tag,
        accountEncryptionMode: 'plain',
      });

      expect(res).toEqual({ ok: false, code: 'unsupported' });
      expect(mockAxiosPost).toHaveBeenCalledOnce();
      expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

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
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: {
            sessions: [],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [createCompactSessionListRowFixture(createSessionRecordFixture({ id: 'sess_integration_run_start_123' }))],
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
        reason: 'session-query',
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

  it('includes archived sessions when resolving by prefix', async () => {
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
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: {
            sessions: [createCompactSessionListRowFixture(createSessionRecordFixture({ id: 'sess_integration_archived_123' }))],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [],
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
        reason: 'session-query',
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'sess_integration',
      });

      expect(res).toEqual({ ok: true, sessionId: 'sess_integration_archived_123' });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('does not treat duplicate matches across active + archived scans as ambiguous', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/sess_dup')) {
        return { status: 404, data: {}, headers: {} };
      }
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: {
            sessions: [createCompactSessionListRowFixture(createSessionRecordFixture({ id: 'sess_dup_123' }))],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [createCompactSessionListRowFixture(createSessionRecordFixture({ id: 'sess_dup_123' }))],
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
        reason: 'session-query',
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'sess_dup',
      });

      expect(res).toEqual({ ok: true, sessionId: 'sess_dup_123' });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('threads cancellation through indexed tag lookup and prefix paging', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const cancellation = new AbortController();

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: {
          sessions: [createCompactSessionListRowFixture(createSessionRecordFixture({ id: 'cancelx-session' }))],
          nextCursor: null,
          hasNext: false,
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          sessions: [],
          nextCursor: null,
          hasNext: false,
        },
        headers: {},
      });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        reason: 'session-query',
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'cancelx',
        signal: cancellation.signal,
      });

      expect(res).toEqual({ ok: true, sessionId: 'cancelx-session' });
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://example.test/v2/sessions/lookup-by-tags',
        { tags: ['cancelx'] },
        expect.objectContaining({ signal: cancellation.signal }),
      );
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://example.test/v2/sessions?limit=200',
        expect.objectContaining({ signal: cancellation.signal }),
      );
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://example.test/v2/sessions/archived?limit=200',
        expect.objectContaining({ signal: cancellation.signal }),
      );
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });
});
