import { describe, expect, it } from 'vitest';

import {
  resolveAcpSessionMessageRole,
  resolveClaudeSessionMessageRole,
  resolveCodexSessionMessageRole,
  resolveSessionEventMessageRole,
} from './index';

describe('session message role classifiers', () => {
  it('returns the same ACP event role on repeated classification', () => {
    const body = { type: 'tool-call', callId: 'call-1', name: 'Read', input: {}, id: 'msg-1' };

    expect(resolveAcpSessionMessageRole(body as any)).toBe('event');
    expect(resolveAcpSessionMessageRole(body as any)).toBe('event');
  });

  it('classifies ACP permission responses as events', () => {
    expect(resolveAcpSessionMessageRole({ type: 'permission-response', requestId: 'r1' } as any)).toBe('event');
  });

  it('classifies ACP agent_message rows as agent messages', () => {
    expect(resolveAcpSessionMessageRole({ type: 'agent_message', text: 'assistant text' } as any)).toBe('agent');
  });

  it('returns the same Codex event role on repeated classification', () => {
    const body = { type: 'token_count', tokens: { total: 1 } };

    expect(resolveCodexSessionMessageRole(body)).toBe('event');
    expect(resolveCodexSessionMessageRole(body)).toBe('event');
  });

  it('classifies Codex tool-result aliases as events', () => {
    expect(resolveCodexSessionMessageRole({ type: 'tool-result', callId: 'call-1' })).toBe('event');
  });

  it('returns the same Claude event role on repeated classification', () => {
    const body = {
      type: 'user',
      uuid: 'user-tool-result-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    };

    expect(resolveClaudeSessionMessageRole(body)).toBe('event');
    expect(resolveClaudeSessionMessageRole(body)).toBe('event');
  });

  it('classifies Claude assistant rows with prose and tool blocks as assistant prose', () => {
    const body = {
      type: 'assistant',
      uuid: 'assistant-mixed-1',
      message: {
        content: [
          { type: 'text', text: 'I will inspect that now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
    };

    expect(resolveClaudeSessionMessageRole(body)).toBe('agent');
  });

  it('classifies unknown structured ACP data as unknown', () => {
    expect(resolveAcpSessionMessageRole({ type: 'provider-specific' })).toBe('unknown');
  });

  it('classifies unknown structured Codex data as unknown', () => {
    expect(resolveCodexSessionMessageRole({ type: 'provider-specific' })).toBe('unknown');
  });

  it('classifies unknown structured Claude data as unknown', () => {
    expect(resolveClaudeSessionMessageRole({ type: 'provider-specific' })).toBe('unknown');
  });

  it('classifies session events as event', () => {
    expect(resolveSessionEventMessageRole()).toBe('event');
  });
});
