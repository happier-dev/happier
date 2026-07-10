import { describe, expect, it } from 'vitest';

import { mapAntigravityStepsToRuntimeEvents } from './runtimeEvents.js';

describe('mapAntigravityStepsToRuntimeEvents', () => {
  it('namespaces generated fallback transcript ids by turn id', () => {
    const eventsA = mapAntigravityStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-a',
      emittedAtMs: 1,
      steps: [
        { kind: 'assistant_message', text: 'first' },
      ],
    });
    const eventsB = mapAntigravityStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-b',
      emittedAtMs: 2,
      steps: [
        { kind: 'assistant_message', text: 'second' },
      ],
    });

    expect(eventsA).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      localId: 'turn-a:assistant-1',
    }));
    expect(eventsB).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      localId: 'turn-b:assistant-1',
    }));
  });
});
