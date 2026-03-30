import { describe, expect, it } from 'vitest';

import { scenarioSatisfiedByMessages } from './messageSatisfaction';

describe('scenarioSatisfiedByMessages', () => {
  it('returns true when no message criteria are provided', () => {
    expect(scenarioSatisfiedByMessages({ decodedMessages: [] }, {})).toBe(true);
  });

  it('matches a substring nested in a decoded message payload', () => {
    const decoded = [
      { role: 'assistant', content: { type: 'text', text: 'hello ACP_STUB_RUNNING primary=abc' } },
    ];
    expect(
      scenarioSatisfiedByMessages(
        { decodedMessages: decoded },
        { requiredMessageSubstrings: ['ACP_STUB_RUNNING primary=abc'] },
      ),
    ).toBe(true);
  });

  it('matches a substring split across streamed message chunks', () => {
    const decoded = [
      {
        role: 'agent',
        meta: { happierStreamKey: 'stream:1' },
        content: { type: 'acp', data: { type: 'message', message: 'HELLO_' } },
      },
      {
        role: 'agent',
        meta: { happierStreamKey: 'stream:1' },
        content: { type: 'acp', data: { type: 'message', message: 'WORLD' } },
      },
    ];
    expect(
      scenarioSatisfiedByMessages(
        { decodedMessages: decoded },
        { requiredMessageSubstrings: ['HELLO_WORLD'] },
      ),
    ).toBe(true);
  });

  it('does not match a substring that only appears in user messages', () => {
    const decoded = [
      { role: 'user', content: { type: 'text', text: 'user says ACP_STUB_RUNNING primary=user' } },
    ];
    expect(
      scenarioSatisfiedByMessages(
        { decodedMessages: decoded },
        { requiredMessageSubstrings: ['ACP_STUB_RUNNING primary=user'] },
      ),
    ).toBe(false);
  });

  it('returns false when the substring is not present', () => {
    const decoded = [{ role: 'assistant', content: { type: 'text', text: 'nope' } }];
    expect(
      scenarioSatisfiedByMessages({ decodedMessages: decoded }, { requiredMessageSubstrings: ['ACP_STUB_DONE'] }),
    ).toBe(false);
  });

  it('matches a substring found in a socket update payload', () => {
    const socketEvents: any[] = [
      { at: Date.now(), kind: 'update', payload: { body: { t: 'new-message', message: 'ACP_STUB_RUNNING primary=socket' } } },
    ];
    expect(
      scenarioSatisfiedByMessages(
        { decodedMessages: [], socketEvents: socketEvents as any },
        { requiredMessageSubstrings: ['ACP_STUB_RUNNING primary=socket'] },
      ),
    ).toBe(true);
  });

  it('matches a substring nested inside a serialized transcript wrapper value', () => {
    const decoded = [
      {
        __happierSerializedJsonValueV1: true,
        type: 'json',
        value: {
          role: 'agent',
          content: {
            type: 'acp',
            data: {
              type: 'message',
              message: 'Model not found: openai/does_not_exist.',
            },
          },
        },
      },
    ];

    expect(
      scenarioSatisfiedByMessages(
        { decodedMessages: decoded },
        { requiredMessageSubstrings: ['Model not found'] },
      ),
    ).toBe(true);
  });
});
