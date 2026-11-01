import { describe, expect, it } from 'vitest';

import {
  CLAUDE_HANDBACK_REPORT,
  claudeAsyncAgentLaunchAck,
  claudeHandbackPointerNotification,
  claudeHandbackQueuedAttachment,
  claudeHandbackUserRow,
} from './peerMessage.testkit.js';
import { createClaudeTaskNotificationToolResultProjector, parseClaudeTaskNotification, readClaudeTaskLifecycleEnvelope } from './taskNotification.js';
import { extractToolResultBlocksFromSdkMessage } from '../runtime/remote/sdk/streamEvents.js';

const reportResult = { type: 'tool_result', tool_use_id: 'toolu_a1', content: [{ type: 'text', text: CLAUDE_HANDBACK_REPORT }], is_error: false };

describe('Claude task notification projector (subagent hand-backs)', () => {
  it('attributes a post-clear notification to its native JSONL conversation rather than the retained SDK id', () => {
    const row = { type: 'user', sessionId: 'native-after-clear', session_id: 'sdk-before-clear',
      origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>child</task-id><status>completed</status></task-notification>' } };
    expect(parseClaudeTaskNotification(row)).toMatchObject({ sourceSessionId: 'native-after-clear', taskId: 'child' });
    expect(readClaudeTaskLifecycleEnvelope(row)).toMatchObject({ sourceSessionId: 'native-after-clear', taskId: 'child' });
  });

  it.each([
    ['user row', claudeHandbackUserRow({ withReportText: false })],
    ['queued attachment', claudeHandbackQueuedAttachment()],
  ])('waits for authoritative completion before settling a correlated report (%s)', (_label, handback) => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    expect(projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }))).toBeNull();
    expect(projector.project(handback)).toEqual({ message: null });
    expect(projector.project(claudeHandbackPointerNotification({ toolUseId: 'toolu_a1' }))).toMatchObject({
      message: { type: 'user', uuid: 'pointer-notification', message: { role: 'user', content: [reportResult] } } });
  });

  it.each(['failed', 'stopped'] as const)('keeps the report with authoritative %s and leaves a later hand-back standalone', status => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }));
    projector.project(claudeHandbackUserRow({ withReportText: true }));
    const notification = claudeHandbackPointerNotification({ toolUseId: 'toolu_a1' });
    notification.attachment.prompt = notification.attachment.prompt.replace('completed', status);
    expect(projector.project(notification)).toMatchObject({ message: {
      message: { content: [{ ...reportResult, is_error: true }] },
      toolUseResult: { status: status === 'stopped' ? 'cancelled' : 'failed', result: CLAUDE_HANDBACK_REPORT },
    } });
    expect(projector.project(claudeHandbackUserRow({ withReportText: true, uuid: 'late' }))).toBeNull();
  });

  it.each(['completed', 'failed', 'stopped'] as const)('flushes a buffered report on a terminal task_status attachment (%s)', status => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }));
    projector.project(claudeHandbackUserRow({ withReportText: true }));
    expect(projector.project({ type: 'attachment', uuid: 'terminal-status', attachment: { type: 'task_status', taskId: 'a1', status } }))
      .toMatchObject({ message: { message: { content: [{ ...reportResult, is_error: status !== 'completed' }] } } });
  });

  it('keeps the stopped child report and the failed SendMessage response on their own tool identities', () => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }));
    projector.project(claudeHandbackUserRow({ withReportText: true }));
    const response = { success: false, message: "Agent a1 was stopped by the user and won't be resumed." };
    const stoppedSend = { type: 'user', uuid: 'failed-send', toolUseResult: response,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'send-message', content: response.message, is_error: true }] } };
    const projected = projector.project(stoppedSend);
    expect(extractToolResultBlocksFromSdkMessage(projected?.message)).toEqual([
      { toolUseId: 'send-message', output: { content: response.message, tool_use_result: response }, isError: true },
      { toolUseId: 'toolu_a1', output: { status: 'cancelled', result: CLAUDE_HANDBACK_REPORT }, isError: true },
    ]);
    // A later native representation must leave SendMessage's own failure visible.
    expect(projector.project({ ...stoppedSend, uuid: 'another-stopped-send' })).toBeNull();
  });

  it('leaves an unlinked hand-back to the peer message projection and keeps an ordinary completion', () => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    expect(projector.project(claudeHandbackUserRow({ withReportText: true }))).toBeNull();
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }));
    expect(projector.project(claudeHandbackPointerNotification({ toolUseId: 'toolu_a1' }))).toMatchObject({
      message: { message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', is_error: false }] } } });
  });

  it('retains the buffered report for its exact tool identity when another tool completion shares the task id', () => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }));
    projector.project(claudeHandbackUserRow({ withReportText: true }));
    const unrelated = projector.project(claudeHandbackPointerNotification({ toolUseId: 'other-tool' }));
    expect(extractToolResultBlocksFromSdkMessage(unrelated?.message)).toEqual([
      expect.objectContaining({ toolUseId: 'other-tool', output: expect.stringContaining('report was delivered') }),
    ]);
    expect(projector.project(claudeHandbackPointerNotification({ toolUseId: 'toolu_a1' }))).toMatchObject({
      message: { message: { content: [reportResult] } },
    });
  });

  it('forgets a delivered report when the agent is resumed so its next completion settles the new launch', () => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }));
    projector.project(claudeHandbackUserRow({ withReportText: true }));
    projector.project(claudeHandbackPointerNotification({ toolUseId: 'toolu_a1' }));
    projector.project({ type: 'user', uuid: 'resume', toolUseResult: { resumedAgentId: 'a1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: 'resumed' }] } });
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1_resumed', uuid: 'ack-2' }));
    expect(projector.project(claudeHandbackPointerNotification({ toolUseId: 'toolu_a1_resumed', uuid: 'pointer-2' }))).toMatchObject({
      message: { message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1_resumed' }] } } });
  });

  it.each([
    ['a different launch', claudeAsyncAgentLaunchAck({ toolUseId: 'new-tool', uuid: 'new-ack' }), 'new-tool'],
    ['a native execution restart with the same tool', {
      type: 'system', subtype: 'task_started', uuid: 'native-restart', task_id: 'a1', tool_use_id: 'toolu_a1', run_id: 'new-native-run',
    }, 'toolu_a1'],
  ] as const)('keeps repeated ACKs and unrelated completions settled, but admits %s', (_label, nextLaunch, nextToolUseId) => {
    const projector = createClaudeTaskNotificationToolResultProjector();
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1' }));
    projector.project(claudeHandbackUserRow({ withReportText: true }));
    projector.project(claudeHandbackPointerNotification({ toolUseId: 'toolu_a1' }));
    projector.project(claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_a1', uuid: 'duplicate-ack' }));
    expect(projector.project(claudeHandbackUserRow({ withReportText: true, uuid: 'late-handback' }))).toBeNull();
    expect(projector.project(claudeHandbackPointerNotification({ toolUseId: 'other-tool' }))).toMatchObject({
      message: { message: { content: [{ tool_use_id: 'other-tool' }] } },
    });
    expect(projector.project(claudeHandbackPointerNotification({ toolUseId: 'toolu_a1', uuid: 'second-terminal' }))).toEqual({ message: null });
    projector.project(nextLaunch);
    expect(projector.project(claudeHandbackUserRow({ withReportText: true, uuid: 'new-report' }))).toEqual({ message: null });
    expect(projector.project(claudeHandbackPointerNotification({ toolUseId: nextToolUseId, uuid: 'new-terminal' }))).toMatchObject({
      message: { message: { content: [{ ...reportResult, tool_use_id: nextToolUseId }] } },
    });
  });
});
