import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildTrackedSessionHandoffMachineCall } from './trackedSessionHandoffMachineCall';

describe('buildTrackedSessionHandoffMachineCall', () => {
  it('allows the target resume RPC to outlive the transport default without widening other handoff calls', () => {
    expect(buildTrackedSessionHandoffMachineCall({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: { sessionId: 'session-1' },
    })).toEqual({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: { sessionId: 'session-1' },
      timeoutMs: 5 * 60_000,
    });

    expect(buildTrackedSessionHandoffMachineCall({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
      request: { sessionId: 'session-1' },
    })).toEqual({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
      request: { sessionId: 'session-1' },
    });
  });
});
