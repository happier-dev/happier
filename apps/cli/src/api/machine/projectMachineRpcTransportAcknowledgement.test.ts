import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { projectMachineRpcTransportAcknowledgement } from './projectMachineRpcTransportAcknowledgement';

describe('projectMachineRpcTransportAcknowledgement', () => {
  it('publishes only a proven explicit session-stop terminal result', () => {
    expect(projectMachineRpcTransportAcknowledgement({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      result: { status: 'stopped' },
    })).toEqual({
      kind: 'session.stop',
      status: 'stopped',
    });

    expect(projectMachineRpcTransportAcknowledgement({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      result: { status: 'requested' },
    })).toBeNull();
    expect(projectMachineRpcTransportAcknowledgement({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      result: { status: 'incomplete', reason: 'runner_exit_timeout' },
    })).toBeNull();
    expect(projectMachineRpcTransportAcknowledgement({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      result: { status: 'stopped' },
    })).toBeNull();
  });
});
