import { describe, expect, it } from 'vitest';

import { mapPiRpcEventToAgentMessages } from './eventMapping';

describe('mapPiRpcEventToAgentMessages', () => {
  it('maps text deltas to model-output messages', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
    expect(output).toEqual([{ type: 'model-output', textDelta: 'hello' }]);
  });

  it('preserves leading whitespace in streamed text deltas', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: ' world' },
    });
    expect(output).toEqual([{ type: 'model-output', textDelta: ' world' }]);
  });

  it('maps tool execution lifecycle events', () => {
    const start = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'find',
      args: { pattern: '**/*.ts' },
    });
    const end = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'find',
      result: { files: ['a.ts'] },
      isError: false,
    });

    expect(start).toEqual([{ type: 'tool-call', callId: 'call-1', toolName: 'find', args: { pattern: '**/*.ts' } }]);
    expect(end).toEqual([{ type: 'tool-result', callId: 'call-1', toolName: 'find', result: { files: ['a.ts'] } }]);
  });

  it('maps turn lifecycle events to status messages', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'turn_start' })).toEqual([{ type: 'status', status: 'running' }]);
    expect(mapPiRpcEventToAgentMessages({ type: 'turn_end' })).toEqual([{ type: 'status', status: 'idle' }]);
  });

  it('returns an empty list for unknown events', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'something_new' })).toEqual([]);
  });
});
