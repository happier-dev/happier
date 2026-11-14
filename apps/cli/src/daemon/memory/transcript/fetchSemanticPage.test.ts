import { describe, expect, it, vi } from 'vitest';

import type { FetchTranscriptRawPage } from '@/session/services/transcript/fetchTranscriptSemanticPage';

import { fetchMemorySemanticTranscriptPage } from './fetchSemanticPage';

const contentContext = { mode: 'plain', ctx: null } as const;

describe('fetchMemorySemanticTranscriptPage', () => {
  it('includes tool results when outputs alone are enabled and excludes tool calls', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockResolvedValue({
      messages: [
        {
          id: 'tool-call',
          seq: 1,
          createdAt: 1000,
          messageRole: 'agent',
          content: { t: 'plain', v: {
            role: 'agent',
            content: { type: 'acp', agentId: 'codex', data: { type: 'tool-call', name: 'Bash', callId: 'call-1' } },
          } },
        },
        {
          id: 'tool-result',
          seq: 2,
          createdAt: 2000,
          messageRole: 'agent',
          content: { t: 'plain', v: {
            role: 'agent',
            content: { type: 'acp', agentId: 'codex', data: { type: 'tool-result', callId: 'call-1', output: 'memory tool result' } },
          } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });
    const page = await fetchMemorySemanticTranscriptPage({
      token: 'token',
      sessionId: 'sess-tools',
      contentContext,
      limit: 10,
      rawPageLimit: 10,
      maxRawRowsToScan: 20,
      direction: 'after',
      contentPolicy: { includeToolSummaries: false, includeToolOutputs: true },
      fetchPage,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      seq: 2, kind: 'tool_summary', text: expect.stringContaining('memory tool result'),
    });
  });

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
      contentContext,
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

  it('reads legacy null-role rows from the one role-filtered page the server already includes them in', async () => {
    // Home contract (`buildRequestedMessageRoleWhere`): a role filter containing
    // `user` also returns legacy unclassified (null-role) rows, never event rows.
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockImplementation(async (args) => ({
      messages: args.roles?.includes('user') ? [
        {
          id: 'legacy-row',
          seq: 7,
          createdAt: 7000,
          messageRole: null,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'legacy null-role memory row' } } },
        },
      ] : [],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    }));

    const page = await fetchMemorySemanticTranscriptPage({
      token: 'token',
      sessionId: 'sess-legacy',
      contentContext,
      limit: 10,
      rawPageLimit: 10,
      maxRawRowsToScan: 20,
      direction: 'after',
      afterSeq: 0,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ roles: ['user', 'agent'] }));
    expect(page.items.map((item) => item.text)).toEqual(['legacy null-role memory row']);
  });
});
