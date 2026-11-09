import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema, setActionApprovalOverride, setScopedActionApprovalPreference } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('administrator policy Action front door', () => {
  const setInput = { machineId: 'target', expectedMetadataVersion: 1,
    expectedAdminAccess: { version: 1, mode: 'none' }, adminAccess: { version: 1, mode: 'preauthorized' },
    comparison: 'field' } as const;

  it.each(['cli', 'agent', 'mcp'] as const)('uses the physical Machine preference, not ambient or Environment scope (%s)', async surface => {
    let effects = 0;
    // Target-daemon transport is the only substituted boundary.
    const executor = createActionExecutor({ machineAdminAccessAction: async () => { effects++; return { status: 'unavailable' }; } });
    const actionId = 'machines.setup.adminAccess.set';
    const global = ActionsSettingsV1Schema.parse({ v: 1 });
    const settings = setScopedActionApprovalPreference({ settings: global, actionId,
      scope: { kind: 'machine', machineId: 'target' }, surface, mode: 'waived' });
    const context = { surface, serverId: 'home', defaultMachineId: 'ambient', actionsSettings: settings };
    const prepared = await executor.prepare(actionId, setInput, context);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Exact Machine waiver must admit the omitted-Home request');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    expect(effects).toBe(1);
    const foreignScope = setScopedActionApprovalPreference({ settings: global, actionId,
      scope: { kind: 'environment', environmentId: 'target' }, surface, mode: 'waived' });
    expect((await executor.prepare(actionId, setInput, { ...context, actionsSettings: foreignScope })).kind).toBe('settled');
    const globallyAllowed = setActionApprovalOverride({ settings: global, actionId, surface, approvalRequired: false });
    expect((await executor.prepare(actionId, setInput, { ...context, actionsSettings: globallyAllowed })).kind).toBe('ready');
    const machineAsks = setScopedActionApprovalPreference({ settings: globallyAllowed, actionId,
      scope: { kind: 'machine', machineId: 'target' }, surface, mode: 'required' });
    expect((await executor.prepare(actionId, setInput, { ...context, actionsSettings: machineAsks })).kind).toBe('settled');
    expect(effects).toBe(1);
  });

  it('refuses an explicit foreign Home before approval or effects', async () => {
    let effects = 0;
    const executor = createActionExecutor({ machineAdminAccessAction: async () => { effects++; return { status: 'unavailable' }; } });
    expect(await executor.prepare('machines.setup.adminAccess.set', { ...setInput, serverId: 'other' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      interactivePresentation: 'unavailable', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
    })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'server_target_mismatch' } });
    expect(effects).toBe(0);
  });

  it('requires configurable agent approval for policy changes and routes both operations to the target daemon', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const set = ActionIdSchema.parse('machines.setup.adminAccess.set');
    const inspect = ActionIdSchema.parse('machines.setup.adminAccess.inspect');
    expect(isApprovalRequiredByActionsSettings(set, settings, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(inspect, settings, { surface: 'agent' })).toBe(false);
    for (const surface of ['agent', 'mcp'] as const) {
      const waived = setActionApprovalOverride({ settings, actionId: set, surface, approvalRequired: false });
      expect(isApprovalRequiredByActionsSettings(set, waived, { surface })).toBe(false);
      const required = setActionApprovalOverride({ settings: waived, actionId: set, surface, approvalRequired: true });
      expect(isApprovalRequiredByActionsSettings(set, required, { surface })).toBe(true);
    }
    expect(getActionSpec(set)).toMatchObject({ safety: 'danger', executionPlacement: 'machine' });
    expect(getActionSpec(inspect)).toMatchObject({ safety: 'safe', executionPlacement: 'machine' });
    expect(resolveMachineRpcRoutePolicy(set)).toMatchObject({ sharedMachineAccess: 'custodian_only', actionSpecId: set });
    expect(resolveMachineRpcRoutePolicy(inspect)).toMatchObject({ actionSpecId: inspect });
  });

  it('dispatches to the exact Home transport and preserves typed host refusal', async () => {
    // The host transport is the boundary; internal admission and schema dispatch remain real.
    const executor = createActionExecutor({ machineAdminAccessAction: async () => ({ status: 'unavailable' }) } as unknown as ActionExecutorDeps);
    const inspect = ActionIdSchema.parse('machines.setup.adminAccess.inspect');
    expect(await executor.execute(inspect, { machineId: 'machine' }, { surface: 'cli', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(await executor.execute(inspect, { machineId: 'machine', serverId: 'other' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });
});
