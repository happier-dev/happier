import { describe, expect, it } from 'vitest';

import { mapPiRpcEventToAgentMessages } from './eventMapping';

describe('mapPiRpcEventToAgentMessages', () => {
  it('maps assistant message updates to model-output fullText', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(output).toEqual([{ type: 'model-output', fullText: 'hello' }]);
  });

  it('preserves leading whitespace in model output text', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: ' world' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
    });
    expect(output).toEqual([{ type: 'model-output', fullText: 'hello world' }]);
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

  it('does not claim Pi assistant image blocks as provider-generated session media', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'pi-message-1',
        content: [
          { type: 'text', text: 'final' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'pi-image.png' },
        ],
      },
    });

    expect(output).toEqual([{ type: 'model-output', fullText: 'final' }]);
  });

  it('maps Pi tool result image blocks to tool-artifact session media events', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_end',
      toolCallId: 'tool-call-1',
      toolName: 'render_image',
      result: {
        content: [
          { type: 'text', text: 'rendered' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'tool-image.png' },
        ],
      },
    });

    expect(output).toEqual([
      {
        type: 'tool-result',
        callId: 'tool-call-1',
        toolName: 'render_image',
        result: {
          content: [
            { type: 'text', text: 'rendered' },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'tool-image.png' },
          ],
        },
      },
      {
        type: 'event',
        name: 'session_media',
        payload: {
          localId: 'pi-media-tool-call-1',
          role: 'output',
          category: 'tool-artifact',
          media: [
            {
              source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'tool-image.png' },
              suggestedName: 'tool-image.png',
              origin: {
                source: 'tool-output',
                toolCallId: 'tool-call-1',
              },
            },
          ],
        },
      },
    ]);
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
          backendId: 'pi',
          agentId: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'manual',
          source: 'provider-event',
        },
      },
    ]);

    expect(mapPiRpcEventToAgentMessages({
      type: 'compaction_end',
      reason: 'overflow',
      result: { tokensBefore: 100, tokensAfter: 40, retryAttempt: 1 },
    })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'completed',
          backendId: 'pi',
          agentId: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'overflow',
          source: 'provider-event',
          tokenCountBefore: 100,
          tokenCountAfter: 40,
          retryAttempt: 1,
        },
      },
    ]);
  });

  it('maps failed compaction events without leaking raw provider error text', () => {
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
          backendId: 'pi',
          agentId: 'pi',
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
