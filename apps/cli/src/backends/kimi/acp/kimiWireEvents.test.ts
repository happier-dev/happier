import { describe, expect, it } from 'vitest';

import { decodeKimiWireRecord } from './kimiWireEvents';

// Wire 1.5 records captured from official Kimi 2.4.1 in the Studio VM on 2026-11-02.
// Source: MoonshotAI/kimi-code 2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7.
const toolCall = {
  type: 'context.append_loop_event', agentId: 'main',
  event: {
    type: 'tool.call', uuid: '502c53f8-553f-46a3-9c7b-8be3c337ba0f', turnId: '0', step: 1,
    stepUuid: '1052fcc8-9a34-4049-a50e-3d710ff50639', toolCallId: 'call_background', name: 'Bash',
    args: { command: 'while [ ! -f release-background ]; do sleep 0.1; done; printf background_done', run_in_background: true },
    display: { kind: 'command', command: 'while [ ! -f release-background ]; do sleep 0.1; done; printf background_done' },
  },
};

function contentRecord(part: unknown) {
  return { type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', turnId: '1', part } };
}

describe('decodeKimiWireRecord', () => {
  it('keeps exact task-origin identity without assigning user turns to a task', () => {
    expect(decodeKimiWireRecord({ type: 'metadata', protocol_version: '1.5', created_at: 1793637011919 }))
      .toEqual({ kind: 'metadata', version: '1.5' });
    expect(decodeKimiWireRecord({ type: 'turn.prompt', agentId: 'main', turnId: 1,
      origin: { kind: 'task', taskId: 'bash-qpy8ezh4', status: 'completed', notificationId: 'task:bash-qpy8ezh4:completed' },
    })).toEqual({ kind: 'turn-start', turnId: '1', originKind: 'task', taskId: 'bash-qpy8ezh4' });
    expect(decodeKimiWireRecord({ type: 'turn.prompt', agentId: 'main', turnId: 0, origin: { kind: 'user' } }))
      .toEqual({ kind: 'turn-start', turnId: '0', originKind: 'user' });
    expect(decodeKimiWireRecord({ type: 'turn.prompt', agentId: 'main', turnId: 2, origin: { kind: 'system_trigger', name: 'cron' } }))
      .toEqual({ kind: 'turn-start', turnId: '2', originKind: 'system_trigger' });
    expect(decodeKimiWireRecord({ type: 'task.started', agentId: 'main', info: {
      taskId: 'bash-qpy8ezh4', kind: 'process', detached: true, parentToolCallId: 'call_background', status: 'running',
    } })).toEqual({ kind: 'task', taskId: 'bash-qpy8ezh4', parentToolCallId: 'call_background' });
  });

  it('preserves committed text and visible thinking without publishing hidden reasoning', () => {
    expect(decodeKimiWireRecord(contentRecord({ type: 'text', text: 'KIMI_FIXTURE_BACKGROUND_COMPLETE' })))
      .toEqual({ kind: 'update', turnId: '1', updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'KIMI_FIXTURE_BACKGROUND_COMPLETE' } }] });
    // ThinkPart shape comes from pinned human/llm/message.ts; ciphertext is not display text.
    expect(decodeKimiWireRecord(contentRecord({ type: 'think', think: 'Visible reasoning', encrypted: 'opaque' })))
      .toEqual({ kind: 'update', turnId: '1', updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Visible reasoning' } }] });
    expect(decodeKimiWireRecord(contentRecord({ type: 'think', think: 'Hidden', hidden: true }))).toBeNull();
    expect(decodeKimiWireRecord(contentRecord({ type: 'text', text: '' }))).toBeNull();
  });

  it('retains native tool UUIDs and leaves ID prefixing to the admitted-turn reader', () => {
    expect(decodeKimiWireRecord(toolCall)).toMatchObject({
      kind: 'update', turnId: '0', toolCallId: 'call_background', toolCallUuid: toolCall.event.uuid,
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 'call_background', title: 'Bash', status: 'in_progress', rawInput: toolCall.event.args }],
    });
    expect(decodeKimiWireRecord({ type: 'context.append_loop_event', agentId: 'main', event: {
      type: 'tool.result', parentUuid: toolCall.event.uuid, toolCallId: 'call_background',
      result: { output: 'task_id: bash-qpy8ezh4\nstatus: running', durationMs: 3 },
    } })).toEqual({ kind: 'update', toolCallId: 'call_background', parentToolCallUuid: toolCall.event.uuid, updates: [{
      sessionUpdate: 'tool_call_update', toolCallId: 'call_background', status: 'completed',
      rawOutput: 'task_id: bash-qpy8ezh4\nstatus: running',
      content: [{ type: 'content', content: { type: 'text', text: 'task_id: bash-qpy8ezh4\nstatus: running' } }],
    }] });
  });

  it('preserves failed tool output and empty terminal results', () => {
    const resultRecord = (result: unknown) => ({ type: 'context.append_loop_event', agentId: 'main', event: {
      type: 'tool.result', parentUuid: toolCall.event.uuid, toolCallId: 'call_background', result,
    } });
    expect(decodeKimiWireRecord(resultRecord({ isError: true, output: 'approval request was cancelled' })))
      .toMatchObject({ updates: [{ status: 'failed', rawOutput: 'approval request was cancelled', content: [{ content: { text: 'approval request was cancelled' } }] }] });
    expect(decodeKimiWireRecord(resultRecord({ output: '' })))
      .toMatchObject({ updates: [{ status: 'completed', rawOutput: '', content: [] }] });
  });

  it('projects a TodoList display through the standard ACP plan update alongside the tool', () => {
    expect(decodeKimiWireRecord({ ...toolCall, event: { ...toolCall.event, name: 'TodoList', display: {
      kind: 'todo_list', items: [{ title: 'Investigate', status: 'done' }, { title: 'Repair', status: 'in_progress' }, { title: 'Verify', status: 'pending' }],
    } } })).toMatchObject({ kind: 'update', updates: [{ sessionUpdate: 'tool_call' }, { sessionUpdate: 'plan', entries: [
      { content: 'Investigate', priority: 'medium', status: 'completed' },
      { content: 'Repair', priority: 'medium', status: 'in_progress' },
      { content: 'Verify', priority: 'medium', status: 'pending' },
    ] }] });
  });

  it('preserves tool diffs without inventing media content for stored blob references', () => {
    expect(decodeKimiWireRecord({ ...toolCall, event: { ...toolCall.event, name: 'Edit', display: {
      kind: 'diff', path: '/workspace/file.ts', before: 'before', after: 'after',
    } } })).toMatchObject({ updates: [{ content: expect.arrayContaining([{ type: 'diff', path: '/workspace/file.ts', oldText: 'before', newText: 'after' }]) }] });
    expect(decodeKimiWireRecord(contentRecord({ type: 'image_url', imageUrl: { url: 'blobref:image/png;fixture' } }))).toBeNull();
  });

  it.each([
    ['completed', undefined, { kind: 'completed', stopReason: 'end_turn' }],
    ['cancelled', undefined, { kind: 'aborted', stopReason: 'cancelled' }],
    ['blocked', undefined, { kind: 'refused', stopReason: 'refusal' }],
    ['failed', { code: 'provider.filtered', message: 'filtered' }, { kind: 'refused', stopReason: 'refusal' }],
  ])('maps native terminal reason %s to the shared turn outcome', (reason, error, outcome) => {
    expect(decodeKimiWireRecord({ type: 'turn.ended', agentId: 'main', turnId: 1, reason, error }))
      .toEqual({ kind: 'turn-end', turnId: '1', outcome });
  });

  it('reports provider failure instead of marking it as successful completion', () => {
    expect(decodeKimiWireRecord({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'failed', error: { message: 'Provider unavailable' } }))
      .toEqual({ kind: 'turn-end', turnId: '1', outcome: { kind: 'failed', error: new Error('Provider unavailable') } });
  });

  it('maps committed step usage without inventing context size or counting cache details twice', () => {
    expect(decodeKimiWireRecord({ type: 'context.append_loop_event', agentId: 'main', event: {
      type: 'step.end', uuid: 'step-uuid-2', turnId: '1', step: 2, usage: { inputOther: 100, output: 10, inputCacheRead: 30, inputCacheCreation: 20 },
    } })).toEqual({ kind: 'update', turnId: '1', updates: [{ sessionUpdate: 'usage_update', key: 'kimi-step:step-uuid-2',
      inputTokens: 150, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 20,
    }] });
  });

  it('ignores foreign agents, duplicate transcript records and invalid identities', () => {
    for (const record of [
      null, [], { ...toolCall, agentId: 'child' }, { ...toolCall, agentId: undefined },
      { type: 'agent.message.appended', agentId: 'main', message: { role: 'assistant', content: [{ type: 'text', text: 'duplicate' }] } },
      { type: 'turn.prompt', agentId: 'main', turnId: -1, origin: { kind: 'user' } },
      { type: 'turn.prompt', agentId: 'main', turnId: 1, origin: { kind: 'task' } },
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'unrecognized' },
      { type: 'task.started', agentId: 'main', info: { taskId: 'task', parentToolCallId: ' ' } },
      { ...toolCall, event: { ...toolCall.event, turnId: '1:foreign' } },
      contentRecord({ type: 'text', text: { url: 'blobref:text/plain;fixture' } }),
      { type: 'context.append_loop_event', agentId: 'main', event: { type: 'step.end', turnId: '1', usage: { inputOther: 100, output: 10 } } },
    ]) expect(decodeKimiWireRecord(record)).toBeNull();
  });
});
