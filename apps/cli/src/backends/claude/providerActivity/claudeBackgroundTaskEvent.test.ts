import { describe, expect, it } from 'vitest';

import { normalizeClaudeProviderTaskEvent } from './createClaudeProviderActivityLedger';

/**
 * The durable-record projection is asserted THROUGH the shared normalizer, not through the builder
 * in isolation: the contract that matters is that one parse yields both projections from the same
 * validated row.
 */
describe('Claude background task facts', () => {
  it('stamps the kind once at ingestion and keeps the launching tool-use join key', () => {
    const facts = normalizeClaudeProviderTaskEvent({
      type: 'system',
      subtype: 'task_started',
      session_id: 'claude-session-1',
      task_id: 'task_1',
      tool_use_id: 'toolu_bash_1',
      description: 'grep -rn "thing"',
      task_type: 'local_bash',
    });

    expect(facts.backgroundTask).toEqual({
      type: 'started',
      sessionId: 'claude-session-1',
      taskId: 'task_1',
      kind: 'command',
      label: 'grep -rn "thing"',
      toolUseId: 'toolu_bash_1',
    });
    // Same row, independent liveness projection.
    expect(facts.activity).toEqual({ type: 'started', sessionId: 'claude-session-1', taskId: 'task_1' });
  });

  it('projects a durable fact even when the row does not move liveness', () => {
    // A `known-only` start is still a real task with a real description. Tying the record to the
    // admission decision would make the two fields decide each other (PLAN 8.4).
    const facts = normalizeClaudeProviderTaskEvent({
      type: 'system',
      subtype: 'task_started',
      session_id: 'claude-session-1',
      task_id: 'agent_1',
      description: 'Review the diff',
      task_type: 'subagent',
    });

    expect(facts.activity).toEqual({
      type: 'started',
      sessionId: 'claude-session-1',
      taskId: 'agent_1',
      admission: 'known-only',
    });
    expect(facts.backgroundTask).toEqual({
      type: 'started',
      sessionId: 'claude-session-1',
      taskId: 'agent_1',
      kind: 'agent',
      label: 'Review the diff',
      toolUseId: null,
    });
  });

  it('carries terminal outcome evidence and only a provider-reported end time', () => {
    expect(normalizeClaudeProviderTaskEvent({
      type: 'system',
      subtype: 'task_notification',
      session_id: 'claude-session-1',
      task_id: 'task_1',
      status: 'completed',
      summary: 'Background command completed',
      output_file: '/Users/someone/.claude/tasks/task_1.log',
    }).backgroundTask).toEqual({
      type: 'terminal',
      sessionId: 'claude-session-1',
      taskId: 'task_1',
      status: 'completed',
      summary: 'Background command completed',
      // `task_notification` carries no end time; the publisher stamps observation time instead of
      // inventing one, and `output_file` is deliberately never carried into the record.
      endedAt: null,
    });

    expect(normalizeClaudeProviderTaskEvent({
      type: 'system',
      subtype: 'task_updated',
      session_id: 'claude-session-1',
      task_id: 'task_1',
      patch: { status: 'killed', end_time: 1_770_000_000_000, error: 'Stopped by user' },
    }).backgroundTask).toEqual({
      type: 'terminal',
      sessionId: 'claude-session-1',
      taskId: 'task_1',
      status: 'stopped',
      summary: 'Stopped by user',
      endedAt: 1_770_000_000_000,
    });
  });

  it('reads progress detail and leaves non-terminal or untyped rows inert', () => {
    expect(normalizeClaudeProviderTaskEvent({
      type: 'system',
      subtype: 'task_progress',
      session_id: 'claude-session-1',
      task_id: 'task_1',
      description: 'Reading logs',
    }).backgroundTask).toEqual({
      type: 'progress',
      sessionId: 'claude-session-1',
      taskId: 'task_1',
      detail: 'Reading logs',
    });

    for (const row of [
      { type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status: 'running' } },
      { type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status: 'succeeded' },
      { type: 'system', subtype: 'task_started', task_id: 't1', description: 'no session' },
      { type: 'user', toolUseResult: { status: 'async_launched', agentId: 'a1' } },
    ]) {
      expect(normalizeClaudeProviderTaskEvent(row).backgroundTask).toBeNull();
    }
  });
});
