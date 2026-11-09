import { describe, expect, it } from 'vitest';

import { AgentExecutionRunEventV1Schema } from './agentExecutionRunV1.js';

describe('AgentExecutionRunEventV1Schema', () => {
  it('preserves a keyed authoritative output snapshot and rejects an unkeyed replacement', () => {
    const snapshot = {
      sequence: 2, runId: 'run-1', emittedAtMs: 2,
      kind: 'output-message-committed', channel: 'assistant', messageId: 'artifact', text: '',
    };
    expect(AgentExecutionRunEventV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(AgentExecutionRunEventV1Schema.safeParse({ ...snapshot, messageId: undefined }).success).toBe(false);
    expect(AgentExecutionRunEventV1Schema.safeParse({ ...snapshot, unexpected: true }).success).toBe(false);
  });

  it('accepts a bounded terminal event and rejects unknown fields and malformed variants', () => {
    expect(AgentExecutionRunEventV1Schema.safeParse({
      sequence: 1,
      runId: 'run-1',
      emittedAtMs: 2,
      kind: 'run-complete',
    }).success).toBe(true);
    expect(AgentExecutionRunEventV1Schema.safeParse({
      sequence: 1,
      runId: 'run-1',
      emittedAtMs: 2,
      kind: 'run-complete',
      unexpected: true,
    }).success).toBe(false);
    expect(AgentExecutionRunEventV1Schema.safeParse({
      sequence: 1,
      runId: 'run-1',
      emittedAtMs: 2,
      kind: 'output-delta',
      channel: 'assistant',
    }).success).toBe(false);
  });

  it('preserves complete finite output beyond the former aggregate candidate ceiling', () => {
    const base = { sequence: 1, runId: 'run-long-report', emittedAtMs: 2,
      channel: 'assistant', messageId: 'message-1', text: 'é'.repeat(1_250_001) };
    for (const kind of ['output-delta', 'output-message-committed']) {
      const event = { ...base, kind };
      expect(AgentExecutionRunEventV1Schema.parse(event)).toEqual(event);
    }
  });
});
