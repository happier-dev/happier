import { describe, expect, it } from 'vitest';

import type { SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import { CLAUDE_HANDBACK_REPORT, claudeHandbackUserRow } from '../attachments/claudePeerMessage.testkit';
import { convertSDKToLog } from './sdkToLogConverter';
import { asRecord, conversionContext, createConverter } from './sdkToLogConverter.testkit';

describe('SDKToLogConverter tool result mode metadata', () => {
  it.each(['completed', 'failed', 'stopped'] as const)('projects native queued task %s before internal filtering and preserves cancellation', status => {
    const converter = createConverter();
    const native = { type: 'attachment', uuid: 'notification', attachment: { type: 'queued_command', commandMode: 'task-notification',
      prompt: `<task-notification><task-id>task</task-id><status>${status}</status><result>final result</result></task-notification>` } };
    // Native JSONL attachment delivery is ahead of the installed SDK's declared union.
    expect(converter.convert(native as unknown as SDKMessage)).toBeNull();
    const result = converter.convert({ type: 'user', uuid: 'ack', tool_use_result: { status: 'async_launched', agentId: 'task' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Async agent launched successfully.' }] } });
    expect(result).toMatchObject({ uuid: 'notification', type: 'user', origin: { toolUseId: 'tool', status },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: status !== 'completed' }] } });
    expect(result?.isMeta).toBeUndefined();
    expect(result?.attachment).toBeUndefined();
  });

  it.each(['Delivered', '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender" from-mode="prompting">Delivered</cross-session-message>'])('preserves native SDK peer origin and displays its sender for %s', content => {
    const converter = createConverter();
    const result = converter.convert({ type: 'user', uuid: 'sdk-peer', origin: { kind: 'peer', from: 'uds:/tmp/sender.sock', name: 'Sender' },
      message: { role: 'user', content } });
    expect(result?.origin).toEqual({ kind: 'peer', from: 'uds:/tmp/sender.sock', name: 'Sender' });
    if (!result || result.type !== 'user') throw new Error('Missing SDK peer output');
    expect(result.message.content).toBe('From Sender:\n\nDelivered');
  });

  it.each(['completed', 'failed', 'stopped'] as const)('keeps a hand-back provisional until its task is %s', status => {
    const converter = createConverter();
    converter.convert({ type: 'user', uuid: 'ack-a1', tool_use_result: { status: 'async_launched', agentId: 'a1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Async agent launched successfully.' }] } });
    // Native hand-back user rows carry transcript-only fields beyond the installed SDK declaration.
    const handback = converter.convert(claudeHandbackUserRow({ withReportText: true }) as unknown as SDKMessage);
    expect(handback).toBeNull();
    expect(converter.convert({ type: 'system', subtype: 'task_notification', task_id: 'a1', status,
      summary: 'Report was delivered as a message', output_file: '/tmp/a1.output', uuid: 'done-a1', session_id: conversionContext.sessionId }))
      .toMatchObject({ type: 'user', origin: { kind: 'task-notification', status },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: [{ type: 'text', text: CLAUDE_HANDBACK_REPORT }], is_error: status !== 'completed' }] } });
    const late = converter.convert(claudeHandbackUserRow({ withReportText: true, uuid: 'late-report' }) as unknown as SDKMessage);
    expect(late).toMatchObject({ origin: { kind: 'peer' }, message: { content: `From general-purpose:\n\n${CLAUDE_HANDBACK_REPORT}` } });
  });

  it('keeps an unlinked subagent hand-back as a sender-labelled peer message', () => {
    const result = createConverter().convert(claudeHandbackUserRow({ withReportText: false }) as unknown as SDKMessage);
    expect(result).toMatchObject({ origin: { kind: 'peer', from: 'a1', name: 'general-purpose', handback: true },
      message: { content: `From general-purpose:\n\n${CLAUDE_HANDBACK_REPORT}` } });
  });

  it.each(['completed', 'failed', 'stopped'] as const)('settles a buffered hand-back on native task status %s', status => {
    const converter = createConverter();
    converter.convert({ type: 'user', uuid: 'ack-a1', tool_use_result: { status: 'async_launched', agentId: 'a1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Async agent launched successfully.' }] } });
    expect(converter.convert(claudeHandbackUserRow({ withReportText: true }) as unknown as SDKMessage)).toBeNull();
    expect(converter.convert({ type: 'attachment', uuid: 'status-a1', attachment: {
      type: 'task_status', taskId: 'a1', taskType: 'local_agent', status,
    } } as unknown as SDKMessage)).toMatchObject({ type: 'user', origin: { kind: 'task-notification', status },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1',
        content: [{ type: 'text', text: CLAUDE_HANDBACK_REPORT }], is_error: status !== 'completed' }] } });
  });

  it('settles a stopped child report while preserving the native SendMessage response', () => {
    const converter = createConverter();
    converter.convert({ type: 'user', uuid: 'ack-a1', tool_use_result: { status: 'async_launched', agentId: 'a1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Async agent launched successfully.' }] } });
    expect(converter.convert(claudeHandbackUserRow({ withReportText: true }) as unknown as SDKMessage)).toBeNull();
    const response = { success: false, message: "Agent a1 was stopped by the user and won't be resumed." };
    const result = converter.convert({ type: 'user', uuid: 'send-stop', tool_use_result: response,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'send-tool', content: JSON.stringify(response) }] } });
    if (result?.type !== 'user') throw new Error('Missing stopped child outcome');
    expect(result.toolUseResult).toBeUndefined();
    expect(result.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'send-tool',
        content: { content: JSON.stringify(response), tool_use_result: response } }),
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_a1', is_error: true,
        content: expect.objectContaining({ status: 'cancelled', result: CLAUDE_HANDBACK_REPORT }) }),
    ]));
  });

  it('keeps a buffered report with its exact tool identity when a notification names another tool', () => {
    const converter = createConverter();
    converter.convert({ type: 'user', uuid: 'ack-a1', tool_use_result: { status: 'async_launched', agentId: 'a1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Async agent launched successfully.' }] } });
    converter.convert(claudeHandbackUserRow({ withReportText: true }) as unknown as SDKMessage);
    const notification = { type: 'system' as const, subtype: 'task_notification' as const, task_id: 'a1', status: 'completed' as const,
      summary: 'Unrelated result', output_file: '/tmp/a1.output', session_id: conversionContext.sessionId };
    expect(converter.convert({ ...notification, uuid: 'other-terminal', tool_use_id: 'other-tool' } as SDKMessage))
      .toMatchObject({ message: { content: [{ tool_use_id: 'other-tool', content: [{ type: 'text', text: 'Unrelated result' }] }] } });
    expect(converter.convert({ ...notification, uuid: 'matching-terminal', tool_use_id: 'toolu_a1' } as SDKMessage))
      .toMatchObject({ message: { content: [{ tool_use_id: 'toolu_a1', content: [{ type: 'text', text: CLAUDE_HANDBACK_REPORT }] }] } });
  });

  it('projects native SDK peer text blocks as visible user content', () => {
    const result = createConverter().convert({ type: 'user', uuid: 'sdk-peer-blocks', origin: { kind: 'peer', from: 'uds:/tmp/sender.sock', name: 'Sender' },
      message: { role: 'user', content: [{ type: 'text', text: 'Delivered' }] } });
    expect(result).toMatchObject({ origin: { kind: 'peer', name: 'Sender' }, message: { content: 'From Sender:\n\nDelivered' } });
    const toolContent = [{ type: 'tool_result', tool_use_id: 'peer-tool', content: 'Tool outcome' }];
    const toolResult = createConverter().convert({ type: 'user', uuid: 'sdk-peer-tool', origin: { kind: 'peer', from: 'uds:/tmp/sender.sock', name: 'Sender' },
      message: { role: 'user', content: toolContent } });
    expect(toolResult).toMatchObject({ origin: { kind: 'peer' }, message: { content: toolContent } });
  });

  it.each([false, true])('preserves the explicit SDK parent scope for a root task-only notification (before ACK=%s)', beforeAck => {
    const converter = createConverter();
    const terminal = { type: 'system' as const, subtype: 'task_notification' as const, session_id: conversionContext.sessionId, uuid: 'nested-root-terminal', task_id: 'nested-scoped-agent', status: 'completed' as const, output_file: '/tmp/child.output', summary: 'Nested scoped outcome' };
    converter.convert({ type: 'system', subtype: 'task_started', uuid: 'optional-start', session_id: conversionContext.sessionId, task_id: 'nested-scoped-agent', description: 'Nested task' });
    if (beforeAck) expect(converter.convert(terminal)).toBeNull();
    const acknowledged = converter.convert({ type: 'user', uuid: 'nested-scope-ack', parent_tool_use_id: 'parent-tool',
      tool_use_result: { status: 'async_launched', agentId: 'nested-scoped-agent' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nested-scoped-tool', content: 'Async agent launched successfully.' }] } });
    const result = beforeAck ? acknowledged : converter.convert(terminal);
    expect(result?.type).toBe('user');
    expect(result?.sidechainId).toBe('parent-tool');
    expect(result?.isSidechain).toBe(true);
    expect(result?.origin).toMatchObject({ taskId: 'nested-scoped-agent', toolUseId: 'nested-scoped-tool' });
    const explicitOther = converter.convert({ ...terminal, uuid: 'explicit-other', tool_use_id: 'other-tool' });
    expect(explicitOther?.sidechainId).toBeUndefined();
    expect(explicitOther?.origin).toMatchObject({ toolUseId: 'other-tool' });
  });

  it('uses the exact native SDK task-start identity when a terminal has no launching ACK', () => {
    const converter = createConverter();
    // Current native frames retain these extra fields beyond the installed SDK declaration.
    const started = { type: 'system' as const, subtype: 'task_started' as const, session_id: conversionContext.sessionId,
      uuid: 'native-start', description: 'Nested native task', task_id: 'native-child', tool_use_id: 'native-child-tool', task_type: 'local_agent', is_backgrounded: true, spawn_depth: 2 };
    converter.convert(started);
    const result = converter.convert({ type: 'system', subtype: 'task_notification', session_id: conversionContext.sessionId,
      uuid: 'native-terminal', task_id: 'native-child', status: 'completed', output_file: '/tmp/child.output', summary: 'Native child outcome' });
    expect(result?.type).toBe('user');
    expect(result?.origin).toMatchObject({ kind: 'task-notification', taskId: 'native-child', toolUseId: 'native-child-tool' });
  });

  it('binds a task-only terminal received before its ACK once and clears it before a resume', () => {
    const converter = createConverter();
    const ack = { type: 'user' as const, uuid: 'late-ack', tool_use_result: { status: 'async_launched', agentId: 'early-sdk' }, message: { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'early-sdk-tool', content: 'Async agent launched successfully.' }] } };
    expect(converter.convert({ type: 'system', subtype: 'task_notification', task_id: 'early-sdk', status: 'completed', summary: 'Settled early', output_file: '/tmp/early.output', uuid: 'early-sdk-terminal', session_id: conversionContext.sessionId })).toBeNull();
    const outcome = converter.convert(ack);
    expect(outcome?.origin).toMatchObject({ kind: 'task-notification', taskId: 'early-sdk', toolUseId: 'early-sdk-tool' });
    expect(outcome?.uuid).toBe('early-sdk-terminal');
    const repeat = converter.convert({ ...ack, uuid: 'repeat-ack' });
    expect(repeat?.origin).toBeUndefined();
    converter.convert({ ...ack, uuid: 'resume-sdk', tool_use_result: { success: true, resumedAgentId: 'early-sdk' } });
    const next = converter.convert({ ...ack, uuid: 'next-ack' });
    expect(next?.origin).toBeUndefined();
    converter.convert({ ...ack, uuid: 'second-resume', tool_use_result: { success: true, resumedAgentId: 'early-sdk' } });
    expect(converter.convert({ type: 'system', subtype: 'task_notification', task_id: 'early-sdk', status: 'completed', summary: 'Resumed outcome', output_file: '/tmp/resumed.output', uuid: 'resumed-terminal', session_id: conversionContext.sessionId })).toBeNull();
    const rebound = converter.convert({ ...ack, uuid: 'resumed-ack', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'resumed-tool', content: 'Async agent launched successfully.' }] } });
    expect(rebound?.origin).toMatchObject({ taskId: 'early-sdk', toolUseId: 'resumed-tool' });
    expect(rebound?.uuid).toBe('resumed-terminal');
  });

  it.each(['completed', 'failed', 'stopped'] as const)('projects SDK task %s onto its launching tool', status => {
    const converter = createConverter();
    converter.convert({ type: 'user', uuid: 'ack-506', tool_use_result: { status: 'async_launched', agentId: 'agent_506' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_506', content: 'Async agent launched successfully.' }] } });
    const result = converter.convert({ type: 'system', subtype: 'task_notification', task_id: 'agent_506', status,
      summary: 'Findings from agent', output_file: '/tmp/agent_506.output', uuid: 'done-506', session_id: conversionContext.sessionId });
    expect(result?.type).toBe('user');
    if (!result || result.type !== 'user') throw new Error('Missing SDK native tool outcome');
    expect(result.origin).toMatchObject({ kind: 'task-notification', taskId: 'agent_506', toolUseId: 'toolu_506' });
    expect(result.isMeta).not.toBe(true);
    expect(result.message.content).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_506',
      is_error: status !== 'completed' })]);
  });

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
