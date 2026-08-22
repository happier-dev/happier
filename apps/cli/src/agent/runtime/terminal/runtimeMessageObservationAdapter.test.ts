import { describe, expect, it } from 'vitest';

import { mapRuntimeMessageToTerminalLifecycleObservation } from './runtimeMessageObservationAdapter';

describe('mapRuntimeMessageToTerminalLifecycleObservation', () => {
  it('maps canonical turn-start events to a normalized prompt-submitted observation', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: {
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        kind: 'turn-start',
        turnId: 'turn-1',
        startedBy: 'host',
      },
    })).toEqual({
      type: 'prompt_submitted',
      agentId: 'codex',
      turnId: 'turn-1',
      source: 'lifecycle_event',
    });
  });

  it('maps canonical turn-complete events to a normalized completed observation', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'claude',
      message: {
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 2,
        kind: 'turn-complete',
        turnId: 'turn-2',
      },
    })).toEqual({
      type: 'turn_completed',
      agentId: 'claude',
      turnId: 'turn-2',
      source: 'lifecycle_event',
    });
  });

  it('maps canonical user cancellations to user interrupts', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: {
        sequence: 3,
        sessionId: 'session-1',
        emittedAtMs: 3,
        kind: 'turn-cancelled',
        turnId: 'turn-3',
        cause: 'user',
        diagnostic: {
          code: 'user_interrupted',
          severity: 'warning',
          message: 'Interrupted by user',
        },
      },
    })).toEqual({
      type: 'turn_aborted',
      agentId: 'codex',
      turnId: 'turn-3',
      reason: 'user_interrupt',
      detail: 'Interrupted by user',
      source: 'lifecycle_event',
    });
  });

  it('ignores non-lifecycle canonical runtime messages', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: {
        sequence: 4,
        sessionId: 'session-1',
        emittedAtMs: 4,
        kind: 'message-delta',
        turnId: 'turn-4',
        channel: 'assistant',
        text: 'hello',
      },
    })).toBeNull();
  });
});
