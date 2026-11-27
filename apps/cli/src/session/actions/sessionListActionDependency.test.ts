import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { fetchSessionById, fetchSessionsPage, fetchSessionsQueryPage, fetchSessionRuntimeManagedSubtreeQueryPage, listSessions } = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  fetchSessionsQueryPage: vi.fn(),
  fetchSessionRuntimeManagedSubtreeQueryPage: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importActual) => ({
  ...await importActual<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
  fetchSessionsPage,
  fetchSessionsQueryPage,
  fetchSessionRuntimeManagedSubtreeQueryPage,
}));

vi.mock('@/session/services/listSessions', async (importActual) => ({
  ...await importActual<typeof import('@/session/services/listSessions')>(),
  listSessions,
}));

const credentials = { token: 'daemon-token', encryption: null } as const;

const currentSessionContext = {
  surface: 'agent',
  authority: 'account_automation',
  bypassApprovals: true,
  defaultSessionId: 'runner-session',
  sessionListAccess: 'current_session',
  serverId: 'home-a',
} as const;

const allAccessibleQuery = {
  v: 1 as const,
  storage: 'active' as const,
  includeInactive: true,
  scope: 'all_accessible' as const,
  attention: 'any' as const,
  audiences: { include: [], exclude: [] },
  tagIds: { include: [], exclude: [] },
};

describe('session.list Action dependency for a current-Session principal', () => {
  beforeEach(() => {
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    fetchSessionsQueryPage.mockReset();
    fetchSessionRuntimeManagedSubtreeQueryPage.mockReset();
    listSessions.mockReset();
  });

  it('reports a query arm the admitted row cannot answer as the shared typed unsupported result', async () => {
    const { SessionListAdmittedQueryUnsupportedError } = await import('@/session/services/listSessions');
    listSessions.mockRejectedValue(new SessionListAdmittedQueryUnsupportedError(['scope']));
    const { createSessionListActionDeps } = await import('./sessionListActionDependency');
    const { sessionList } = createSessionListActionDeps({ credentials, serverId: 'home-a' });

    await expect(sessionList({
      context: currentSessionContext as never,
      query: { ...allAccessibleQuery, scope: 'my_work' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.list',
      details: { unsupportedQueryArms: ['scope'] },
    });
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({
      allowedSessionIds: ['runner-session'],
      query: { ...allAccessibleQuery, scope: 'my_work' },
    }));
  });

  it('keeps the restricted runtime reader on the same query admission as the full-credential owner', async () => {
    fetchSessionById.mockResolvedValue(createSessionRecordFixture({
      id: 'runner-session',
      encryptionMode: 'plain',
      metadata: '{}',
      active: true,
      activeAt: 1,
    }));
    const { createRestrictedCurrentSessionListActionDependency } = await import('./sessionListActionDependency');
    const sessionList = createRestrictedCurrentSessionListActionDependency({
      credentials,
      sessionId: 'runner-session',
      serverId: 'home-a',
      serverHttpBaseUrl: 'https://home-a.example.test',
      material: { mode: 'plain' },
    });

    await expect(sessionList({
      context: currentSessionContext as never,
      query: allAccessibleQuery,
    })).resolves.toMatchObject({
      sessions: [{ id: 'runner-session' }],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: null,
      attentionHasNext: false,
      queryVersion: 1,
    });

    // The detail row cannot prove assignment, attention or audience membership:
    // that meaning stays with the server, so the answer is typed, not silently empty.
    await expect(sessionList({
      context: currentSessionContext as never,
      query: { ...allAccessibleQuery, scope: 'assigned_to_me' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.list',
      details: { unsupportedQueryArms: ['scope'] },
    });
    await expect(sessionList({
      context: currentSessionContext as never,
      query: { ...allAccessibleQuery, attention: 'needs_my_attention' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });

    // Storage is a row fact, so the restricted reader still answers it exactly.
    await expect(sessionList({
      context: currentSessionContext as never,
      query: { ...allAccessibleQuery, storage: 'archived' },
    })).resolves.toMatchObject({ sessions: [], queryVersion: 1 });
    expect(fetchSessionsPage).not.toHaveBeenCalled();
    expect(fetchSessionsQueryPage).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('uses the admitted Home when the optional context Home is %s', async serverId => {
    fetchSessionById.mockResolvedValue(createSessionRecordFixture({
      id: 'runner-session', encryptionMode: 'plain', metadata: '{}', active: true, activeAt: 1,
    }));
    const { createRestrictedCurrentSessionListActionDependency } = await import('./sessionListActionDependency');
    const sessionList = createRestrictedCurrentSessionListActionDependency({
      credentials, sessionId: 'runner-session', serverId: 'home-a',
      serverHttpBaseUrl: 'https://home-a.example.test', material: { mode: 'plain' },
    });
    await expect(sessionList({ context: { ...currentSessionContext, serverId }, query: allAccessibleQuery }))
      .resolves.toMatchObject({ sessions: [{ id: 'runner-session' }], queryVersion: 1 });
  });

  it('reads Under-self through the restricted Home query and refuses any other root', async () => {
    const child = createSessionRecordFixture({ id: 'worker', encryptionMode: 'plain', metadata: '{}' });
    fetchSessionRuntimeManagedSubtreeQueryPage.mockResolvedValue({ sessions: [child], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false });
    const { createRestrictedCurrentSessionListActionDependency } = await import('./sessionListActionDependency');
    const sessionList = createRestrictedCurrentSessionListActionDependency({ credentials, sessionId: 'runner-session',
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test', material: { mode: 'plain' } });
    await expect(sessionList({ context: currentSessionContext,
      query: { ...allAccessibleQuery, underSessionId: 'runner-session' } }))
      .resolves.toMatchObject({ sessions: [{ id: 'worker' }], queryVersion: 1 });
    expect(fetchSessionRuntimeManagedSubtreeQueryPage).toHaveBeenCalledWith(expect.objectContaining({ token: credentials.token,
      query: { ...allAccessibleQuery, underSessionId: 'runner-session' } }));
    await expect(sessionList({ context: currentSessionContext,
      query: { ...allAccessibleQuery, underSessionId: 'another-coordinator' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(fetchSessionRuntimeManagedSubtreeQueryPage).toHaveBeenCalledTimes(1);
    expect(fetchSessionsQueryPage).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });
});
