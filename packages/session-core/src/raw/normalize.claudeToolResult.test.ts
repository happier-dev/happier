import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './normalize.js';
import { createReducer, reducer } from '../reducer/reducer.js';
import { normalizeToolCallForRendering } from '../tools/normalization/core/normalizeToolCallForRendering.js';

describe('Claude canonical tool-result bodies', () => {
  it.each([
    { name: 'Bash', body: 'command output\n', native: { stdout: 'command output\n', stderr: '', exitCode: 0, backgroundTaskId: 'job-1' } },
    { name: 'Agent', body: 'Task report', native: { content: [{ type: 'text', text: 'Task report' }], status: 'completed', agentId: 'child-1', totalTokens: 42 } },
  ])('keeps the same $name result for canonical output and historical native metadata', ({ name, body, native }) => {
    const results = [
      { role: 'agent' as const, content: { type: 'acp' as const, agentId: 'claude',
        data: { type: 'tool-result' as const, id: 'result-row', callId: 'call', output: native } } },
      { role: 'agent' as const, content: { type: 'output' as const, data: {
        type: 'user' as const, uuid: 'historical', toolUseResult: native,
        message: { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'call', content: body }] },
      } } },
    ].map(raw => {
      const state = createReducer();
      const call = normalizeRawMessage('call-row', null, 1, { role: 'agent', content: { type: 'acp', agentId: 'claude',
        data: { type: 'tool-call', id: 'call-row', callId: 'call', name, input: {} } } });
      const result = normalizeRawMessage('result-row', null, 2, raw);
      if (!call || !result) throw new Error('Expected readable Claude tool rows');
      reducer(state, [call, result]);
      const id = state.toolIdToMessageId.get('call');
      const tool = id ? state.messages.get(id)?.tool : null;
      return tool ? normalizeToolCallForRendering(tool).result : null;
    });
    expect(results).toEqual([native, native]);
  });
});
