import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { SessionAwarenessListResultV1Schema } from '@happier-dev/protocol';

// The Home query transport is the genuine network boundary; page currentness and
// abort behavior below are the real runtime's, replayed without a socket.
const fetchSessionListQueryPageForHome = vi.hoisted(() => vi.fn());
const acquireAdmittedSessionReferenceCorpusOptions = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/session/listing/sessionListQueryRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/domains/session/listing/sessionListQueryRuntime')>()),
  fetchSessionListQueryPageForHome: (...args: unknown[]) => fetchSessionListQueryPageForHome(...args),
}));
vi.mock('./admittedSessionReferenceCorpus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admittedSessionReferenceCorpus')>()),
  acquireAdmittedSessionReferenceCorpusOptions: (...args: unknown[]) => acquireAdmittedSessionReferenceCorpusOptions(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>()),
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

function seedSession(privacyOverrides: Record<string, unknown>): void {
  storage.setState((current) => ({
    ...current,
    settings: {
      ...settingsDefaults,
      voice: {
        ...settingsDefaults.voice,
        privacy: {
          ...settingsDefaults.voice.privacy,
          ...privacyOverrides,
        },
      },
    },
    sessions: {
      s1: {
        id: 's1',
        seq: 0,
        createdAt: 0,
        updatedAt: 100,
        active: true,
        activeAt: 0,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        agentState: null,
        metadata: {
          path: '/Users/leeroy/Documents/secret-workspace/payments',
          host: 'leeroy-mbp',
          summary: { text: 'Confidential billing rewrite', updatedAt: 0 },
        },
      },
    },
    sessionListRowsByServerId: {
      'server-a': {
        s1: { id: 's1', updatedAt: 100, active: true, presence: 'online', metadata: { summaryText: 'Confidential billing rewrite' } },
      },
    },
    ordinarySessionListMembershipByServerId: { 'server-a': ['s1'] },
    sessionListIndexByServerId: {
      'server-a': [
        { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
      ],
    },
    concurrentSessionListCacheByServerId: {},
  }) as never);
}

describe('listSessionsForVoiceTool privacy', () => {
  it('applies the Bot facet to authorized hydrated rows while reporting locked candidates and continuations', async () => {
    seedSession({ shareSessionSummary: true });
    storage.setState((current) => ({ ...current, sessionListRowsByServerId: {
      'server-a': {
        s1: { id: 's1', updatedAt: 100, active: true, metadata: { bot: { kind: 'bot' }, path: '/repo' } },
        ordinary: { id: 'ordinary', updatedAt: 99, active: true, metadata: { summaryText: 'Bot', path: '/repo' } },
        locked: { id: 'locked', updatedAt: 98, active: true, metadata: null },
      },
    } }) as never);
    fetchSessionListQueryPageForHome.mockResolvedValue({
      current: true, sessionIds: ['s1', 'ordinary', 'locked'], nextCursor: 'next', hasNext: true,
      attentionNextCursor: 'attention', attentionHasNext: true,
    });
    const { listSessionsForVoiceTool } = await import('./sessionList');
    const result = await listSessionsForVoiceTool({ query: {
      v: 1, storage: 'active', includeInactive: true, scope: 'my_work', attention: 'any',
      audiences: [], tagIds: [], bot: 'bot',
    } });
    expect(result).toMatchObject({ sessions: [{ id: 's1' }], botFilterUnavailableCount: 1,
      nextCursor: 'next', hasNext: true, attentionNextCursor: 'attention', attentionHasNext: true });
  });
  beforeEach(() => {
    fetchSessionListQueryPageForHome.mockReset();
    acquireAdmittedSessionReferenceCorpusOptions.mockReset();
    acquireAdmittedSessionReferenceCorpusOptions.mockImplementation(async (state: {
      ordinarySessionListMembershipByServerId?: Record<string, readonly string[]>;
    }) => {
      const membership = state.ordinarySessionListMembershipByServerId ?? {};
      return {
        knownServerIds: Object.keys(membership),
        coverage: 'complete' as const,
        addresses: Object.entries(membership).flatMap(([serverId, sessionIds]) =>
          sessionIds.map((sessionId) => ({ serverId, sessionId }))),
      };
    });
  });

  it('preserves another Home row timestamp and never attaches the active Home transcript with the same id', async () => {
    seedSession({ shareRecentMessages: true, shareSessionSummary: true });
    storage.setState((current) => ({
      ...current,
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: { 'other-home': { serverName: 'Other Home' } },
      ordinarySessionListMembershipByServerId: {
        'server-a': ['s1'],
        'other-home': ['s1'],
      },
      sessionListRowsByServerId: {
        'server-a': {
          s1: { id: 's1', updatedAt: 100, active: true, presence: 'online', metadata: { summaryText: 'Active session' } },
        },
        'other-home': {
          s1: { id: 's1', updatedAt: 7, active: false, presence: 'offline', metadata: { summaryText: 'Other session' } },
        },
      },
      sessionMessages: { s1: { messages: [{ id: 'message-1', kind: 'user-text', text: 'Active Home private transcript', createdAt: 100 }] } },
    }) as never);
    const { listSessionsForVoiceTool } = await import('./sessionList');
    const result = await listSessionsForVoiceTool({ includeLastMessagePreview: true });
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    const remote = result.sessions.find((session) => session.serverId === 'other-home');
    expect(remote).toMatchObject({ id: 's1', updatedAt: 7 });
    expect(remote).not.toHaveProperty('lastMessagePreview');
    expect(result.sessions.some((session) => session.serverId === getActiveServerSnapshot().serverId)).toBe(true);
  });

  it('pages equal Session ids from different Homes without dropping either qualified address', async () => {
    seedSession({ shareSessionSummary: true });
    storage.setState((current) => ({
      ...current,
      sessionListRowsByServerId: {
        ...current.sessionListRowsByServerId,
        'server-b': {
          s1: {
            id: 's1',
            updatedAt: 100,
            active: false,
            presence: 'offline',
            metadata: { summaryText: 'Same id on Home B' },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {
        'server-a': ['s1'],
        'server-b': ['s1'],
      },
      concurrentSessionListCacheByServerId: {
        'server-a': { serverName: 'Home A' },
        'server-b': { serverName: 'Home B' },
      },
    }) as never);
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const first = await listSessionsForVoiceTool({ limit: 1 });
    if ('view' in first || !first.ok) throw new Error('Expected first summary page');
    const second = await listSessionsForVoiceTool({ limit: 1, cursor: first.nextCursor });
    if ('view' in second || !second.ok) throw new Error('Expected second summary page');

    expect([
      ...first.sessions.map((session) => `${session.serverId}:${session.id}`),
      ...second.sessions.map((session) => `${session.serverId}:${session.id}`),
    ].sort()).toEqual(['server-a:s1', 'server-b:s1']);
  });

  it('reads the released delimiter cursor while publishing only qualified structured cursors', async () => {
    seedSession({ shareSessionSummary: true });
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        s0: {
          ...current.sessions.s1,
          id: 's0',
          updatedAt: 90,
          metadata: { summary: { text: 'Older session', updatedAt: 90 } },
        },
      },
      sessionListRowsByServerId: {
        'server-a': {
          ...current.sessionListRowsByServerId['server-a'],
          s0: { id: 's0', updatedAt: 90, active: false, presence: 'offline', metadata: { summaryText: 'Older session' } },
        },
      },
      ordinarySessionListMembershipByServerId: { 'server-a': ['s1', 's0'] },
    }) as never);
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const fromReleasedCursor = await listSessionsForVoiceTool({ limit: 1, cursor: '100:s1' });
    if ('view' in fromReleasedCursor || !fromReleasedCursor.ok) throw new Error('Expected summary page');

    expect(fromReleasedCursor.sessions.map((session) => session.id)).toEqual(['s0']);
    expect(JSON.parse(fromReleasedCursor.nextCursor ?? '')).toEqual([1, 90, 's0', 'server-a']);
  });

  it('uses the admitted corpus for the basic list and reports incomplete coverage', async () => {
    seedSession({ shareSessionSummary: true });
    storage.setState((current) => ({
      ...current,
      sessionListRowsByServerId: {
        'server-a': {
          admitted: {
            id: 'admitted',
            updatedAt: 30,
            active: true,
            presence: 'online',
            metadata: { summaryText: 'Admitted session' },
          },
          stale: {
            id: 'stale',
            updatedAt: 999,
            active: true,
            presence: 'online',
            metadata: { summaryText: 'Stale cache row' },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: {},
    }) as never);
    acquireAdmittedSessionReferenceCorpusOptions.mockResolvedValueOnce({
      knownServerIds: ['server-a', 'server-b'],
      coverage: 'incomplete',
      addresses: [{ serverId: 'server-a', sessionId: 'admitted' }],
    });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');

    expect(result.sessions.map((session) => session.id)).toEqual(['admitted']);
    expect(result.sessions).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'stale' })]));
    expect(result).toMatchObject({ coverage: 'incomplete' });
    expect(acquireAdmittedSessionReferenceCorpusOptions).toHaveBeenCalledWith(
      expect.objectContaining({ ordinarySessionListMembershipByServerId: {} }),
      { signal: undefined },
    );
  });
  afterEach(() => {
    storage.setState((current) => ({
      ...current,
      settings: settingsDefaults,
      sessions: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      sessionListRowsByServerId: {},
    }) as never);
  });

  it('omits the session summary title when shareSessionSummary is disabled', async () => {
    seedSession({ shareSessionSummary: false });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    const session = result.sessions[0] as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('Confidential billing rewrite');
    expect(session.id).toBe('s1');
  });

  it('keeps the session summary title when shareSessionSummary is enabled', async () => {
    seedSession({ shareSessionSummary: true });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    const session = result.sessions[0] as Record<string, unknown>;
    expect(session.title).toBe('Confidential billing rewrite');
  });

  it('omits the location label because shareFilePaths is hardened off for the voice transport', async () => {
    // `voiceSettingsParse` force-disables shareFilePaths regardless of the persisted config, so the
    // location label (a workspace path tail) must never reach the voice provider.
    seedSession({ shareSessionSummary: true, shareFilePaths: true });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    const session = result.sessions[0] as Record<string, unknown>;
    expect(session.locationLabel).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('payments');
  });

  it('uses row-only ingestion for ad-hoc awareness reads so membership owners stay untouched', async () => {
    seedSession({ shareSessionSummary: true });
    fetchSessionListQueryPageForHome.mockResolvedValue({
      current: true,
      sessionIds: ['s1'],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: 'attention-next',
      attentionHasNext: true,
    });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({ view: 'awareness' });

    expect(result).toMatchObject({
      view: 'awareness',
      nextCursor: null,
      hasNext: false,
    });
    // Lane 07 attention continuation is a strict-query fact. The ordinary read never
    // queried that family, so it reports nothing for it (the CLI host does the same).
    expect(Object.keys(result).sort()).toEqual([
      'hasNext', 'nextCursor', 'projectionVersion', 'sessions', 'view',
    ]);
    expect(result).not.toHaveProperty('queryVersion');
    expect(fetchSessionListQueryPageForHome).toHaveBeenCalledWith('server-a', expect.objectContaining({
      membership: 'rowOnly',
      source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
    }));
  });

  it('uses row-only ingestion for ad-hoc strict-query reads so mounted query membership is unchanged', async () => {
    seedSession({ shareSessionSummary: true });
    const query = {
      v: 1,
      storage: 'active',
      includeInactive: false,
      attention: 'any',
      scope: 'my_work',
      audiences: [],
      tagIds: [],
    } as const;
    fetchSessionListQueryPageForHome.mockResolvedValue({
      current: true,
      sessionIds: ['s1'],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: null,
      attentionHasNext: false,
    });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({ query });

    expect(result).toMatchObject({ ok: true, queryVersion: 1, attentionNextCursor: null, attentionHasNext: false });
    expect(fetchSessionListQueryPageForHome).toHaveBeenCalledWith('server-a', expect.objectContaining({
      membership: 'rowOnly',
      source: { kind: 'query', body: query, allowV1Fallback: false },
    }));
  });

  it('preserves Lane 07 attention continuation in strict-query awareness', async () => {
    seedSession({ shareSessionSummary: true });
    const query = {
      v: 1,
      storage: 'active',
      includeInactive: false,
      attention: 'needs_my_attention',
      scope: 'my_work',
      audiences: [],
      tagIds: [],
    } as const;
    fetchSessionListQueryPageForHome.mockResolvedValue({
      current: true,
      sessionIds: ['s1'],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: 'attention-next',
      attentionHasNext: true,
    });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({ view: 'awareness', query });

    expect(result).toMatchObject({
      view: 'awareness',
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: 'attention-next',
      attentionHasNext: true,
    });
    expect(Object.keys(result).sort()).toEqual([
      'attentionHasNext', 'attentionNextCursor', 'hasNext', 'nextCursor',
      'projectionVersion', 'sessions', 'view',
    ]);
    expect(SessionAwarenessListResultV1Schema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('reports a cancelled awareness request as cancelled rather than a stale Home response', async () => {
    seedSession({ shareSessionSummary: true });
    const controller = new AbortController();
    fetchSessionListQueryPageForHome.mockImplementation(async (_serverId: string, page: { signal: AbortSignal }) => {
      controller.abort();
      return { current: !page.signal.aborted, sessionIds: [], nextCursor: null, hasNext: false };
    });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({ view: 'awareness', signal: controller.signal });

    expect(result).toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
  });

  it('still reports a superseded Home page as a stale response when nothing was cancelled', async () => {
    seedSession({ shareSessionSummary: true });
    fetchSessionListQueryPageForHome.mockResolvedValue({
      current: false, sessionIds: [], nextCursor: null, hasNext: false,
    });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({ view: 'awareness' });

    expect(result).toMatchObject({ ok: false, errorCode: 'stale_response' });
  });
});
