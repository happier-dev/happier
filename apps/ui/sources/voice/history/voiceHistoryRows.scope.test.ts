import { describe, expect, it } from 'vitest';
import { createVoiceHistoryConsumer, projectVoiceHistoryRows } from './voiceHistoryConsumer';
import type { Message } from '@happier-dev/session-core/messages';

describe('Voice conversation transcript projection', () => {
  it('keeps ordinary user and agent text inside an admitted Voice conversation', () => {
    expect(projectVoiceHistoryRows([
      { id: 'question', localId: null, kind: 'user-text', text: 'RUN62D question', createdAt: 1 },
      { id: 'answer', localId: null, kind: 'agent-text', text: 'RUN62D answer', createdAt: 2 },
      { id: 'thinking', localId: null, kind: 'agent-text', text: 'private reasoning', createdAt: 3, isThinking: true },
    ], () => 'Voice').map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'RUN62D question' }, { role: 'assistant', text: 'RUN62D answer' },
    ]);
  });
  it('reads and exhausts each owned conversation once, including older conversations', async () => {
    const messages = new Map<string, Message[]>([
      ['recent', [{ id: 'recent', localId: null, kind: 'user-text', text: 'new question', createdAt: 3 }]],
      ['archived', [{ id: 'archived', localId: null, kind: 'agent-text', text: 'older answer', createdAt: 2 }]],
    ]);
    const pages: string[] = [];
    const deleted: string[] = [];
    const consumer = createVoiceHistoryConsumer({
      readScopeKey: () => 'home/account', captureScope: async () => ({ key: 'home/account' }),
      discoverHistorySession: async () => ['recent', 'archived'],
      refreshSessionMessages: async () => {}, readMessages: id => messages.get(id) ?? [],
      readMessagesRevision: id => messages.get(id)?.length ?? 0,
      subscribeHistorySources: () => () => {}, resolveProviderLabel: () => 'Voice',
      loadOlderMessages: async id => {
        pages.push(id);
        if (id === 'recent' && pages.filter(value => value === id).length === 1) {
          messages.get(id)!.push({ id: 'middle', localId: null, kind: 'user-text', text: 'middle question', createdAt: 2.5 });
          return { loaded: 1, status: 'loaded', hasMore: true };
        }
        if (id === 'archived') messages.get(id)!.push({ id: 'oldest', localId: null,
          kind: 'user-text', text: 'oldest question', createdAt: 1 });
        return { loaded: id === 'archived' ? 1 : 0, status: 'no_more', hasMore: false };
      },
      deleteSession: async id => { deleted.push(id); return { success: true }; },
      retireLocalSession: id => { messages.delete(id); },
      runCarrierOperation: operation => operation(), now: () => new Date(0),
    });
    expect((await consumer.search()).rows.map(row => row.id)).toEqual(['archived', 'recent']);
    const artifact = await consumer.exportHistory({ range: 'all' });
    expect(artifact.rowCount).toBe(4);
    expect(JSON.parse([...artifact.chunks()].join('')).entries.map((row: { id: string }) => row.id))
      .toEqual(['oldest', 'archived', 'middle', 'recent']);
    expect(pages).toEqual(['recent', 'archived', 'recent']);
    await consumer.exportHistory({ range: 'all' });
    expect(pages).toEqual(['recent', 'archived', 'recent']);
    await consumer.clear();
    expect(deleted).toEqual(['recent', 'archived']);
    expect(consumer.read().rows).toEqual([]);
    await consumer.exportHistory({ range: 'all' });
    expect(pages).toEqual(['recent', 'archived', 'recent']);
  });
});
