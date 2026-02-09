import { describe, expect, it } from 'vitest';

import { makeTraceEvent } from './testEvents.testkit';

describe('makeTraceEvent', () => {
  it('applies defaults when direction/sessionId are explicitly undefined', () => {
    const event = makeTraceEvent({
      ts: 1,
      protocol: 'acp',
      provider: 'opencode',
      kind: 'tool-call',
      payload: { type: 'tool-call', callId: 'c1', name: 'read', input: { file_path: '/tmp/x' } },
      direction: undefined,
      sessionId: undefined,
    });

    expect(event.direction).toBe('outbound');
    expect(event.sessionId).toBe('s1');
  });
});
