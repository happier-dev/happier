import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { projectMachineRpcTransportAcknowledgement } from './projectMachineRpcTransportAcknowledgement';

describe('projectMachineRpcTransportAcknowledgement', () => {
  it('projects proof only for a strict completed stop result', () => {
    expect(projectMachineRpcTransportAcknowledgement({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      result: { status: 'stopped' },
    })).toEqual({ kind: 'session.stop', status: 'stopped' });

    for (const result of [
      { status: 'requested' },
      { status: 'not_found' },
      { status: 'incomplete', reason: 'runner_exit_timeout' },
    ]) {
      expect(projectMachineRpcTransportAcknowledgement({
        method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
        result,
      })).toBeNull();
    }
  });

  it('does not project proof for another method or a lookalike result', () => {
    expect(projectMachineRpcTransportAcknowledgement({
      method: 'machine-1:other-method',
      result: { status: 'stopped' },
    })).toBeNull();
    expect(projectMachineRpcTransportAcknowledgement({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      result: { status: 'stopped', extra: true },
    })).toBeNull();
  });
});
