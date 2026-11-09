import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createVoiceHistoryConsumer, VoiceHistoryOperationSupersededError, type VoiceHistoryExportArtifact } from './voiceHistoryConsumer';
import { buildRealtimeConversationTurnMeta } from '@/voice/transcript/VoiceTranscriptProjector';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionFixture } from '@/dev/testkit';
import { createVoiceHistoryListRowFixture } from './voiceConversationHistory.testkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT } from '@happier-dev/protocol/sessions/listing/query';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
afterEach(() => standardCleanup());

function message(id: string, text: string, createdAt: number): Message {
  return { id, localId: null, kind: 'user-text', text, createdAt,
    meta: buildRealtimeConversationTurnMeta({ pluginId: 'happier.voice.openai', contributionId: 'realtime-openai' }) };
}

describe('History through the default Action composition', () => {
  it('settles the initial search while its owner read is pending and publishes a failed read', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const discovery = createDeferred<string | null>();
    const started = createDeferred<void>();
    const consumer = createVoiceHistoryConsumer({
      readScopeKey: () => 'held-history', captureScope: async () => ({ key: 'held-history' }),
      discoverHistorySession: async () => { started.resolve(); return await discovery.promise; },
      refreshSessionMessages: async () => {},
      loadOlderMessages: async () => ({ loaded: 0, hasMore: false, status: 'no_more' }),
      readMessages: () => [], readMessagesRevision: () => 0,
      subscribeHistorySources: () => () => {}, resolveProviderLabel: () => '',
      deleteSession: async () => ({ success: true }), retireLocalSession: () => {},
      runCarrierOperation: async operation => await operation(), now: () => new Date(0),
    });
    const executor = createDefaultActionExecutor({ voiceHistory: { consumer, saveExportArtifact: async () => {} } });
    let settled = false;
    const searching = executor.execute('ui.voice_global.history.search', {}, {
      surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId,
      expectedAccountId: account.scope.accountId,
    }).then(result => { settled = true; return result; });
    await started.promise;
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      expect.soft(await searching).toMatchObject({ ok: false, errorCode: 'voice_history_loading' });
      expect(consumer.getReadState()).toBe('loading');
    } finally {
      discovery.reject(new Error('History read unavailable'));
      await searching.catch(() => {});
    }
    await vi.waitFor(() => expect(consumer.getReadState()).toBe('error'));
    expect(await executor.execute('ui.voice_global.history.search', {}, {
      surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId,
      expectedAccountId: account.scope.accountId,
    })).toMatchObject({ ok: false, errorCode: 'voice_history_load_failed' });
  });
  it('reads only an exact conversation\'s canonical Pending localIds and reasons', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const { storage } = await import('@/sync/domains/state/storage');
    const serverId = account.scope.serverId;
    const session = createSessionFixture({ id: 'held-voice', serverId, pendingCount: 1, pendingBlockedCount: 1,
      metadata: { ...createSessionFixture().metadata!,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation_retired', hidden: true }) } });
    storage.getState().applySessions([session]);
    const request = account.request.getMockImplementation()!;
    const reads: string[] = [];
    account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      reads.push(path);
      if (path === `/v2/sessions/${session.id}`) return Response.json(createPlainSessionByIdResponseFixture(session));
      if (path === `/v2/sessions/${session.id}/pending`) return Response.json({ pending: [{
        localId: 'original-local-id', messageRole: 'user', status: 'queued', deliveryState: 'blocked',
        deliveryBlockedReason: 'delivery_outcome_uncertain', position: 0, createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private held text' } } },
      }] });
      return request(input, init);
    }));
    const executor = createDefaultActionExecutor();
    const result = await executor.execute('ui.voice_global.conversations.list', {
      conversationSessionAddress: { serverId, sessionId: session.id },
    }, { surface: 'agent', authority: 'account_automation', serverId, expectedAccountId: account.scope.accountId });
    expect(result).toMatchObject({ ok: true, result: { conversations: [{ address: { serverId, sessionId: session.id },
      hasBlockedInputs: true, pendingInputs: [{ localId: 'original-local-id', reason: 'delivery_outcome_uncertain' }] }] } });
    expect(reads.filter(path => path === '/v2/sessions' || path === '/v2/sessions/archived')).toEqual([]);
    expect(reads.filter(path => path.endsWith('/messages'))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private held text');
  });
  it.each(['plain', 'e2ee'] as const)('fills a Voice page past 1,000 unrelated summaries without reading bodies (%s Account)', async mode => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}), { mode });
    onTestFinished(account.dispose);
    const { storage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
    // Account restoration owns an independent initial Sessions snapshot. Settle
    // its public refresh before measuring this secondary consumer's page reads.
    await sync.refreshSessions();
    const request = account.request.getMockImplementation()!;
    const pages: string[] = [];
    const nextCursor = encodeV2SessionListCursorV1('voice-page-end');
    const unrelatedPages = 1_000 / SESSION_LIST_PAGE_DEFAULT_LIMIT;
    let bodyReads = 0;
    const wire = async (id: string, archived: boolean, voice = true) => {
      const session = createSessionFixture({ id, archivedAt: archived ? 20 : null,
        metadata: { ...createSessionFixture().metadata!,
          ...(voice ? buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) : {}), name: id } });
      return createVoiceHistoryListRowFixture(session, { credentials: account.credentials, mode });
    };
    account.request.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/archived') {
        pages.push(`${url.pathname}:${url.searchParams.get('cursor') ?? 'first'}`);
        const archived = url.pathname.endsWith('/archived');
        const cursor = url.searchParams.get('cursor');
        const ordinaryPage = cursor === null ? 0 : Array.from({ length: unrelatedPages }, (_, i) => encodeV2SessionListCursorV1(`ordinary-${i}`)).indexOf(cursor) + 1;
        const unrelated = !archived && ordinaryPage >= 0 && ordinaryPage < unrelatedPages && cursor !== nextCursor;
        const sessions = archived ? [await wire('archived-voice', true)]
          : unrelated ? await Promise.all(Array.from({ length: SESSION_LIST_PAGE_DEFAULT_LIMIT }, (_, i) => wire(`ordinary-${ordinaryPage * SESSION_LIST_PAGE_DEFAULT_LIMIT + i}`, false, false)))
          : cursor === nextCursor ? [await wire('older-voice', false)]
          : await Promise.all(Array.from({ length: SESSION_LIST_PAGE_DEFAULT_LIMIT }, (_, i) => wire(`recent-voice-${i}`, false)));
        return Response.json({ sessions,
          nextCursor: archived || cursor === nextCursor ? null : unrelated ? encodeV2SessionListCursorV1(`ordinary-${ordinaryPage}`) : nextCursor,
          hasNext: !archived && cursor !== nextCursor,
          attentionNextCursor: null, attentionHasNext: false });
      }
      if (/\/sessions\/[^/]+(?:\/messages)?$/.test(url.pathname) || url.pathname.endsWith('/sessions/read-batch')) bodyReads += 1;
      return request(input, init);
    });
    const executor = createDefaultActionExecutor();
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: account.scope.serverId, expectedAccountId: account.scope.accountId };
    const first = await executor.execute('ui.voice_global.conversations.list', {}, context);
    // Traverse the unrelated summary windows, fill one Voice page, and read archives once.
    expect(pages).toHaveLength(unrelatedPages + 2);
    expect(first).toMatchObject({ ok: true, result: { coverage: 'loaded', coverageComplete: false,
      nextCursor: { active: nextCursor, archived: null }, conversations: expect.arrayContaining([
        expect.objectContaining({ address: { serverId: account.scope.serverId, sessionId: 'recent-voice-0' } }),
        expect.objectContaining({ address: { serverId: account.scope.serverId, sessionId: 'archived-voice' } }),
      ]) } });
    const second = await executor.execute('ui.voice_global.conversations.list', { cursor: { active: nextCursor, archived: null } }, context);
    expect(pages).toHaveLength(unrelatedPages + 3);
    expect(pages.at(-1)).toBe(`/v2/sessions:${nextCursor}`);
    expect(second).toMatchObject({ ok: true, result: { coverageComplete: true, nextCursor: null,
      conversations: expect.arrayContaining([expect.objectContaining({ address: { serverId: account.scope.serverId, sessionId: 'older-voice' } })]) } });
    expect(bodyReads).toBe(0);
  });
  it('keeps exhausted discovery incomplete when a summary owner envelope cannot be opened', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}), { mode: 'e2ee' });
    onTestFinished(account.dispose);
    const { storage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
    await sync.refreshSessions();
    const row = await createVoiceHistoryListRowFixture(createSessionFixture({ id: 'unreadable-voice',
      metadata: { ...createSessionFixture().metadata!,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) } }),
      { credentials: account.credentials, mode: 'e2ee' });
    const request = account.request.getMockImplementation()!;
    let transcriptReads = 0;
    account.request.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return Response.json({
        sessions: path.endsWith('/archived') ? [] : [{ ...row, displayProjectionV1: {
          ...row.displayProjectionV1, owner: { t: 'encrypted', c: 'unreadable-ciphertext' },
        } }], nextCursor: null, hasNext: false,
      });
      if (path.endsWith('/messages')) transcriptReads += 1;
      return request(input, init);
    });
    const result = await createDefaultActionExecutor().execute('ui.voice_global.conversations.list', {}, {
      surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId,
      expectedAccountId: account.scope.accountId,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { coverageComplete: false, nextCursor: null, conversations: [] } });
    expect(transcriptReads).toBe(0);
  });
  it('cancels a requested Session page when its Action caller leaves', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const request = account.request.getMockImplementation()!;
    const started = createDeferred<AbortSignal>();
    account.request.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === '/v2/sessions') {
        const signal = init?.signal;
        if (!signal) throw new Error('Session page request must retain Action cancellation');
        started.resolve(signal);
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return request(input, init);
    });
    const abort = new AbortController();
    const reading = createDefaultActionExecutor().execute('ui.voice_global.conversations.list', {}, {
      surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId,
      expectedAccountId: account.scope.accountId, signal: abort.signal,
    });
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    abort.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal.aborted).toBe(true);
  });
  it('VI-LIFE compact Voice history does not turn unknown continuation eligibility into a refusal', async () => {
    const serverId = 'voice-history-home';
    const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
    const { readVoiceConversationHistory } = await import('./voiceConversationHistory');
    const row = buildSessionListRenderableFromSession(createSessionFixture({
      id: 'continued-conversation', serverId, active: true, pendingCount: 2, pendingBlockedCount: 2,
      metadata: { ...createSessionFixture().metadata!,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }), name: 'My discussion' },
    }));
    const history = readVoiceConversationHistory({ sessions: {},
      sessionListRowsByServerId: { [serverId]: { [row.id]: row } },
    });
    expect(history.conversations).toHaveLength(1);
    expect(history.conversations[0]).toMatchObject({
      address: { serverId, sessionId: row.id }, title: 'My discussion',
    });
    // A compact custody row proves the address, not active-versus-retired eligibility.
    // Dispatch can hydrate that exact conversation; absence of its body is not refusal.
    expect(history.conversations[0]?.hasBlockedInputs).toBe(true);
    expect(history.conversations[0]?.canContinue).not.toBe(false);
  });
  it('VI-LIFE lists exact retained conversations and opens retired custody without loading transcripts', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const { storage } = await import('@/sync/domains/state/storage');
    const serverId = account.scope.serverId;
    const previous = storage.getState().sessions;
    onTestFinished(() => storage.setState({ sessions: previous }));
    storage.setState({ sessions: Object.fromEntries([
      ['a', 'voice_conversation', 'My first discussion', 11],
      ['b', 'voice_conversation_retired', 'Earlier discussion', 22],
      ['ordinary', 'other', 'Coding', 33],
    ].map(([id, key, title, updatedAt]) => [id, createSessionFixture({ id: String(id), serverId,
      updatedAt: Number(updatedAt), meaningfulActivityAt: Number(updatedAt), metadata: { ...createSessionFixture().metadata!,
        ...buildSystemSessionMetadataV1({ key: String(key), hidden: true }), name: String(title) } })])) });
    // The client can retain rows from another Home; this Account's Action
    // must not disclose them merely because the UI cache has seen them.
    storage.setState(state => ({ sessions: { ...state.sessions,
      'foreign-conversation': createSessionFixture({ id: 'foreign-conversation', serverId: 'other-home',
        updatedAt: 44, metadata: { ...createSessionFixture().metadata!,
          ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }), name: 'Other Home private discussion' } }),
    } }));
    const navigations: string[] = [];
    const request = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (input, init) => new URL(String(input)).pathname === '/v2/sessions/archived'
      ? Response.json({ sessions: [], nextCursor: null, hasNext: false }) : request(input, init));
    const executor = createDefaultActionExecutor({ openRoute: async href => { navigations.push(href); } });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      serverId, expectedAccountId: account.scope.accountId };
    const result = await executor.execute('ui.voice_global.conversations.list', {}, context);
    if (result.ok) {
      const parsed = VoiceConversationActionOutputSchemas['ui.voice_global.conversations.list'].parse(result.result);
      expect(parsed.conversations.some(row => row.address.serverId === 'other-home')).toBe(false);
    }
    expect(result).toMatchObject({ ok: true, result: { coverage: 'loaded', conversations: [
      { address: { serverId, sessionId: 'b' }, title: 'Earlier discussion', lastActivityAt: 22, canContinue: false },
      { address: { serverId, sessionId: 'a' }, title: 'My first discussion', lastActivityAt: 11, canContinue: true },
    ] } });
    if (result.ok) expect(VoiceConversationActionOutputSchemas['ui.voice_global.conversations.list'].safeParse(result.result).success).toBe(true);
    expect(await executor.execute('ui.voice_global.conversations.open', { conversationSessionAddress: { serverId, sessionId: 'b' } }, context))
      .toMatchObject({ ok: true, result: { status: 'completed' } });
    expect(navigations[0]).toContain('b');
  });
  it('searches without rereading history, pages and streams a filtered complete export, then clears only its carrier', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const scopeKey = `${account.scope.serverId}/${account.scope.accountId}`;
    const history: Message[] = [message('latest', 'Release shipped', 30)];
    const ordinary = [message('ordinary', 'Ordinary Session stays', 1)];
    const sessions = new Map([['history', history], ['ordinary', ordinary]]);
    let historyReads = 0;
    let revision = 0;
    let page = 0;
    let scopeReplaced = false;
    const consumer = createVoiceHistoryConsumer({
      readScopeKey: () => scopeKey,
      captureScope: async () => {
        if (scopeReplaced) throw new VoiceHistoryOperationSupersededError();
        return { key: scopeKey };
      },
      discoverHistorySession: async () => { historyReads += 1; return sessions.has('history') ? 'history' : null; },
      refreshSessionMessages: async () => { historyReads += 1; },
      loadOlderMessages: async () => {
        historyReads += 1;
        page += 1;
        if (page === 1) history.unshift(message('middle', 'Unrelated question', 20));
        if (page === 2) history.unshift(message('oldest', 'Release planned', 10));
        revision += 1;
        return { loaded: page <= 2 ? 1 : 0, hasMore: page < 2, status: page < 2 ? 'loaded' : 'no_more' };
      },
      readMessages: id => sessions.get(id) ?? [],
      readMessagesRevision: () => revision,
      subscribeHistorySources: () => () => {},
      resolveProviderLabel: () => 'OpenAI',
      deleteSession: async id => { sessions.delete(id); return { success: true }; },
      retireLocalSession: id => { sessions.delete(id); },
      runCarrierOperation: async operation => await operation(),
      now: () => new Date('2026-10-24T12:00:00Z'),
    });
    let exported: VoiceHistoryExportArtifact | null = null;
    const executor = createDefaultActionExecutor({ voiceHistory: { consumer,
      saveExportArtifact: async artifact => { exported = artifact; } } });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: account.scope.serverId, expectedAccountId: account.scope.accountId };
    const search = await executor.execute('ui.voice_global.history.search', { query: 'release', refresh: true }, context);
    expect(search).toMatchObject({ ok: true, result: { sessionId: 'history', rows: [{ id: 'latest' }], hasMore: null } });
    if (search.ok) expect(VoiceConversationActionOutputSchemas['ui.voice_global.history.search'].safeParse(search.result).success).toBe(true);
    const warmReads = historyReads;
    for (const query of ['Release', 'unmatched', 'OpenAI']) await executor.execute('ui.voice_global.history.search', { query }, context);
    expect(historyReads).toBe(warmReads);
    expect(await executor.execute('ui.voice_global.history.load_older', { query: 'question' }, context))
      .toMatchObject({ ok: true, result: { rows: [{ id: 'middle' }], loadedRowCount: 2, hasMore: true } });
    expect(await executor.execute('ui.voice_global.history.export', { range: 'all', query: 'release' }, context))
      .toMatchObject({ ok: true, result: { rowCount: 2, range: 'all', mimeType: 'application/json' } });
    expect(exported).not.toBeNull();
    const artifact = exported as VoiceHistoryExportArtifact | null;
    expect(JSON.parse([...artifact!.chunks()].join('')).entries.map((row: { id: string }) => row.id)).toEqual(['oldest', 'latest']);
    // An automated clear cannot reach deletion before the canonical approval owner admits it.
    const denied = await executor.execute('ui.voice_global.history.clear', {}, context);
    expect(denied.ok).toBe(false);
    expect(sessions.has('history')).toBe(true);
    const clear = await executor.execute('ui.voice_global.history.clear', {}, { ...context, surface: 'ui', authority: 'present_user',
      presentUserConfirmation: { actionId: 'ui.voice_global.history.clear' } });
    expect(clear).toMatchObject({ ok: true, result: { cleared: true } });
    expect(sessions.has('history')).toBe(false);
    expect(sessions.get('ordinary')).toBe(ordinary);
    expect(consumer.read()).toMatchObject({ sessionId: null, rows: [] });
    scopeReplaced = true;
    expect(await executor.execute('ui.voice_global.history.search', { refresh: true }, context))
      .toMatchObject({ ok: false, errorCode: 'voice_history_operation_superseded' });
  });
});
