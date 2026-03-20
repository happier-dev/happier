import { describe, expect, it } from 'vitest';

import type { SDKUserMessage } from '@/backends/claude/sdk';
import { convertSDKToLog } from './sdkToLogConverter';
import { asRecord, conversionContext, createConverter } from './sdkToLogConverter.testkit';

describe('SDKToLogConverter tool result mode metadata', () => {
  type ClaudeResponseMap = Parameters<typeof createConverter>[0];
  type ClaudeResponseValue = ClaudeResponseMap extends Map<string, infer TValue> | undefined ? TValue : never;
  type ClaudePermissionMode = ClaudeResponseValue extends { mode?: infer TMode } ? TMode : never;

  function createResponses(entries: Array<{ id: string; approved: boolean; mode?: ClaudePermissionMode; reason?: string }>) {
    return new Map(entries.map((entry) => [entry.id, { approved: entry.approved, mode: entry.mode, reason: entry.reason }]));
  }

  it('adds mode to tool result when available in responses', () => {
    const converter = createConverter(createResponses([{ id: 'tool_123', approved: true, mode: 'acceptEdits' }]));

    const sdkMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_123',
            content: 'Tool executed successfully',
          },
        ],
      },
    };

    const logMessage = converter.convert(sdkMessage);

    expect(logMessage).toBeTruthy();
    const record = asRecord(logMessage);
    expect(record.mode).toBe('acceptEdits');
    expect(record.toolUseResult).toBeUndefined();
  });

  it('does not add mode when response metadata is absent', () => {
    const converter = createConverter(new Map());

    const sdkMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_456',
            content: 'Tool result',
          },
        ],
      },
    };

    const logMessage = converter.convert(sdkMessage);

    expect(logMessage).toBeTruthy();
    const record = asRecord(logMessage);
    expect(record.mode).toBeUndefined();
    expect(record.toolUseResult).toBeUndefined();
  });

  it('handles mixed user content with tool results', () => {
    const converter = createConverter(createResponses([{ id: 'tool_789', approved: true, mode: 'bypassPermissions' }]));

    const sdkMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the result:' },
          {
            type: 'tool_result',
            tool_use_id: 'tool_789',
            content: 'Tool output',
          },
        ],
      },
    };

    const logMessage = converter.convert(sdkMessage);

    expect(logMessage).toBeTruthy();
    const record = asRecord(logMessage);
    expect(record.mode).toBe('bypassPermissions');
    expect(record.toolUseResult).toBeUndefined();
  });

  it('works with convenience function and response map', () => {
    const responses = createResponses([{ id: 'tool_abc', approved: false, mode: 'plan', reason: 'User rejected' }]);

    const sdkMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_abc',
            content: 'Permission denied',
          },
        ],
      },
    };

    const logMessage = convertSDKToLog(sdkMessage, conversionContext, responses);

    expect(logMessage).toBeTruthy();
    const record = asRecord(logMessage);
    expect(record.mode).toBe('plan');
  });

  it('embeds tool_use_result into tool_result content for downstream consumers', () => {
    const converter = createConverter(new Map());

    const sdkMessage: SDKUserMessage = {
      type: 'user',
      tool_use_result: { status: 'teammate_spawned', agent_id: 'agent_1', team_name: 'probe', name: 'alpha' } as any,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_task_1',
            content: 'Agent is now running and will receive instructions via mailbox.',
          },
        ],
      },
    } as any;

    const logMessage = converter.convert(sdkMessage);
    expect(logMessage).toBeTruthy();

    const record = asRecord(logMessage);
    const message = record.message as any;
    expect(message?.role).toBe('user');
    expect(Array.isArray(message?.content)).toBe(true);
    const block = (message.content as any[])[0];
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('tool_task_1');
    expect(block.content).toEqual(
      expect.objectContaining({
        content: 'Agent is now running and will receive instructions via mailbox.',
        tool_use_result: expect.objectContaining({ status: 'teammate_spawned', agent_id: 'agent_1', team_name: 'probe' }),
      }),
    );
  });
});
