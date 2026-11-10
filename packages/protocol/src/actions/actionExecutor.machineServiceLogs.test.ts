import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference, type ActionApprovalScopeV1 } from './actionSettings.js';

describe('Machine service log Action', () => {
  it('runs a finite exact-service command through Action policy and preserves its result', async () => {
    const requests: unknown[] = [];
    const scope = { kind: 'environment' as const, environmentId: 'environment' };
    // The target daemon is the boundary; shared admission and output parsing stay real.
    const executor = createActionExecutor({
      machineServiceScope: async () => scope,
      machineServiceExec: async request => {
        requests.push(request.input);
        return { exitCode: 7, stdout: 'literal output', stderr: 'command diagnostic' };
      },
    });
    const actionId = 'machines.services.exec';
    const input = { serverId: 'home', machineId: 'machine',
      target: { kind: 'current', serviceId: 'environment/db', expectedGeneration: 'generation-1' },
      mode: 'exec', argv: ['printf', '%s', 'literal; $(not-a-host-shell)'] };
    const settings = setScopedActionApprovalPreference({ actionId, scope, surface: 'cli', mode: 'waived',
      settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    const context = { surface: 'cli' as const, serverId: 'home', actionsSettings: settings };
    expect(await executor.execute(actionId, input, context))
      .toMatchObject({ ok: true, result: { exitCode: 7, stdout: 'literal output', stderr: 'command diagnostic' } });
    expect(requests).toEqual([input]);
    expect(await executor.execute(actionId, { ...input, serverId: 'other' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toHaveLength(1);
  });

  it('publishes one exact-installation reboot Action with ordinary Ask and closed input/output', async () => {
    const actionId = ActionIdSchema.safeParse('machines.reboot');
    expect(actionId.success).toBe(true);
    if (!actionId.success) throw new Error('The canonical Action catalog must declare reboot');
    const spec = getActionSpec(actionId.data);
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.bindings?.rpcMethod).toBe('machines.reboot');
    expect(spec.operation?.version).toBe(1);
    const input = { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' };
    let effects = 0;
    const deps = Object.assign({ machineServiceLogsRead: async () => null }, {
      // The receiving daemon is a system boundary; catalog parsing and policy
      // are real. No native power action can run from this test.
      machineReboot: async (_request: { input: unknown }) => {
        effects++; return { kind: 'accepted', operation: { operationId: 'reboot-operation' }, bootedAt: 1000 };
      },
    });
    const executor = createActionExecutor(deps);
    const person = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
      presentUserConfirmation: { actionId: actionId.data } };
    expect(await executor.execute(actionId.data, input, person))
      .toMatchObject({ ok: true, result: { kind: 'accepted', bootedAt: 1000 } });
    expect(effects).toBe(1);
    expect(await executor.execute(actionId.data, { ...input, requestId: 'second-identity' }, person)).toMatchObject({ ok: false });
    expect(await executor.execute(actionId.data, { ...input, serverId: 'other-home' }, person))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(effects).toBe(1);
  });
  it('dispatches direct person control under actual owner scope while agent Ask and changed scope remain enforced', async () => {
    const actionId = 'machines.services.control';
    const input = { serverId: 'home', machineId: 'machine', serviceId: 'instance/db', expectedGeneration: 'native-1', operation: 'restart' };
    let scope: ActionApprovalScopeV1 = { kind: 'environment', environmentId: 'production' };
    const requests: unknown[] = [];
    // The target-daemon transport is the boundary; Action admission and policy stay real.
    const executor = createActionExecutor({ machineServiceScope: async () => scope,
      machineServiceControl: async request => { requests.push(request); return { kind: 'observed', serviceId: input.serviceId,
        generation: input.expectedGeneration, state: 'running', operation: { operationId: 'control-operation' } }; } });
    let confirmations = 0;
    const person = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
      presentUserConfirmation: async () => { confirmations++; return true; } };
    expect(await executor.execute(actionId, input, person)).toMatchObject({ ok: true, result: { kind: 'observed' } });
    expect(confirmations).toBe(0);
    expect(requests).toHaveLength(1);
    const agent = { surface: 'agent' as const, serverId: 'home' };
    expect(await executor.prepare(actionId, input, agent)).toMatchObject({ kind: 'settled', result: { ok: false } });
    expect(requests).toHaveLength(1);
    let settings = setScopedActionApprovalPreference({ actionId, scope: { kind: 'machine', machineId: 'machine' },
      surface: 'agent', mode: 'waived', settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    expect(await executor.prepare(actionId, input, { ...agent, actionsSettings: settings }))
      .toMatchObject({ kind: 'settled', result: { ok: false } });
    scope = { kind: 'environment', environmentId: 'staging' };
    settings = setScopedActionApprovalPreference({ actionId, scope, surface: 'agent', mode: 'waived', settings });
    const prepared = await executor.prepare(actionId, input, { ...agent, actionsSettings: settings });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Exact Staging waiver must admit the control');
    scope = { kind: 'environment', environmentId: 'production' };
    expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(requests).toHaveLength(1);
    expect(await executor.execute(actionId, { ...input, scope }, person)).toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
  });
  it('preserves exact native accounting from an explicit service Detail without converting unknown values to zero', async () => {
    const service = { serviceId: 'watched-service', name: 'Worker', authority: 'machine' as const,
      lifecyclePurpose: 'infrastructure' as const, generation: 'actual-native-generation', state: 'running' as const,
      watchId: 'watch', watchRevision: 'watch-revision',
      capabilities: { start: false, stop: true, restart: false, logs: false, accounting: true } };
    const result = { kind: 'service' as const, service, accounting: { kind: 'sample' as const,
      samples: [{ nativeResourceId: 'user/worker.service', cpuPercent: null, memoryBytes: 128,
        networkReceivedBytes: 0, networkSentBytes: null, restartCount: 3 }] } };
    // The target daemon is the system boundary; shared Detail output parsing stays real.
    const executor = createActionExecutor({ machineServiceAction: async () => result });
    expect(await executor.execute('machines.services.detail', { serverId: 'home', machineId: 'machine', serviceId: service.serviceId },
      { surface: 'agent', serverId: 'home' })).toEqual({ ok: true, result });
  });

  it('allows safe watch intent by default and honors the exact Machine approval preference', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor(Object.assign({}, {
      // The daemon transport is the boundary; spec parsing and approval stay real.
      machineServiceAction: async (request: { input: unknown }) => {
        requests.push(request.input);
        return { kind: 'applied', revision: 'watch-revision-1' };
      },
    }));
    const actionId = 'machines.services.watch' as never;
    const input = { serverId: 'home', machineId: 'machine', candidateId: 'candidate', expectedRevision: 'native-1', lifecyclePurpose: 'deployment' };
    const context = { surface: 'agent' as const, serverId: 'home' };
    expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: true, result: { kind: 'applied' } });
    const settings = setScopedActionApprovalPreference({ actionId, scope: { kind: 'machine', machineId: 'machine' },
      surface: 'agent', mode: 'required', settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    expect(await executor.prepare(actionId, input, { ...context, actionsSettings: settings }))
      .toMatchObject({ kind: 'settled', result: { ok: false } });
    expect(requests).toHaveLength(1);
    expect(await executor.execute(actionId, { ...input, serverId: 'other' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await executor.execute(actionId, { ...input, scope: { kind: 'environment', environmentId: 'forged' } }, context))
      .toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
  });

  it('reads the shared inventory, discovery and detail through one typed family and rejects malformed output', async () => {
    const inputs: unknown[] = [];
    let malformed = false;
    const executor = createActionExecutor(Object.assign({}, {
      machineServiceAction: async (request: { actionId: string; input: unknown }) => {
        inputs.push(request.input);
        if (malformed) return { kind: 'snapshot', services: [], inventedAuthority: 'trusted' };
        return request.actionId === 'machines.services.list' ? { kind: 'snapshot', services: [] }
          : request.actionId === 'machines.services.discovery' ? { kind: 'snapshot', candidates: [], failures: [] }
            : { kind: 'unavailable', reason: 'denied' };
      },
    }));
    const context = { surface: 'agent' as const, serverId: 'home' };
    const machine = { serverId: 'home', machineId: 'machine' };
    expect(await executor.execute('machines.services.list' as never, machine, context)).toMatchObject({ ok: true, result: { kind: 'snapshot', services: [] } });
    expect(await executor.execute('machines.services.discovery' as never, machine, context)).toMatchObject({ ok: true, result: { kind: 'snapshot', candidates: [], failures: [] } });
    expect(await executor.execute('machines.services.detail' as never, { ...machine, serviceId: 'service', expectedGeneration: 'native-1' }, context))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'denied' } });
    expect(inputs).toHaveLength(3);
    malformed = true;
    expect(await executor.execute('machines.services.list' as never, machine, context)).toMatchObject({ ok: false });
  });

  it('reads one exact admitted service and refuses a different Home before transport', async () => {
    const requests: unknown[] = [];
    // Only the target-daemon transport is substituted; Action admission stays real.
    const executor = createActionExecutor({ machineServiceLogsRead: async (request: { input: unknown }) => {
      requests.push(request.input);
      return { kind: 'page', page: { sourceRevision: 'container-a', text: 'db output', nextCursor: null, truncated: false } };
    } });
    const actionId = 'machines.services.logs.read';
    const input = { serverId: 'home', machineId: 'machine', serviceId: 'environment/db' };
    expect(await executor.execute(actionId, input, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { kind: 'page', page: { text: 'db output' } } });
    expect(requests).toEqual([input]);
    expect(await executor.execute(actionId, { ...input, serverId: 'other' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toHaveLength(1);
  });
  it('uses the host-proved Environment scope and invalidates prepared admission when that scope changes', async () => {
    const actionId = 'machines.services.logs.read';
    const input = { serverId: 'home', machineId: 'machine', serviceId: 'instance/db' };
    let scope: ActionApprovalScopeV1 = { kind: 'environment', environmentId: 'environment' };
    let reads = 0;
    // These two ports are the target-host boundary; shared policy and preparation are real.
    const executor = createActionExecutor({
      machineServiceScope: async () => scope,
      machineServiceLogsRead: async () => { reads++; return { kind: 'unavailable', reason: 'unsupported' }; },
    });
    const settings = setScopedActionApprovalPreference({ actionId, scope, surface: 'cli', mode: 'waived',
      settings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }) });
    const prepared = await executor.prepare(actionId, input, { surface: 'cli', serverId: 'home', actionsSettings: settings });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Scoped waiver must admit this read');
    scope = { kind: 'environment', environmentId: 'another-environment' };
    expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(reads).toBe(0);
  });
});
