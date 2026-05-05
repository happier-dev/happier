import { describe, expect, it, vi } from 'vitest';

import { publishTerminalPendingHandoffState } from './publishTerminalPendingHandoffState';

describe('publishTerminalPendingHandoffState', () => {
  it('publishes pending handoff state under agentState.terminalControl without dropping localControl', () => {
    let state: any = {
      controlledByUser: true,
      localControl: { attached: true, topology: 'exclusive' },
    };
    const session = {
      updateAgentState: vi.fn((updater: (current: any) => any) => {
        state = updater(state);
      }),
    };

    publishTerminalPendingHandoffState({
      session,
      status: {
        v: 1,
        status: 'deferred_until_terminal_turn_finishes',
        pendingCount: 2,
        updatedAtMs: 123,
      },
    });

    expect(state).toMatchObject({
      controlledByUser: true,
      localControl: { attached: true, topology: 'exclusive' },
      terminalControl: {
        pendingHandoffV1: {
          v: 1,
          status: 'deferred_until_terminal_turn_finishes',
          pendingCount: 2,
          updatedAtMs: 123,
        },
      },
    });
  });
});
