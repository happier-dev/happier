import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';
import { getActionSpec } from './actionSpecs.js';

describe('Machine isolation Action front door', () => {
  it('admits read without approval and requires approval and Manage for policy writes', async () => {
    const get = ActionIdSchema.parse('machines.isolation.get');
    const set = ActionIdSchema.parse('machines.isolation.set');
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    expect(isApprovalRequiredByActionsSettings(get, settings, { surface: 'agent' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings(set, settings, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(set, settings, { surface: 'ui' })).toBe(false);
    expect(getActionSpec(get).executionPlacement).toBe('account');
    expect(resolveMachineRpcRoutePolicy(getActionSpec(set).bindings.rpcMethod!)).toMatchObject({ sharedMachineAccess: 'manage' });
    const calls: unknown[] = [];
    // The boundary is the host transport. Real Action admission remains enabled.
    const executor = createActionExecutor({ machineIsolationAction: async request => { calls.push(request.input); return { status: 'unavailable' }; } } as unknown as ActionExecutorDeps);
    expect(await executor.execute(get, { machineId: 'm' }, { surface: 'cli', serverId: 'home' })).toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(await executor.execute(get, { machineId: 'm', serverId: 'other' }, { surface: 'cli', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(calls).toEqual([{ machineId: 'm' }]);
  });
});
