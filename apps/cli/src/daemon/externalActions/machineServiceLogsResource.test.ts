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

  it('accepts a compact platform log Resource only on its exact continuation Machine and signed input', () => {
    // RECEIPT-SETTLE-1115: platform receipts resolve their link and executor, so the compact input names no Machine.
    const input = { serverId: 'home', environmentId: 'environment', deploymentId: 'deployment', kind: 'build' as const };
    const continuation = (machineId: string) => ({ resourceContinuation: { method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
      params: { machineId, resource: { hostRead: 'deployments.logs', sourceRevision: 'deployment', input } } } }) as const;
    expect(sameMachineServiceLogsResourceInput(input, continuation('controller'), 'controller', 'deployments.logs.read')).toBe(true);
    expect(sameMachineServiceLogsResourceInput(input, continuation('other'), 'controller', 'deployments.logs.read')).toBe(false);
    expect(sameMachineServiceLogsResourceInput({ ...input, deploymentId: 'other' }, continuation('controller'), 'controller',
      'deployments.logs.read')).toBe(false);
    expect(sameMachineServiceLogsResourceInput({ ...input, machineId: 'other' }, continuation('controller'), 'controller',
      'deployments.logs.read')).toBe(false);
  });
});
