import { describe, expect, it } from 'vitest';

import {
  applySessionTurnLifecycleEvent,
  detectSessionTurnLifecycleEvent,
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

describe('sessionTurnLifecycle', () => {
  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'detects terminal lifecycle marker %s',
    (type) => {
      expect(detectSessionTurnLifecycleEvent(rawLifecycle(type))).toBe(type);
    },
  );

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
