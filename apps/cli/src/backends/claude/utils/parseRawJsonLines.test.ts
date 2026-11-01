import { describe, expect, it } from 'vitest';

import { CLAUDE_PEER_TRAILER, claudeHandbackQueuedAttachment, claudeHandbackUserRow } from '../attachments/claudePeerMessage.testkit';
import { parseRawJsonLinesLine, parseRawJsonLinesObject } from './parseRawJsonLines';

describe('parseRawJsonLines', () => {
  it('projects native peer string input through the shared parser without repeating its sender on replay', () => {
    const native = { type: 'user', uuid: 'plain-peer', origin: { kind: 'peer', from: 'a1', name: 'Sender' },
      message: { role: 'user', content: 'Delivered' } };
    const parsed = parseRawJsonLinesObject(native);
    expect(parsed).toMatchObject({ origin: native.origin, message: { content: 'From Sender:\n\nDelivered' } });
    expect(parseRawJsonLinesObject(parsed)).toEqual(parsed);
  });

  it.each(['completed', 'failed', 'stopped'] as const)('retains released native task %s findings while normalizing its error status', status => {
    // cli-v0.2.16@b8d1c449c46ab4dfa8637db36b66f643d149e66d sessionScanner:452–472.
    const content = [{ type: 'text', text: 'Historical background findings' }];
    const parsed = parseRawJsonLinesObject({ type: 'user', uuid: 'released-task', isMeta: true,
      origin: { kind: 'task-notification', taskId: 'task', toolUseId: 'tool', status },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content, is_error: false }] } });
    expect(parsed).toMatchObject({ type: 'user', origin: { kind: 'task-notification', toolUseId: 'tool', status },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content, is_error: status !== 'completed' }] } });
    expect(parseRawJsonLinesObject(parsed)).toEqual(parsed);
  });

  it.each(['completed', 'failed', 'stopped'] as const)('projects native task %s before direct and history readers filter attachments', status => {
    const parsed = parseRawJsonLinesObject({ type: 'attachment', uuid: 'native-task', isMeta: true,
      attachment: { type: 'queued_command', commandMode: 'task-notification', prompt:
        `<task-notification><task-id>task</task-id><tool-use-id>tool</tool-use-id><status>${status}</status><result>final</result></task-notification>` } });
    expect(parsed).toMatchObject({ type: 'user', uuid: 'native-task', origin: { kind: 'task-notification', toolUseId: 'tool', status },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: status !== 'completed' }] } });
    expect(parsed?.isMeta).toBeUndefined();
    expect(parsed?.attachment).toBeUndefined();
  });

  it('projects a delivered native cross-session attachment with its sender and peer origin', () => {
    // Claude Code 2.1.292 delivered JSONL shape reported in #508.
    const parsed = parseRawJsonLinesObject({
      type: 'attachment', uuid: 'peer-delivered', sessionId: 'recipient', parentUuid: 'prior', isMeta: true,
      attachment: { type: 'queued_command', prompt: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender" from-mode="prompting">Hello from another session</cross-session-message>' },
    });
    expect(parsed?.type).toBe('user');
    expect(parsed?.origin).toEqual({ kind: 'peer', from: 'uds:/tmp/sender.sock', name: 'Sender' });
    expect(parsed?.uuid).toBe('peer-delivered');
    expect(parsed?.parentUuid).toBe('prior');
    expect(parsed?.isMeta).not.toBe(true);
    expect(parsed?.attachment).toBeUndefined();
    if (!parsed || parsed.type !== 'user') throw new Error('Missing native peer message');
    expect(parsed.message.content).toBe('From Sender:\n\nHello from another session');
    expect(parseRawJsonLinesObject(parsed)).toEqual(parsed);
  });

  it.each([
    { type: 'queue-operation', operation: 'enqueue', content: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender">queued</cross-session-message>' },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'ordinary queued prompt' } },
    { type: 'attachment', uuid: 'human-copied-wrapper', attachment: { type: 'queued_command', origin: { kind: 'human' },
      prompt: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender">copied queued text</cross-session-message>' } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: '<cross-session-message from="uds:/tmp/sender.sock">unterminated' } },
    { type: 'user', uuid: 'copied-peer', message: { content: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender">copied text</cross-session-message>' } },
    { type: 'user', uuid: 'copied-agent-message', message: { content: '<agent-message from="a1">copied text</agent-message>' } },
  ])('does not infer peer delivery from non-native or incomplete content', value => {
    expect(parseRawJsonLinesObject(value)?.origin).toBeUndefined();
  });

  it('uses a peer label when a native delivery has no display name without exposing its address', () => {
    const parsed = parseRawJsonLinesObject({ type: 'attachment', uuid: 'unnamed-peer', attachment: { type: 'queued_command',
      prompt: '<cross-session-message from="uds:/tmp/private-sender.sock">Delivered</cross-session-message>' } });
    expect(parsed).toMatchObject({ origin: { kind: 'peer', from: 'uds:/tmp/private-sender.sock' },
      message: { content: 'From Peer:\n\nDelivered' } });
  });

  it('preserves a quoted sender name containing angle brackets and the whole delivered body', () => {
    const parsed = parseRawJsonLinesObject({ type: 'attachment', uuid: 'quoted-peer', attachment: { type: 'queued_command',
      prompt: '<cross-session-message from="uds:/tmp/sender.sock" from-name="<Sender>" from-mode="prompting">First line\n\n<code>body</code></cross-session-message>' } });
    expect(parsed).toMatchObject({ origin: { kind: 'peer', name: '<Sender>' },
      message: { content: 'From <Sender>:\n\nFirst line\n\n<code>body</code>' } });
  });

  it.each([
    ['user row with native report text', claudeHandbackUserRow({ withReportText: true })],
    ['user row without native report text', claudeHandbackUserRow({ withReportText: false })],
    ['queued attachment', claudeHandbackQueuedAttachment()],
  ])('projects a native subagent hand-back as its clean report (%s)', (_label, value) => {
    const parsed = parseRawJsonLinesObject(value);
    expect(parsed).toMatchObject({ type: 'user', uuid: 'handback',
      message: { role: 'user', content: 'From general-purpose:\n\n**Verdict:** fixed.\n\n- detail' } });
    expect(parsed?.origin).toEqual({ kind: 'peer', from: 'a1', senderTaskId: 'a1', name: 'general-purpose', handback: true });
    expect(parsed?.isMeta).toBeUndefined();
    expect(parseRawJsonLinesObject(parsed)).toEqual(parsed);
  });

  it('projects a native teammate message without its delivery wrapper or harness trailer', () => {
    const parsed = parseRawJsonLinesObject({ type: 'user', uuid: 'teammate', isMeta: true,
      origin: { kind: 'peer', from: 'pr4', senderTaskId: 'pr4', name: 'pr4', body: 'Tests are blocked.' },
      message: { role: 'user', content: `Another Claude session sent a message:\n<agent-message from="pr4">\nTests are blocked.\n</agent-message>${CLAUDE_PEER_TRAILER}` } });
    expect(parsed).toMatchObject({ origin: { kind: 'peer', from: 'pr4', name: 'pr4' },
      message: { content: 'From pr4:\n\nTests are blocked.' } });
    expect(parseRawJsonLinesObject(parsed)).toEqual(parsed);
  });

  it('returns null for empty lines', () => {
    expect(parseRawJsonLinesLine('')).toBeNull();
    expect(parseRawJsonLinesLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseRawJsonLinesLine('{')).toBeNull();
    expect(parseRawJsonLinesLine('not json')).toBeNull();
  });

  it('parses a valid assistant message and preserves unknown fields', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      extra_field: { nested: true },
    });
    const parsed = parseRawJsonLinesLine(line);
    expect(parsed?.type).toBe('assistant');
    expect((parsed as any).uuid).toBe('u1');
    expect((parsed as any).extra_field).toEqual({ nested: true });
  });

  it('parses a valid user message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: 'hello' },
    });
    expect(parsed?.type).toBe('user');
    expect((parsed as any).uuid).toBe('u2');
  });

  it('parses a progress message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'progress',
      uuid: 'p1',
      status: 'running',
    });
    expect(parsed?.type).toBe('progress');
    expect((parsed as any)?.uuid).toBe('p1');
  });

  it('parses a goal_status attachment record and preserves the inner attachment object', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'attachment',
      uuid: 'a1',
      sessionId: 's1',
      timestamp: '2026-06-19T14:39:26.067Z',
      attachment: { type: 'goal_status', met: false, condition: 'ship it', sentinel: true },
    });
    expect(parsed?.type).toBe('attachment');
    expect((parsed as any)?.uuid).toBe('a1');
    expect((parsed as any)?.attachment).toEqual({
      type: 'goal_status',
      met: false,
      condition: 'ship it',
      sentinel: true,
    });
  });

  it('parses an attachment with an unknown subtype (forward-compatible)', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'attachment',
      attachment: { type: 'agent_listing_delta', agents: [] },
    });
    expect(parsed?.type).toBe('attachment');
    expect((parsed as any)?.attachment?.type).toBe('agent_listing_delta');
  });

  it('does not drop assistant messages when usage schema changes (invalid usage is ignored)', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'assistant',
      uuid: 'u3',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          // Missing required token counts for our structured usage parser.
          output_tokens: 5,
          service_tier: null,
          something_new: true,
        },
      },
    });

    expect(parsed?.type).toBe('assistant');
    expect((parsed as any)?.uuid).toBe('u3');
    expect((parsed as any)?.message?.usage).toBeUndefined();
  });
});
