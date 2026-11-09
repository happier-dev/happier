import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS } from './specs/machineResources.js';
import { ActionIdSchema } from './actionIds.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';
import { RPC_METHODS } from '../rpc/methods.js';

describe('resources policy Action front door', () => {
  it('carries the admitted resource-policy input to the transport without parsing it again', async () => {
    const actionId = 'machines.resources.policy.get';
    const schema = MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS[actionId];
    expect(getActionSpec(actionId).inputSchema).toBe(schema);
    const received: unknown[] = [];
    // Account-policy transport is the system boundary; admission stays real.
    const executor = createActionExecutor({
      machineResourcesPolicyAction: async request => {
        received.push(request.input);
        return { status: 'unavailable' };
      },
    } as unknown as ActionExecutorDeps);
    const prepared = await executor.prepare(actionId, { machineId: ' machine ' }, { surface: 'cli', serverId: 'home' });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Resource read was not admitted');
    const parse = vi.spyOn(schema, 'parse');
    const safeParse = vi.spyOn(schema, 'safeParse');
    try {
      expect(await prepared.invocation.run()).toEqual({ ok: true, result: { status: 'unavailable' } });
      expect(received).toEqual([{ machineId: 'machine' }]);
      expect(parse).not.toHaveBeenCalled();
      expect(safeParse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      safeParse.mockRestore();
    }
    expect(await executor.execute(actionId, { machineId: '' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(received).toHaveLength(1);
  });

  it('reads account metadata and uses the user-configurable agent approval policy for writes', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('machines.resources.policy.get'), settings, { surface: 'agent' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('machines.resources.policy.set'), settings, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('machines.resources.policy.set'), settings, { surface: 'ui' })).toBe(false);
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET)).toMatchObject({ sharedMachineAccess: 'custodian_only' });
    const calls: unknown[] = [];
    // Boundary fixture supplies only the policy transport; unrelated Action transports are not invoked.
    const executor = createActionExecutor({ machineResourcesPolicyAction: async request => { calls.push(request.input); return { status: 'unavailable' }; } } as unknown as ActionExecutorDeps);
    expect(await executor.execute(ActionIdSchema.parse('machines.resources.policy.get'), { machineId: 'machine' }, { surface: 'cli', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(await executor.execute(ActionIdSchema.parse('machines.resources.policy.get'), { machineId: 'machine', serverId: 'other' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(calls).toHaveLength(1);
  });
});
