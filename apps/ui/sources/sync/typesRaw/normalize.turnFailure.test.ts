import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './normalize';
import { createReducer, reducer } from '../reducer/reducer';

describe('failed ACP turn transcript projection', () => {
  it.each(['acp', 'codex'] as const)('retains the issue in %s turn_failed as an existing visible session notice', (type) => {
    const reason = "Required MCP server 'happier' failed to start: connection refused";
    const issue = {
      v: 1, scope: 'primary_session', status: 'failed', code: 'provider_session_error',
      source: 'provider_session_error', occurredAt: 1_000, provider: 'fx', sanitizedPreview: reason,
    } as const;
    const normalized = normalizeRawMessage('failure-1', null, 1_000, {
      role: 'agent', content: { type, provider: 'fx', data: { type: 'turn_failed', id: 'turn-1', issue } },
    });
    expect(normalized).toMatchObject({ role: 'event', content: { type: 'message', message: reason } });
    if (!normalized) throw new Error('Failure must remain visible');
    const rendered = reducer(createReducer(), [normalized]);
    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0]).toMatchObject({ kind: 'agent-event', event: { type: 'message', message: reason } });
  });
});
