import { describe, expect, it } from 'vitest';

import { mapClaudeJsonlLineToDirectMessages } from './mapClaudeJsonlLineToDirectMessages';

describe('mapClaudeJsonlLineToDirectMessages', () => {
  it.each([
    ['cli', 'Keep this prompt visible'],
    ['sdk-ts', [{ type: 'text', text: 'Keep this prompt visible' }]],
  ])('projects a human prompt from %s as a user row', (entrypoint, content) => {
    const [item] = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: 'project/session.jsonl',
      lineStartOffsetBytes: 10,
      lineValue: { type: 'user', uuid: 'human-prompt', entrypoint, message: { role: 'user', content } },
    });

    expect(item).toMatchObject({
      messageRole: 'user',
      raw: { role: 'user', content: { type: 'text', text: 'Keep this prompt visible' } },
    });
  });

  it('preserves every text block in one human prompt', () => {
    const [item] = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: 'project/session.jsonl', lineStartOffsetBytes: 10,
      lineValue: { type: 'user', uuid: 'multi-block', message: { content: [
        { type: 'text', text: 'First paragraph' }, { type: 'text', text: 'Second paragraph' },
      ] } },
    });
    expect(item?.raw).toEqual({ role: 'user', content: { type: 'text', text: 'First paragraph\nSecond paragraph' } });
  });

  it.each([
    { isMeta: true, message: { content: [{ type: 'text', text: 'Internal prompt' }] } },
    { isSidechain: true, message: { content: [{ type: 'text', text: 'Subagent prompt' }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Result' }, { type: 'text', text: 'Context' }] } },
    { message: { content: [{ type: 'image', source: { type: 'base64', data: 'image' } }, { type: 'text', text: 'Caption' }] } },
  ])('retains structured output for non-human or non-text-only records: %j', (record) => {
    const [item] = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: 'project/session.jsonl', lineStartOffsetBytes: 10,
      lineValue: { type: 'user', uuid: 'structured-user', ...record },
    });
    expect(item?.raw).toMatchObject({ role: 'agent', content: { type: 'output', data: record } });
  });

  it('projects native queued task completion through the same parser as synced history', () => {
    const [item] = mapClaudeJsonlLineToDirectMessages({ fileRelPath: 'project/session.jsonl', lineStartOffsetBytes: 10,
      lineValue: { type: 'attachment', uuid: 'direct-task', attachment: { type: 'queued_command', commandMode: 'task-notification',
        prompt: '<task-notification><task-id>task</task-id><tool-use-id>tool</tool-use-id><status>completed</status><result>findings</result></task-notification>' } } });
    expect(item?.raw).toMatchObject({ role: 'agent', content: { type: 'output', data: { type: 'user',
      origin: { kind: 'task-notification', toolUseId: 'tool' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] } } } });
  });

  it('includes delivered cross-session messages as peer output rather than human input', () => {
    const [item] = mapClaudeJsonlLineToDirectMessages({ fileRelPath: 'project/session.jsonl', lineStartOffsetBytes: 10,
      lineValue: { type: 'attachment', uuid: 'direct-peer', attachment: { type: 'queued_command',
        prompt: '<cross-session-message from="uds:/tmp/peer.sock" from-name="Sender" from-mode="prompting">Delivered</cross-session-message>' } } });
    expect(item?.raw).toMatchObject({ role: 'agent', content: { type: 'output', data: { type: 'user',
      origin: { kind: 'peer', name: 'Sender' }, message: { content: 'From Sender:\n\nDelivered' } } } });
  });

  it.each([
    ['message-less assistant', { type: 'assistant', uuid: 'assistant-api-error', isApiErrorMessage: true }, 'event'],
    [
      'assistant text with missing nested role',
      { type: 'assistant', uuid: 'assistant-missing-role', message: { content: [{ type: 'text', text: 'hello' }] } },
      'agent',
    ],
  ] as const)('carries canonical role metadata for %s', (_name, lineValue, expectedRole) => {
    const [item] = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: 'project/session.jsonl',
      lineStartOffsetBytes: 10,
      lineValue,
    });

    expect(item?.messageRole).toBe(expectedRole);
  });

  it('carries canonical role metadata on the schema-mismatch fallback', () => {
    // A known row type whose body cannot be parsed at all still reaches managed storage as an opaque
    // record; without the role it is the one direct-session path that stays unclassified.
    const [item] = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: 'project/session.jsonl',
      lineStartOffsetBytes: 10,
      lineValue: { type: 'assistant', uuid: 42, isApiErrorMessage: true },
    });

    expect((item?.raw as any)?.content?.data?.reason).toBe('schema_mismatch');
    expect(item?.messageRole).toBe('event');
  });
});
