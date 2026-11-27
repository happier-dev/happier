import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
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


describe('selected capture Resource continuation', () => {
  it('binds a selected insight source watch to the signed read and exact Machine', () => {
    const input = { action: { pluginId: 'happier.database', localId: 'insights/sources/read' },
      input: { target: { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'dev' } } } };
    const operands = { resourceContinuation: {
      method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
      params: { machineId: 'collector', subscriptionId: 'source',
        resource: { hostRead: 'database.insightSource', input, resource: { pluginId: 'acme.source', localId: 'changes' } } },
    } } as const;
    expect(sameMachineServiceLogsResourceInput(input, operands, 'collector', ACTION_INVOKE_ACTION_ID_V1)).toBe(true);
    expect(sameMachineServiceLogsResourceInput(input, operands, 'other', ACTION_INVOKE_ACTION_ID_V1)).toBe(false);
    expect(sameMachineServiceLogsResourceInput({ ...input, input: { target: { kind: 'other' } } }, operands,
      'collector', ACTION_INVOKE_ACTION_ID_V1)).toBe(false);
    const mutation = { ...input, action: { ...input.action, localId: 'execute' } };
    expect(sameMachineServiceLogsResourceInput(mutation, { resourceContinuation: { ...operands.resourceContinuation,
      params: { ...operands.resourceContinuation.params, resource: { ...operands.resourceContinuation.params.resource, input: mutation } } } },
    'collector', ACTION_INVOKE_ACTION_ID_V1)).toBe(false);
  });
  it('binds the finite capture list input and Machine and refuses the Clear Action', () => {
    const source = { kind: 'environment', serverId: 'home', environmentId: 'dev' };
    const input = { action: parseQualifiedPluginActionId(DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1)!,
      input: { source, page: { limit: 20 } } };
    const continuation = (value: typeof input, machineId = 'collector') => ({ resourceContinuation: {
      method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
      params: { machineId, resource: { hostRead: 'telemetry.capture', input: value, windowMs: 60_000 } },
    } }) as const;
    const validate = (value: typeof input, operands = continuation(input), machineId = 'collector') =>
      sameMachineServiceLogsResourceInput(value, operands, machineId, ACTION_INVOKE_ACTION_ID_V1);
    expect(validate(input)).toBe(true);
    expect(validate(input, continuation(input, 'other'))).toBe(false);
    expect(validate({ ...input, input: { ...input.input, source: { ...source, environmentId: 'prod' } } })).toBe(false);
    const clear = { ...input, action: parseQualifiedPluginActionId(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1)! };
    expect(validate(clear, continuation(clear))).toBe(false);
  });
});
