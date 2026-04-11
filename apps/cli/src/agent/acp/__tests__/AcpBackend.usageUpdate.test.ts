import { describe, it, expect } from 'vitest';

import { AcpBackend } from '../AcpBackend';

describe('AcpBackend session usage_update', () => {
  it('emits token-count telemetry from usage_update notifications', () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        used: 123,
        size: 1000,
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token).toEqual({
      type: 'token-count',
      key: 'acp-usage-update',
      source: 'acp-usage-update',
      scope: 'session_cumulative',
      tokens: { total: 123, used: 123, size: 1000 },
      context_used_tokens: 123,
      context_window_tokens: 1000,
    });
  });

  it('normalizes usage_update cost objects into canonical token-count cost totals', () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        used: 123,
        size: 1000,
        cost: {
          amount: 1.25,
          currency: 'USD',
        },
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token).toEqual({
      type: 'token-count',
      key: 'acp-usage-update',
      source: 'acp-usage-update',
      scope: 'session_cumulative',
      tokens: { total: 123, used: 123, size: 1000 },
      cost: { reportedUsd: 1.25, total: 1.25, costSource: 'provider_reported', currency: 'USD' },
      context_used_tokens: 123,
      context_window_tokens: 1000,
    });
  });

  it('accepts input/output token fields in usage_update notifications', () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token.tokens).toEqual({
      total: 19,
      input: 10,
      output: 4,
      cache_read: 3,
      cache_creation: 2,
    });
  });

  it('handles SessionNotification updates[] arrays (does not drop later updates)', () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).handleSessionUpdate({
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
          messageChunk: { textDelta: 'hello' },
        },
        {
          sessionUpdate: 'usage_update',
          used: 123,
          size: 1000,
        },
      ],
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token).toEqual({
      type: 'token-count',
      key: 'acp-usage-update',
      source: 'acp-usage-update',
      scope: 'session_cumulative',
      tokens: { total: 123, used: 123, size: 1000 },
      context_used_tokens: 123,
      context_window_tokens: 1000,
    });
  });

  it('emits token-count telemetry when task_complete includes a camelCase usage payload', () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'task_complete',
        id: 'task_1',
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token).toEqual({
      type: 'token-count',
      key: 'acp-session-update-usage',
      source: 'acp-session-update-usage',
      scope: 'turn_delta',
      tokens: { total: 5, input: 2, output: 3 },
    });
  });
});
