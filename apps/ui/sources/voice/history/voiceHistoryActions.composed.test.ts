import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createVoiceHistoryConsumer, VoiceHistoryOperationSupersededError, type VoiceHistoryExportArtifact } from './voiceHistoryConsumer';
import { buildRealtimeConversationTurnMeta } from '@/voice/transcript/VoiceTranscriptProjector';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';

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
