import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('readRawSessionHistoryRows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not prefilter stored roles when reading event history fallbacks', async () => {
    const { readRawSessionHistoryRows } = await import('./getSessionHistory');

    // Substitute only the HTTP boundary; wire validation and semantic replay stay real.
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: {
      messages: [
        {
          id: 'message-7',
          seq: 7,
          createdAt: 70,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                data: {
                  type: 'tool-call',
                  name: 'SubAgentRun',
                  input: { runId: 'run-1' },
                },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    } });

    const rows = await readRawSessionHistoryRows({
      token: 'token',
      sessionId: 'session-1',
      mode: 'plain',
      ctx: null,
      limit: 1,
    });

    expect(rows).toMatchObject([{ id: 'message-7', role: 'user' }]);
    const request = new URL(String(get.mock.calls[0]?.[0]));
    expect(request.pathname).toBe('/v1/sessions/session-1/messages');
    expect(request.searchParams.has('roles')).toBe(false);
  });
});
