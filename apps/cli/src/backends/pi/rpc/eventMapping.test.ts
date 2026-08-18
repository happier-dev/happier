import { describe, expect, it } from 'vitest';

import { mapPiRpcEventToAgentMessages } from './eventMapping';

describe('mapPiRpcEventToAgentMessages', () => {
  it('maps assistant text deltas from message_update to streaming model output', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
    });
    expect(output).toEqual([{ type: 'model-output', textDelta: 'hello' }]);
  });

  it('falls back to the cumulative message for message_update events that still carry one', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'hello world' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
    });
    expect(output).toEqual([{ type: 'model-output', fullText: 'hello world' }]);
  });

  it('maps thinking deltas to thinking stream events', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'I should ' },
    });
    expect(output).toEqual([{ type: 'event', name: 'thinking', payload: { text: 'I should ' } }]);
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
      isError: true,
    });

    expect(start).toEqual([{ type: 'tool-call', callId: 'call-1', toolName: 'find', args: { pattern: '**/*.ts' } }]);
    expect(end).toEqual([
      { type: 'tool-result', callId: 'call-1', toolName: 'find', result: { files: ['a.ts'] }, isError: true },
    ]);
  });

  it('maps Pi tool result image content to transient session media', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'draw',
      result: {
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      },
    });

    expect(output).toEqual([
      {
        type: 'tool-result',
        callId: 'call-1',
        toolName: 'draw',
        result: {
          content: [
            { type: 'text', text: 'done' },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
          ],
        },
      },
      {
        type: 'session-media',
        source: 'pi-tool-result',
        media: [
          {
            kind: 'base64',
            data: 'iVBORw0KGgo=',
            mimeType: 'image/png',
            origin: {
              source: 'tool-output',
              toolCallId: 'call-1',
              contentIndex: 1,
            },
            dedupeKey: expect.stringMatching(/^pi:tool-result:call-1:[a-f0-9]{64}$/),
          },
        ],
      },
    ]);
  });

  it('maps tool execution updates to streaming tool-result chunks', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
      partialResult: { content: [{ type: 'text', text: 'hi\\n' }], details: {} },
    });

    expect(output).toEqual([
      { type: 'tool-result', callId: 'call-1', toolName: 'bash', result: { _stream: true, stdoutChunk: 'hi\\n' } },
    ]);
  });

  it('emits final assistant fullText on message_end', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    });
    expect(output).toEqual([{ type: 'model-output', fullText: 'final' }]);
  });

  it('emits an authoritative thinking snapshot alongside text on message_end', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should greet the user.' },
          { type: 'text', text: 'Hi!' },
        ],
      },
    });
    expect(output).toEqual([
      { type: 'event', name: 'thinking', payload: { fullText: 'I should greet the user.' } },
      { type: 'model-output', fullText: 'Hi!' },
    ]);
  });

  it('emits the thinking snapshot for a thinking-only message_end', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} },
        ],
      },
    });
    expect(output).toEqual([{ type: 'event', name: 'thinking', payload: { fullText: 'plan' } }]);
  });

  it('joins multiple thinking blocks by concatenation to match the delta stream', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first block' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} },
          { type: 'thinking', thinking: 'second block' },
        ],
      },
    });
    expect(output).toEqual([{ type: 'event', name: 'thinking', payload: { fullText: 'first blocksecond block' } }]);
  });

  it('maps agent lifecycle events to status messages and keeps terminal boundaries informational', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'agent_start' })).toEqual([{ type: 'status', status: 'running' }]);
    expect(mapPiRpcEventToAgentMessages({ type: 'agent_end' })).toEqual([]);
    expect(mapPiRpcEventToAgentMessages({ type: 'agent_end', willRetry: true })).toEqual([]);
    expect(mapPiRpcEventToAgentMessages({ type: 'turn_start' })).toEqual([]);
    expect(mapPiRpcEventToAgentMessages({ type: 'turn_end' })).toEqual([]);
  });

  it('maps compaction lifecycle events to structured provider events', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'compaction_start', reason: 'manual' })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'started',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'manual',
          source: 'provider-event',
        },
      },
    ]);

    expect(mapPiRpcEventToAgentMessages({
      type: 'compaction_end',
      reason: 'threshold',
      result: { tokensBefore: 1234, tokensAfter: 456 },
      aborted: false,
      retryAttempt: 2,
    })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'completed',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'threshold',
          source: 'provider-event',
          tokenCountBefore: 1234,
          tokenCountAfter: 456,
          retryAttempt: 2,
        },
      },
    ]);

    expect(mapPiRpcEventToAgentMessages({
      type: 'compaction_end',
      reason: 'manual',
      cancelled: true,
    })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'cancelled',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'manual',
          source: 'provider-event',
        },
      },
    ]);
  });

  it('maps failed compaction without labeling raw provider errors as sanitized', () => {
    expect(mapPiRpcEventToAgentMessages({
      type: 'compaction_end',
      aborted: true,
      errorCode: 'context_limit',
      errorMessage: 'provider specific failure with details',
    })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'failed',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'unknown',
          source: 'provider-event',
          errorCode: 'context_limit',
        },
      },
    ]);
  });

  it('returns an empty list for unknown events', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'something_new' })).toEqual([]);
  });
});
