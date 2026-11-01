import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createVoiceHistoryListRowFixture } from './voiceConversationHistory.testkit';
import type { VoiceHistoryExportArtifact } from './voiceHistoryConsumer';
import { buildRealtimeConversationRawRecord } from '@/voice/transcript/VoiceTranscriptProjector';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
afterEach(() => standardCleanup());

describe('ordinary Voice conversations through History Actions', () => {
  it('searches and exports ordinary user/agent turns instead of the legacy direct-media carrier', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const { createDefaultVoiceHistoryConsumer } = await import('./defaultVoiceHistoryConsumer');
    const { storage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    await sync.refreshSessions();
    const session = createSessionFixture({ id: 'owned-local-voice', serverId: account.scope.serverId, seq: 2,
      metadata: { ...createSessionFixture().metadata!, name: 'Owned Local conversation',
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) } });
    const wire = await createVoiceHistoryListRowFixture(session, { credentials: account.credentials });
    const request = account.request.getMockImplementation()!;
    const reads: string[] = [];
    account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      reads.push(url.pathname);
      if (url.pathname === '/v2/sessions') return Response.json({ sessions: [wire], nextCursor: null, hasNext: false });
      if (url.pathname === '/v2/sessions/archived') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
      if (url.pathname === '/v2/sessions/lookup-by-tags') return Response.json({ sessions: [] });
      if (url.pathname === `/v2/sessions/${session.id}`) return Response.json(createPlainSessionByIdResponseFixture(session));
      if (url.pathname === `/v1/sessions/${session.id}/messages`) return Response.json(SessionMessagesPageV1Schema.parse({
        messages: url.searchParams.has('beforeSeq') ? [] : [
          { id: 'ordinary-question', localId: null, seq: 1, createdAt: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'RUN62D exact tag question' } } } },
          { id: 'ordinary-answer', localId: null, seq: 2, createdAt: 2, messageRole: 'agent',
            content: { t: 'plain', v: { ...buildRealtimeConversationRawRecord({ id: 'ordinary-answer',
              role: 'assistant', text: 'RUN62D exact tag answer' }), meta: undefined } } },
        ], hasMore: false, nextBeforeSeq: null,
      }));
      return request(input, init);
    }));
    const consumer = createDefaultVoiceHistoryConsumer();
    let artifact: VoiceHistoryExportArtifact | undefined;
    const executor = createDefaultActionExecutor({ voiceHistory: { consumer,
      saveExportArtifact: async value => { artifact = value; } } });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: account.scope.serverId, expectedAccountId: account.scope.accountId };
    expect(await executor.execute('ui.voice_global.history.search', { query: 'RUN62D exact tag' }, context))
      .toMatchObject({ ok: true, result: { loadedRowCount: 2, rows: [
        { role: 'user', text: 'RUN62D exact tag question' }, { role: 'assistant', text: 'RUN62D exact tag answer' },
      ] } });
    const coldReads = reads.length;
    await executor.execute('ui.voice_global.history.search', { query: 'answer' }, context);
    expect(reads).toHaveLength(coldReads);
    expect(await executor.execute('ui.voice_global.history.export', { range: 'all', query: 'RUN62D exact tag' }, context))
      .toMatchObject({ ok: true, result: { rowCount: 2, range: 'all' } });
    expect(artifact).toBeDefined();
    expect(JSON.parse([...artifact!.chunks()].join('')).entries.map((row: { text: string }) => row.text))
      .toEqual(['RUN62D exact tag question', 'RUN62D exact tag answer']);
    expect(reads).not.toContain('/v2/sessions/lookup-by-tags');
    expect(storage.getState().sessions[session.id]).toBeDefined();
  });
});
