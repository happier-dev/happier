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
});
