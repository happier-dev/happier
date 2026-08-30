import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildTrackedSessionHandoffMachineCall } from './trackedSessionHandoffMachineCall';

describe('buildTrackedSessionHandoffMachineCall', () => {
  it('allows target resume to outlive the transport default without widening other handoff calls', () => {
    expect(buildTrackedSessionHandoffMachineCall({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
      request: { handoffId: 'handoff-1' },
    })).toEqual({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
      request: { handoffId: 'handoff-1' },
      timeoutMs: 5 * 60_000,
    });

    expect(buildTrackedSessionHandoffMachineCall({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
      request: { handoffId: 'handoff-1' },
    })).toEqual({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
      request: { handoffId: 'handoff-1' },
    });
  });
});
