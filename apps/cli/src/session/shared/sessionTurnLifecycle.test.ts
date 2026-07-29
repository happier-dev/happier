import { describe, expect, it } from 'vitest';

import {
  applySessionTurnLifecycleEvent,
  detectSessionTurnLifecycleEvent,
  isSessionTurnCompletionProof,
} from './sessionTurnLifecycle';

function rawLifecycle(type: string) {
  return {
    role: 'agent',
    content: {
      type: 'acp',
      data: { type, id: 'turn-1' },
    },
  };
}

function rawEventLifecycle(type: string) {
  return {
    role: 'event',
    content: {
      type: 'event',
      data: { type, id: 'turn-1' },
    },
  };
}

function rawClaudeOutput(params: Readonly<{
  content: readonly unknown[];
  stopReason?: string;
}>) {
  return {
    role: 'agent',
    content: {
      type: 'output',
      data: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: params.content,
          ...(params.stopReason ? { stop_reason: params.stopReason } : {}),
        },
      },
    },
  };
}

describe('sessionTurnLifecycle', () => {
  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'detects terminal lifecycle marker %s',
    (type) => {
      expect(detectSessionTurnLifecycleEvent(rawLifecycle(type))).toBe(type);
    },
  );

  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'detects terminal event-role lifecycle marker %s',
    (type) => {
      expect(detectSessionTurnLifecycleEvent(rawEventLifecycle(type))).toBe(type);
      expect(isSessionTurnCompletionProof(rawEventLifecycle(type))).toBe(false);
    },
  );

  it('does not treat event-role ready as completion proof', () => {
    expect(detectSessionTurnLifecycleEvent(rawEventLifecycle('ready'))).toBe('ready');
    expect(isSessionTurnCompletionProof(rawEventLifecycle('ready'))).toBe(false);
  });

  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'does not treat terminal marker %s as completion proof',
    (type) => {
      expect(isSessionTurnCompletionProof(rawLifecycle(type))).toBe(false);
    },
  );

  it('does not treat task_started as completion proof', () => {
    expect(isSessionTurnCompletionProof(rawLifecycle('task_started'))).toBe(false);
  });

  it('treats task_complete as completion proof', () => {
    expect(isSessionTurnCompletionProof(rawLifecycle('task_complete'))).toBe(true);
  });

  it('detects terminal Claude output rows with assistant text as ready activity', () => {
    const output = rawClaudeOutput({
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
    });

    expect(detectSessionTurnLifecycleEvent(output)).toBe('ready');
    expect(isSessionTurnCompletionProof(output)).toBe(true);
  });

  it('does not treat in-progress Claude output text as completion proof', () => {
    const output = rawClaudeOutput({
      content: [
        { type: 'text', text: 'I will check that.' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      ],
      stopReason: 'tool_use',
    });

    expect(detectSessionTurnLifecycleEvent(output)).toBeNull();
    expect(isSessionTurnCompletionProof(output)).toBe(false);
  });

  it('does not treat Claude output rows with only tool use as ready activity', () => {
    const output = rawClaudeOutput({
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Search', input: {} }],
      stopReason: 'tool_use',
    });

    expect(detectSessionTurnLifecycleEvent(output)).toBeNull();
    expect(isSessionTurnCompletionProof(output)).toBe(false);
  });

  it.each(['turn_failed', 'turn_cancelled'] as const)(
    'treats canonical terminal marker %s as ending the active turn',
    (event) => {
      expect(applySessionTurnLifecycleEvent({
        pendingUserTurns: 0,
        activeTaskInFlight: true,
        event,
      })).toEqual({
        pendingUserTurns: 0,
        activeTaskInFlight: false,
      });
    },
  );
});
