import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';

describe('machine guard Action front door', () => {
  it('admits the four consumed guard Actions with safe defaults and exact-Home transport', async () => {
    ActionIdSchema.parse('machines.guard.get');
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    for (const id of ['machines.guard.get', 'machines.guard.activity.list', 'machines.guard.activity.undo', 'machines.guard.idleStop.keepRunning']) {
      const actionId = ActionIdSchema.parse(id);
      expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'agent' })).toBe(false);
      const spec = getActionSpec(actionId);
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, mcp: true, agent: true, rpc: true });
      expect(resolveMachineRpcRoutePolicy(spec.bindings!.rpcMethod!)).toMatchObject({ sharedMachineAccess: id === 'machines.guard.activity.undo' ? 'manage' : 'use' });
    }
    const calls: unknown[] = [];
    // The Machine RPC transport is a system boundary; the Action dispatcher and admission remain real.
    const executor = createActionExecutor({ machineGuardAction: async request => {
      calls.push(request.input);
      return { status: 'not_pending' };
    } } as unknown as ActionExecutorDeps);
    const actionId = ActionIdSchema.parse('machines.guard.idleStop.keepRunning');
    expect(await executor.execute(actionId, { machineId: 'machine', sessionId: 'session' }, { serverId: 'home', surface: 'cli' }))
      .toEqual({ ok: true, result: { status: 'not_pending' } });
    expect(await executor.execute(actionId, { serverId: 'other', machineId: 'machine', sessionId: 'session' }, { serverId: 'home', surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await executor.execute(actionId, { machineId: 'machine', sessionId: 'session', terminalKey: 'terminal' }, { serverId: 'home', surface: 'cli' }))
      .toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
  });
  it('exposes the session ceiling override with Agent Ask defaults and strict uncapped bytes', async () => {
    const actionId = ActionIdSchema.parse('machines.guard.sessionCeiling.set');
    const spec = getActionSpec(actionId);
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'cli' })).toBe(false);
    expect(resolveMachineRpcRoutePolicy(spec.bindings!.rpcMethod!)).toMatchObject({ sharedMachineAccess: 'manage' });
    expect(spec.inputSchema.parse({ machineId: 'machine', sessionId: 'session', bytes: Number.MAX_SAFE_INTEGER })).toMatchObject({ bytes: Number.MAX_SAFE_INTEGER });
    expect(spec.inputSchema.parse({ machineId: 'machine', sessionId: 'session', bytes: null })).toMatchObject({ bytes: null });
    for (const bytes of [0, -1, 1.5, Infinity]) expect(spec.inputSchema.safeParse({ machineId: 'machine', sessionId: 'session', bytes }).success).toBe(false);
    // Exact Machine RPC is the genuine transport boundary; policy and schemas remain real.
    const executor = createActionExecutor({ machineGuardAction: async () => ({ status: 'applied', appliesAt: 'next_start' }) } as unknown as ActionExecutorDeps);
    expect(await executor.execute(actionId, { machineId: 'machine', sessionId: 'session', bytes: 1024 }, { serverId: 'home', surface: 'cli' }))
      .toEqual({ ok: true, result: { status: 'applied', appliesAt: 'next_start' } });
  });
});
