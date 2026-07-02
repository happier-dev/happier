import { describe, expect, it, vi } from 'vitest';

import type { FetchTranscriptRawPage } from '@/session/services/transcript/fetchTranscriptSemanticPage';

import { fetchMemorySemanticTranscriptPage } from './fetchSemanticPage';

const ctx = { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' as const };

describe('fetchMemorySemanticTranscriptPage', () => {
  it('uses server-side user and agent role filtering for memory transcript pages', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>()
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'row-1',
            seq: 5,
            createdAt: 5000,
            messageRole: 'agent',
            content: {
              t: 'plain',
              v: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'semantic assistant row' } } },
            },
          },
        ],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      })
      .mockResolvedValueOnce({
        messages: [],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      });

    const page = await fetchMemorySemanticTranscriptPage({
      token: 'token',
      sessionId: 'sess-1',
      ctx,
      limit: 10,
      rawPageLimit: 10,
      maxRawRowsToScan: 20,
      direction: 'after',
      afterSeq: 4,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      direction: 'after',
      afterSeq: 4,
      scope: 'main',
      roles: ['user', 'agent'],
    }));
    expect(page.items).toEqual([
      expect.objectContaining({
        sessionId: 'sess-1',
        seq: 5,
        role: 'assistant',
        text: 'semantic assistant row',
      }),
    ]);
  });

  it('falls back to bounded legacy null-role rows without admitting event rows', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>()
      .mockResolvedValueOnce({
        messages: [],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'event-row',
            seq: 6,
            createdAt: 6000,
            messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'event noise must not index' } } },
          },
          {
            id: 'legacy-row',
            seq: 7,
            createdAt: 7000,
            messageRole: null,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'legacy null-role memory row' } } },
          },
        ],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
      });

    const page = await fetchMemorySemanticTranscriptPage({
      token: 'token',
      sessionId: 'sess-legacy',
      ctx,
      limit: 10,
      rawPageLimit: 10,
      maxRawRowsToScan: 20,
      direction: 'after',
      afterSeq: 0,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ roles: ['user', 'agent'] }));
    expect(fetchPage).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ roles: expect.anything() }));
    expect(page.items.map((item) => item.text)).toEqual(['legacy null-role memory row']);
  });
});
