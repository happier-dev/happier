import { describe, expect, it } from 'vitest';

import { projectCodexRolloutRecord } from './actions.js';
import { createCodexRolloutSemanticTracker } from '../semanticTracker.js';

/**
 * Shapes taken from real rollout files written by the pinned recorder
 * (`session_meta.payload.cli_version` `0.145.0`) plus the pre-frontier files the
 * same reader still opens. A durable row this projector calls `unsupported`
 * fails the whole external-session page, so the grammar has to match what the
 * recorder actually persists rather than the subset Happier consumes.
 */
function project(value: unknown) {
  return projectCodexRolloutRecord(value, { debug: false });
}

describe('pinned Codex recorder grammar', () => {
  it.each([
    ['token_count', { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } }],
    ['task_started', { type: 'task_started', turn_id: 't', started_at: 1, model_context_window: 258400 }],
    ['task_complete', { type: 'task_complete', turn_id: 't' }],
    ['turn_aborted', { type: 'turn_aborted', reason: 'interrupted' }],
    ['context_compacted', { type: 'context_compacted' }],
    ['thread_settings_applied', { type: 'thread_settings_applied' }],
    ['sub_agent_activity', { type: 'sub_agent_activity', event_id: 'call_1', agent_thread_id: 'th', kind: 'interacted' }],
    ['patch_apply_end', { type: 'patch_apply_end', call_id: 'call_1', success: true }],
    ['web_search_end', { type: 'web_search_end', call_id: 'call_1', query: 'q' }],
    ['mcp_tool_call_end', { type: 'mcp_tool_call_end', call_id: 'call_1' }],
    ['agent_reasoning', { type: 'agent_reasoning', text: 'thinking out loud' }],
    ['user_message', { type: 'user_message', message: 'hello', images: [] }],
    ['exec_command_end', { type: 'exec_command_end', call_id: 'call_1', exit_code: 0 }],
    ['thread_rolled_back', { type: 'thread_rolled_back', num_turns: 1 }],
  ])('advances past the durable content-free event_msg row %s', (_label, payload) => {
    const projected = project({ timestamp: 'ts', type: 'event_msg', payload });
    expect(projected.disposition).toBe('known');
    expect(projected.actions).toEqual([]);
  });

  it.each([
    ['compacted', { type: 'compacted', payload: { message: '', replacement_history: [] } }],
    ['world_state', { type: 'world_state', payload: { full: true, state: {} } }],
    ['inter_agent_communication_metadata', { type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }],
  ])('advances past the durable content-free envelope %s', (_label, record) => {
    const projected = project({ timestamp: 'ts', ...record });
    expect(projected.disposition).toBe('known');
    expect(projected.actions).toEqual([]);
  });

  it.each([
    ['reasoning', { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAA' }],
    ['reasoning with a summary', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'planning' }] }],
    ['ghost_snapshot', { type: 'ghost_snapshot', ghost_commit: { id: 'abc', parent: 'def' } }],
    ['web_search_call', { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q' } }],
    ['agent_message', { type: 'agent_message', author: '/root', recipient: '/root/child', content: [{ type: 'input_text', text: 'NEW_TASK' }] }],
  ])('advances past the durable content-free response item %s', (_label, payload) => {
    const projected = project({ timestamp: 'ts', type: 'response_item', payload });
    expect(projected.disposition).toBe('known');
    expect(projected.actions).toEqual([]);
  });

  it('publishes the assistant turn the pinned recorder only writes as event_msg/agent_message', () => {
    const projected = project({
      timestamp: 'ts',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'the answer' },
    });
    expect(projected).toEqual({
      disposition: 'known',
      actions: [{ type: 'assistant-text', text: 'the answer' }],
    });
  });

  it('publishes a pre-frontier assistant turn exactly once when both carriers are present', () => {
    const tracker = createCodexRolloutSemanticTracker();
    const emitted = [
      { timestamp: 'ts', type: 'event_msg', payload: { type: 'agent_message', message: 'the answer' } },
      { timestamp: 'ts', type: 'event_msg', payload: { type: 'token_count', info: {} } },
      { timestamp: 'ts', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'planning' }] } },
      {
        timestamp: 'ts',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the answer' }] },
      },
    ].flatMap((record) => project(record).actions.flatMap((action) => tracker.consume(action)));
    expect(emitted).toEqual([{ type: 'assistant-text', text: 'the answer' }]);
  });

  it('still refuses a genuinely unknown durable row', () => {
    expect(project({ timestamp: 'ts', type: 'event_msg', payload: { type: 'not_a_real_codex_event' } }).disposition)
      .toBe('unsupported');
    expect(project({ timestamp: 'ts', type: 'not_a_real_codex_envelope', payload: {} }).disposition)
      .toBe('unsupported');
  });
});
