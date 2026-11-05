import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol';
import { sameMachineServiceLogsResourceInput } from './machineServiceLogsResource';

describe('deployment current edge Resource continuation', () => {
  it('accepts only the admitted controller input for its exact Resource', () => {
    const input = { serverId: 'home', machineId: 'controller', environmentId: 'environment', targetLinkId: 'runtime' };
    const resourceContinuation = {
      method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
      params: { machineId: input.machineId, resource: { hostRead: 'deployments.health.edge', input } },
    } as const;
    const operands = { resourceContinuation };
    expect(sameMachineServiceLogsResourceInput(input, operands, 'controller', 'deployments.health.current')).toBe(true);
    expect(sameMachineServiceLogsResourceInput({ ...input, environmentId: 'other' }, operands,
      'controller', 'deployments.health.current')).toBe(false);
    expect(sameMachineServiceLogsResourceInput(input, operands, 'other', 'deployments.health.current')).toBe(false);
  });
});
