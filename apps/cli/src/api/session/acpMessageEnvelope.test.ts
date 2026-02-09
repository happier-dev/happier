import { describe, expect, it } from 'vitest';

import { buildAcpAgentMessageEnvelope, shouldTraceAcpMessageType } from './acpMessageEnvelope';

describe('buildAcpAgentMessageEnvelope', () => {
  it('builds a consistent ACP agent envelope with merged meta', () => {
    const envelope = buildAcpAgentMessageEnvelope({
      provider: 'codex',
      body: { type: 'message', message: 'hi' },
      meta: { foo: 'bar' },
    });

    expect(envelope).toEqual({
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'codex',
        data: { type: 'message', message: 'hi' },
      },
      meta: {
        sentFrom: 'cli',
        source: 'cli',
        foo: 'bar',
      },
    });
  });
});

describe('shouldTraceAcpMessageType', () => {
  it('returns true for standard traceable ACP tool/event types', () => {
    expect(shouldTraceAcpMessageType('tool-call')).toBe(true);
    expect(shouldTraceAcpMessageType('tool-result')).toBe(true);
    expect(shouldTraceAcpMessageType('permission-request')).toBe(true);
    expect(shouldTraceAcpMessageType('file-edit')).toBe(true);
    expect(shouldTraceAcpMessageType('terminal-output')).toBe(true);
  });

  it('supports toggling task_complete tracing', () => {
    expect(shouldTraceAcpMessageType('task_complete')).toBe(false);
    expect(shouldTraceAcpMessageType('task_complete', { includeTaskComplete: true })).toBe(true);
  });

  it('returns false for non-trace ACP message types', () => {
    expect(shouldTraceAcpMessageType('message')).toBe(false);
    expect(shouldTraceAcpMessageType('reasoning')).toBe(false);
  });
});
