import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  SessionAwarenessListResultV1Schema,
  parseSessionListQueryActionResultV1,
  type SessionListQueryV1,
} from '@happier-dev/protocol';

const { bootstrapAccountSettingsContext, fetchAccountEncryptionCurrentness, fetchSessionById, fetchSessionsPage, fetchSessionsQueryPage, getSessionTranscript } = vi.hoisted(() => ({
  bootstrapAccountSettingsContext: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  fetchSessionsQueryPage: vi.fn(),
  getSessionTranscript: vi.fn(),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness,
}));

// Only the two HTTP fetchers are substituted; the module's pure readers stay real so the page
// shape this service consumes is still interpreted by its canonical owner.
vi.mock('@/session/transport/http/sessionsHttp', async (importActual) => ({
  ...await importActual<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
  fetchSessionsPage,
  fetchSessionsQueryPage,
}));

vi.mock('./getSessionTranscript', () => ({
  getSessionTranscript,
}));

describe('listSessions', () => {
  const credentials = {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(5),
    },
  } as const;

  function encryptedMetadata(value: Record<string, unknown>): string {
    return encodeBase64(encryptLegacy(value, credentials.encryption.secret));
  }

  beforeEach(() => {
    bootstrapAccountSettingsContext.mockResolvedValue({ settings: null });
    fetchAccountEncryptionCurrentness.mockResolvedValue({
      mode: 'e2ee',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    });
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    fetchSessionsQueryPage.mockReset();
    getSessionTranscript.mockReset();
  });

  it.each(['summary', 'awareness'] as const)('filters %s using authorized Bot metadata and preserves incomplete page coverage', async (view) => {
    const query: SessionListQueryV1 = {
      v: 1, storage: 'active', includeInactive: true, scope: 'my_work', attention: 'any',
      audiences: [], tagIds: [], bot: 'bot',
    };
    fetchSessionsQueryPage.mockResolvedValue({
      sessions: [
        createSessionRecordFixture({ id: 'bot', metadata: encryptedMetadata({ path: '/repo', bot: { kind: 'bot' } }) }),
        createSessionRecordFixture({ id: 'ordinary', metadata: encryptedMetadata({ path: '/repo', tag: 'bot', summary: { text: 'Bot' } }) }),
        createSessionRecordFixture({ id: 'locked', metadata: 'unreadable-ciphertext' }),
      ],
      nextCursor: 'cursor_v1_candidates', hasNext: true,
      attentionNextCursor: 'cursor_v1_attention', attentionHasNext: true,
    });
    const { listSessions } = await import('./listSessions');
    const result = await listSessions({ credentials, accountSettings: null, query, view, includeSystem: true, resumableOnly: false });
    expect(result.sessions.map((session) => 'sessionId' in session ? session.sessionId : session.id)).toEqual(['bot']);
    expect(result).toMatchObject({
      nextCursor: 'cursor_v1_candidates', hasNext: true,
      attentionNextCursor: 'cursor_v1_attention', attentionHasNext: true,
      botFilterUnavailableCount: 1,
    });
    const ordinary = await listSessions({ credentials, accountSettings: null, query: { ...query, bot: 'ordinary' }, view,
      includeSystem: true, resumableOnly: false });
    expect(ordinary.sessions.map((session) => 'sessionId' in session ? session.sessionId : session.id)).toEqual(['ordinary']);
    expect(ordinary).toMatchObject({ botFilterUnavailableCount: 1 });
  });

  it('uses the strict query transport and preserves its ordinary and attention continuations', async () => {
    const query = {
      v: 1 as const,
      storage: 'active' as const,
      includeInactive: false,
      scope: 'assigned_to_me' as const,
      attention: 'needs_my_attention' as const,
      audiences: [{ kind: 'team' as const, teamId: 'team-1' }],
      tagIds: ['tag-1'],
      limit: 10,
    };
    const signal = new AbortController().signal;
    fetchSessionsQueryPage.mockResolvedValueOnce({
      sessions: [],
      nextCursor: 'cursor_v1_ordinary',
      hasNext: true,
      attentionNextCursor: 'cursor_v1_attention',
      attentionHasNext: true,
    });

    const { listSessions } = await import('./listSessions');
    await expect(listSessions({
      credentials,
      query,
      includeSystem: false,
      resumableOnly: false,
      signal,
    })).resolves.toEqual({
      sessions: [],
      nextCursor: 'cursor_v1_ordinary',
      hasNext: true,
      attentionNextCursor: 'cursor_v1_attention',
      attentionHasNext: true,
      queryVersion: 1,
    });

    expect(fetchSessionsQueryPage).toHaveBeenCalledWith({
      token: credentials.token,
      query,
      signal,
    });
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('reads a host-admitted Session exactly instead of paging the Account corpus', async () => {
    fetchSessionById.mockResolvedValue(createSessionRecordFixture({
      id: 'admitted-session',
      metadata: encryptedMetadata({ summary: { text: 'Admitted' }, path: '/repo/admitted' }),
    }));
    getSessionTranscript.mockResolvedValue({
      ok: true,
      sessionId: 'admitted-session',
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
    });

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      includeSystem: true,
      resumableOnly: false,
      includeRows: true,
      includeLastMessagePreview: true,
      allowedSessionIds: ['admitted-session'],
    });

    // A Session-bound principal is served by one exact read, never by an
    // Account-wide list client walking pages until its row shows up.
    expect(fetchSessionsPage).not.toHaveBeenCalled();
    expect(fetchSessionsQueryPage).not.toHaveBeenCalled();
    expect(fetchSessionById).toHaveBeenCalledTimes(1);
    expect(fetchSessionById).toHaveBeenCalledWith({
      token: credentials.token,
      sessionId: 'admitted-session',
    });
    expect(result.sessions.map((session) => session.id)).toEqual(['admitted-session']);
    expect(result.rows?.map((row) => row.id)).toEqual(['admitted-session']);
    expect(result.nextCursor).toBeNull();
    expect(result.hasNext).toBe(false);
    expect(getSessionTranscript).toHaveBeenCalledTimes(1);
    expect(getSessionTranscript).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'admitted-session',
      limit: 1,
      roles: ['user', 'assistant'],
      sessionListPreview: true,
    }));
  });

  it('answers a strict query for an admitted Session from the row facts it can prove and refuses the rest', async () => {
    const baseQuery: SessionListQueryV1 = {
      v: 1,
      storage: 'active',
      includeInactive: true,
      scope: 'all_accessible',
      attention: 'any',
      audiences: [],
      tagIds: [],
    };
    const { listSessions, SessionListAdmittedQueryUnsupportedError } = await import('./listSessions');
    const list = (query: SessionListQueryV1 & Record<string, unknown>) => listSessions({
      credentials,
      query,
      includeSystem: true,
      resumableOnly: false,
      allowedSessionIds: ['admitted-session'],
    });

    fetchSessionById.mockResolvedValue(createSessionRecordFixture({
      id: 'admitted-session',
      active: true,
      metadata: encryptedMetadata({ summary: { text: 'Admitted' }, path: '/repo/admitted' }),
    }));
    const matched = await list(baseQuery);
    expect(fetchSessionsQueryPage).not.toHaveBeenCalled();
    expect(matched).toMatchObject({
      sessions: [{ id: 'admitted-session' }],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: null,
      attentionHasNext: false,
      queryVersion: 1,
    });
    expect(parseSessionListQueryActionResultV1(matched)).toEqual(matched);

    // Storage and an active row are facts the detail row proves by itself.
    expect((await list({ ...baseQuery, storage: 'archived' })).sessions).toEqual([]);
    expect((await list({ ...baseQuery, includeInactive: false })).sessions.map((session) => session.id))
      .toEqual(['admitted-session']);

    // An Account-corpus continuation is already past the one admitted row.
    expect((await list({ ...baseQuery, cursor: 'caller-account-cursor' })).sessions).toEqual([]);

    // Scope, attention, audiences and tags are the server's meaning; one row
    // cannot re-derive them, and a silently empty page would be a wrong answer.
    await expect(list({ ...baseQuery, scope: 'my_work' })).rejects.toBeInstanceOf(SessionListAdmittedQueryUnsupportedError);
    await expect(list({ ...baseQuery, attention: 'needs_my_attention' })).rejects.toMatchObject({ arms: ['attention'] });
    await expect(list({ ...baseQuery, tagIds: ['tag'] })).rejects.toMatchObject({ arms: ['tagIds'] });

    // `includeInactive:false` keeps an inactive row only when it needs attention,
    // which is the same server-owned meaning.
    fetchSessionById.mockResolvedValue(createSessionRecordFixture({
      id: 'admitted-session',
      active: false,
      metadata: encryptedMetadata({ summary: { text: 'Admitted' }, path: '/repo/admitted' }),
    }));
    await expect(list({ ...baseQuery, includeInactive: false })).rejects.toMatchObject({ arms: ['includeInactive'] });
  });

  it('projects an admitted awareness page without any Account continuation', async () => {
    const query = {
      v: 1 as const,
      storage: 'active' as const,
      includeInactive: true,
      scope: 'all_accessible' as const,
      attention: 'any' as const,
      includeAttention: true,
      audiences: [],
      tagIds: [],
    };
    fetchSessionById.mockResolvedValue(createSessionRecordFixture({
      id: 'admitted-session',
      metadata: encryptedMetadata({ summary: { text: 'Admitted' }, path: '/repo/admitted' }),
    }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      query,
      view: 'awareness',
      includeSystem: true,
      resumableOnly: false,
      allowedSessionIds: ['admitted-session'],
    });

    expect(fetchSessionsQueryPage).not.toHaveBeenCalled();
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['admitted-session']);
    expect(result.nextCursor).toBeNull();
    expect(result.hasNext).toBe(false);
    expect(result).toMatchObject({ attentionNextCursor: null, attentionHasNext: false });
    expect(SessionAwarenessListResultV1Schema.parse(result)).toEqual(result);
    expect(parseSessionListQueryActionResultV1(result)).toEqual(result);
  });

  it('returns a marked transcript-free awareness page through the Action listing owner', async () => {
    const query = {
      v: 1 as const,
      storage: 'active' as const,
      includeInactive: false,
      scope: 'my_work' as const,
      attention: 'needs_my_attention' as const,
      includeAttention: true,
      audiences: [],
      tagIds: [],
    };
    fetchSessionsQueryPage.mockResolvedValue({
      ...createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-working',
          active: true,
          activeAt: Date.now(),
          latestTurnStatus: 'in_progress',
          metadata: encryptedMetadata({ summary: { text: 'Working session' } }),
        }),
      ], { nextCursor: null, hasNext: false }),
      attentionNextCursor: 'cursor-attention-next',
      attentionHasNext: true,
    });

    const { createSessionListActionDependency } = await import('../actions/sessionListActionDependency');
    const list = createSessionListActionDependency({ credentials });
    const result = await list({
      context: { surface: 'cli', authority: 'present_user' },
      view: 'awareness',
      query,
      includeSystem: true,
    });
    expect(result).toMatchObject({
      view: 'awareness', projectionVersion: 1,
      sessions: [{ sessionId: 'sess-working', lifecycle: 'active', operational: { primary: 'working' } }],
      nextCursor: null, hasNext: false,
      attentionNextCursor: 'cursor-attention-next', attentionHasNext: true,
    });
    expect(SessionAwarenessListResultV1Schema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(fetchSessionsQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      token: credentials.token,
      query,
    }));
    expect(fetchSessionsPage).not.toHaveBeenCalled();
    expect(getSessionTranscript).not.toHaveBeenCalled();
  });

  it('fills the requested visible limit from the page after an all-system page', async () => {
    fetchSessionsPage
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-system',
          metadata: encryptedMetadata({
            systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
          }),
        }),
      ], { nextCursor: 'cursor-after-system', hasNext: true }))
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-visible',
          metadata: encryptedMetadata({ summary: { text: 'Visible session' }, path: '/repo/visible' }),
        }),
      ], { nextCursor: 'cursor-after-visible', hasNext: true }));
    getSessionTranscript.mockResolvedValue({
      ok: true,
      sessionId: 'sess',
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
    });

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      includeRows: true,
      includeLastMessagePreview: true,
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 1 }));
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: 'cursor-after-system',
      limit: 1,
    }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-visible']);
    expect(result.rows?.map((row) => row.id)).toEqual(['sess-visible']);
    expect(result.nextCursor).toBe('cursor-after-visible');
    expect(result.hasNext).toBe(true);
    expect(getSessionTranscript).toHaveBeenCalledTimes(1);
  });

  it('caps sessions and rows to the requested limit after server initial-page expansion', async () => {
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-1',
        metadata: encryptedMetadata({ summary: { text: 'Session one' }, path: '/repo/one' }),
      }),
      createSessionRecordFixture({
        id: 'sess-2',
        metadata: encryptedMetadata({ summary: { text: 'Session two' }, path: '/repo/two' }),
      }),
      createSessionRecordFixture({
        id: 'sess-3',
        metadata: encryptedMetadata({ summary: { text: 'Session three' }, path: '/repo/three' }),
      }),
      createSessionRecordFixture({
        id: 'sess-4',
        metadata: encryptedMetadata({ summary: { text: 'Session four' }, path: '/repo/four' }),
      }),
    ], { nextCursor: 'cursor-2', hasNext: true }));
    getSessionTranscript.mockResolvedValue({
      ok: true,
      sessionId: 'sess',
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
    });

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      includeRows: true,
      includeLastMessagePreview: true,
      limit: 2,
    });

    expect(fetchSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-1', 'sess-2']);
    expect(result.rows?.map((row) => row.id)).toEqual(['sess-1', 'sess-2']);
    expect(result.nextCursor).toBe('cursor-2');
    expect(result.hasNext).toBe(true);
    expect(getSessionTranscript).toHaveBeenCalledTimes(2);
  });

  it('fills the requested visible limit after the resumable filter removes an initial page', async () => {
    const resumableMetadata = encryptedMetadata({
      summary: { text: 'Resumable session' },
      path: '/repo',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
      claudeSessionId: 'vendor-resume',
      claudeTranscriptPath: '/repo/vendor-resume.jsonl',
    });
    fetchSessionsPage
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-not-resumable',
          metadata: encryptedMetadata({ summary: { text: 'Not resumable' }, path: '/repo' }),
        }),
      ], { nextCursor: 'cursor-after-not-resumable', hasNext: true }))
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-resumable',
          metadata: resumableMetadata,
        }),
      ], { nextCursor: 'cursor-after-resumable', hasNext: true }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: true,
      resumableOnly: true,
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: 'cursor-after-not-resumable',
      limit: 1,
    }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-resumable']);
    expect(result.nextCursor).toBe('cursor-after-resumable');
    expect(result.hasNext).toBe(true);
  });

  it('continues through more than 200 hidden rows without skipping a later visible session', async () => {
    const hiddenMetadata = encryptedMetadata({
      systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
    });
    const hiddenPages = Array.from({ length: 201 }, (_value, index) =>
      createSessionListResponseFixture([
        createSessionRecordFixture({ id: `sess-hidden-${index}`, metadata: hiddenMetadata }),
      ], { nextCursor: `cursor-after-hidden-${index}`, hasNext: true }));
    const visiblePage = createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-visible-after-hidden-pages',
        metadata: encryptedMetadata({ summary: { text: 'Visible session' }, path: '/repo/visible' }),
      }),
    ], { nextCursor: 'cursor-after-visible', hasNext: true });
    fetchSessionsPage.mockResolvedValueOnce(hiddenPages[0]);
    for (const page of hiddenPages.slice(1)) fetchSessionsPage.mockResolvedValueOnce(page);
    fetchSessionsPage.mockResolvedValueOnce(visiblePage);

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenCalledTimes(202);
    expect(fetchSessionsPage).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: 'cursor-after-hidden-200',
      limit: 1,
    }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-visible-after-hidden-pages']);
    expect(result.nextCursor).toBe('cursor-after-visible');
    expect(result.hasNext).toBe(true);
  });

  it('stops when a filtering continuation repeats its cursor', async () => {
    const hiddenMetadata = encryptedMetadata({
      systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
    });
    fetchSessionsPage
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({ id: 'sess-hidden-initial', metadata: hiddenMetadata }),
      ], { nextCursor: 'cursor-repeated', hasNext: true }))
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({ id: 'sess-hidden-repeated', metadata: hiddenMetadata }),
      ], { nextCursor: 'cursor-repeated', hasNext: true }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenCalledTimes(2);
    expect(result.sessions).toEqual([]);
    expect(result.nextCursor).toBe('cursor-repeated');
    expect(result.hasNext).toBe(true);
  });

  it('keeps fresh resumable page rows ahead of older pinned expansion rows before applying the limit', async () => {
    const resumableMetadata = (title: string, vendorId: string) => encryptedMetadata({
      summary: { text: title },
      path: '/repo',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
      claudeSessionId: vendorId,
      claudeTranscriptPath: `/repo/${vendorId}.jsonl`,
    });
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'pinned-oldest',
        active: false,
        encryptionMode: 'e2ee',
        updatedAt: 100,
        meaningfulActivityAt: 100,
        metadata: resumableMetadata('Pinned oldest', 'vendor-oldest'),
      }),
      createSessionRecordFixture({
        id: 'pinned-older',
        active: false,
        encryptionMode: 'e2ee',
        updatedAt: 200,
        meaningfulActivityAt: 200,
        metadata: resumableMetadata('Pinned older', 'vendor-older'),
      }),
      createSessionRecordFixture({
        id: 'fresh-page-row',
        active: false,
        encryptionMode: 'e2ee',
        updatedAt: 300,
        meaningfulActivityAt: 300,
        metadata: resumableMetadata('Fresh page row', 'vendor-fresh'),
      }),
    ], { nextCursor: 'cursor-after-fresh-page', hasNext: true }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: true,
      includeRows: true,
      limit: 2,
    });

    expect(result.sessions.map((session) => session.id)).toEqual(['fresh-page-row', 'pinned-older']);
    expect(result.rows?.map((row) => row.id)).toEqual(['fresh-page-row', 'pinned-older']);
    expect(result.nextCursor).toBe('cursor-after-fresh-page');
    expect(result.hasNext).toBe(true);
  });
});
