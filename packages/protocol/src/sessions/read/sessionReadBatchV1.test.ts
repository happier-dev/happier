import { describe, expect, it } from 'vitest';
import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema } from './sessionReadBatchV1.js';

describe('Session read batch V1', () => {
  it('bounds managed-subtree document demand without admitting turns or messages', () => {
    const demand = { sessionIds: ['child'], underSessionId: 'root', includeSnapshot: true, includeTurns: false, includeMessages: false };
    expect(SessionReadBatchRequestV1Schema.safeParse(demand).success).toBe(true);
    for (const change of [{ includeTurns: true }, { includeTurns: undefined }, { includeMessages: true }, { includeSnapshot: false }, { underSessionId: '' }]) {
      expect(SessionReadBatchRequestV1Schema.safeParse({ ...demand, ...change }).success).toBe(false);
    }
  });

  it('admits explicit detail-only demand without weakening snapshot or messages-only defaults', () => {
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], includeSnapshot: true, includeTurns: false }).success).toBe(true);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], includeSnapshot: false, includeMessages: true }).success).toBe(true);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], includeSnapshot: false, includeMessages: true, includeTurns: true }).success).toBe(false);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], includeTurns: 'false' }).success).toBe(false);
  });

  it('admits independent snapshot and message demands without an id-count cutoff', () => {
    expect(SessionReadBatchRequestV1Schema.parse({ sessionIds: ['session'] })).toEqual({
      sessionIds: ['session'], includeSnapshot: true, includeMessages: false,
    });
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: Array.from({ length: 1001 }, (_, i) => String(i)) }).success).toBe(true);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], includeSnapshot: false, includeMessages: true }).success).toBe(true);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], includeSnapshot: false, includeMessages: false }).success).toBe(false);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], accountId: 'other' }).success).toBe(false);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: [''] }).success).toBe(false);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], accessProjectionVersion: 1 }).success).toBe(true);
    expect(SessionReadBatchRequestV1Schema.safeParse({ sessionIds: ['session'], accessProjectionVersion: 2 }).success).toBe(false);
  });

  it('preserves per-component failures and validates content framing', () => {
    const result = { results: [{ sessionId: 'session',
      turns: { status: 404, body: { error: 'Session not found' } },
      messages: { status: 200, body: { messages: [{ id: 'message', seq: 1,
        content: { t: 'encrypted', c: 'sealed' }, createdAt: 1 }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } },
    }] };
    expect(SessionReadBatchResponseV1Schema.parse(result)).toEqual(result);
    expect(SessionReadBatchResponseV1Schema.safeParse({ results: [{ ...result.results[0],
      messages: { status: 200, body: { messages: [{ id: 'message', seq: 1, createdAt: 1, content: { c: 'unframed' } }] } },
    }] }).success).toBe(false);
    expect(SessionReadBatchResponseV1Schema.safeParse({ ...result, accountId: 'other' }).success).toBe(false);
  });

});
