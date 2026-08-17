import { describe, expect, it } from 'vitest';

import { mapAntigravityStepsToRuntimeEvents } from './runtimeEvents.js';

describe('mapAntigravityStepsToRuntimeEvents', () => {
  it('builds canonical runtime event inputs without retaining the generic runtime-event model', () => {
    const eventsA = mapAntigravityStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-a',
      emittedAtMs: 1,
      steps: [
        { kind: 'assistant_message', text: 'first' },
        { kind: 'tool_call', toolName: 'list_dir', input: { path: '.' } },
        { kind: 'error', message: 'provider stopped' },
        { kind: 'checkpoint', checkpointId: 'checkpoint-1' },
        { kind: 'system_message', text: 'compacted' },
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

    expect(eventsA).toEqual([
      {
        kind: 'transcript-message-committed',
        messageId: 'turn-a:assistant-1',
        role: 'assistant',
        text: 'first',
        turnId: 'turn-a',
      },
      {
        kind: 'tool-call',
        turnId: 'turn-a',
        toolCallId: 'turn-a:tool-2',
        toolName: 'list_dir',
        input: { path: '.' },
      },
      {
        kind: 'turn-failed',
        turnId: 'turn-a',
        diagnostic: {
          code: 'antigravity_cliprint_transcript_error',
          severity: 'error',
          message: 'provider stopped',
        },
      },
    ]);
    expect(eventsB).toEqual([
      {
        kind: 'transcript-message-committed',
        messageId: 'turn-b:assistant-1',
        role: 'assistant',
        text: 'second',
        turnId: 'turn-b',
      },
    ]);
  });
});
