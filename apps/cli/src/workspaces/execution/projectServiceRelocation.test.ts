import { afterEach, describe, expect, it } from 'vitest';

import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { associateSupervisedPluginProcessHandleForHost } from '@/plugins/runtime/exec/processSupervisor';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import type { PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createProjectServiceRelocation, type ProjectServiceRelocationPorts } from './projectServiceRelocation';

const declaration = { workspaceRefId: 'old-ref', selection: { kind: 'manifest' as const, name: 'worker' } };
const oldTarget = { kind: 'managed_service' as const, managedServiceId: 'old-native', machineId: 'old', workspaceId: 'old-ref', cwd: '/old', declaration };
const newTarget = { kind: 'managed_service' as const, managedServiceId: 'new-native', machineId: 'new', workspaceId: 'new-ref', cwd: '/new',
  declaration: { ...declaration, workspaceRefId: 'new-ref' } };
const request = { workspace: { serverId: 'home', refId: 'primary' }, serviceName: 'worker', requestId: 'move-1',
  currentTarget: oldTarget, destination: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'new' } } };
const destination = { id: 'new-ref', serverId: 'home', machineId: 'new', rootPath: '/new', createdAtMs: 1 };
const oldWorkspace = { id: 'old-ref', serverId: 'home', machineId: 'old', rootPath: '/old', createdAtMs: 1 };
const cleanExit: PluginProcessResult = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
  stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
const retire: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of retire.splice(0)) await close(); });

async function harness(stopStatus: 'stopped' | 'accepted' | 'unsupported' | 'termination_incomplete' = 'stopped', stopGate?: Promise<void>) {
  const effects: string[] = [];
  let nativeStopStatus = stopStatus;
  // Exec/native callbacks are OS boundaries. The supervisor and relocation logic remain real.
  const process: PluginProcessHandle = { write: async () => {}, closeStdin: async () => {}, wait: async () => cleanExit,
    onOutput: () => ({ dispose: () => {} }), dispose: async () => {} };
  associateSupervisedPluginProcessHandleForHost(process, { pid: 42 });
  const supervisor = createManagedServiceProcessSupervisorHost({}).bind({ occurrenceId: 'occurrence', pluginId: 'fixture.plugin',
    contributionId: 'compose', isOccurrenceCurrent: () => true,
    exec: { spawn: async () => process, run: async () => cleanExit } });
  const handle = await supervisor.supervise({ id: 'old-native', mode: { kind: 'native',
    instance: { adapter: { pluginId: 'fixture.plugin', localId: 'compose' }, nativeResourceId: 'exact-compose' },
    lifecycle: { inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
      stop: async () => { effects.push('stop'); if (stopGate) await stopGate; return { status: nativeStopStatus }; } } },
    launch: { executable: { kind: 'systemTool', id: 'fixture.native' } }, startupTimeoutMs: 30_000,
    watchdog: { intervalMs: 5_000, missedIntervals: 2 } });
  retire.push(async () => { nativeStopStatus = 'stopped'; await handle.dispose(); });
  const currentTarget = { ...oldTarget, managedServiceId: handle.snapshot().instanceId };
  const replacement = await supervisor.supervise({ id: 'new-native', mode: { kind: 'native',
    instance: { adapter: { pluginId: 'fixture.plugin', localId: 'compose' }, nativeResourceId: 'exact-new-compose' },
    lifecycle: { inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
      stop: async () => ({ status: 'stopped' }) } },
    launch: { executable: { kind: 'systemTool', id: 'fixture.native' } }, startupTimeoutMs: 30_000,
    watchdog: { intervalMs: 5_000, missedIntervals: 2 } });
  retire.push(() => replacement.dispose());
  const replacementTarget = { ...newTarget, managedServiceId: replacement.snapshot().instanceId };
  const ports: ProjectServiceRelocationPorts = {
    readService: async () => ({ status: 'resolved', execution: 'portable', currentTarget, workspace: oldWorkspace,
      instanceId: handle.snapshot().instanceId, snapshot: handle.snapshot() }),
    resolveDestination: async () => ({ status: 'resolved', workspace: destination }),
    stopService: async (_target, signal) => await handle.stop({ signal }),
    revalidateDestination: async () => ({ status: 'admitted' }),
    handoffPrepareBetween: async () => { effects.push('prepare'); return { ok: true, traversed: [] }; },
    startService: async () => { effects.push('start'); return { status: 'succeeded', currentTarget: replacementTarget }; },
  };
  return { effects, ports, handle, oldTarget: currentTarget, newTarget: replacementTarget, request: { ...request, currentTarget } };
}

describe('confirmed service relocation', () => {
  it('returns the source-owned operation when stopping starts, joins replay, and retains the exact unknown Auto destination', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { effects, ports, request: exactRequest } = await harness('stopped', gate);
    const request = { ...exactRequest, destination: { kind: 'workers' as const,
      destination: { kind: 'pool' as const, poolId: 'pool-one', selection: 'automatic' as const } } };
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'source-coordinator' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'move-operation',
      resolveAction: actionId => ({ actionId, title: 'Move service', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
      } }),
    });
    ports.startService = async () => { effects.push('start'); return { status: 'denied', reasonCode: 'outcome_uncertain' }; };
    const invoke = { actionId: 'projects.service.relocate', requestId: request.requestId, input: request, scope,
      cancellation: 'supported' as const,
      execute: createProjectServiceRelocation(ports).bind(undefined, request),
    };
    let response: unknown;
    const executing = runner.observe(invoke).then(result => { response = result; return result; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(response).toMatchObject({ ok: true, result: { status: 'accepted', operation: {
        operationId: 'move-operation', scope: { machineId: 'source-coordinator' }, state: 'running', progress: { phase: 'stopping' },
      } } });
      await expect(runner.observe(invoke)).resolves.toEqual(response);
      expect(effects).toEqual(['stop']);
    } finally { release(); await executing; }
    await runner.waitForTerminal(scope, 'move-operation');
    expect(store.get(scope, 'move-operation')).toMatchObject({ state: 'running', observation: { kind: 'outcome_uncertain' } });
    expect(store.get(scope, 'move-operation')).toMatchObject({ domainRef: {
      kind: 'projectService', purpose: 'relocation',
      workspace: { serverId: 'home', machineId: 'new', workspaceId: 'new-ref', rootPath: '/new' },
      declaration: { workspaceRefId: 'new-ref', selection: declaration.selection },
    } });
    expect(store.get(scope, 'move-operation')?.domainRef).not.toHaveProperty('managedServiceId');
    expect(store.get(scope, 'move-operation')?.domainRef).not.toHaveProperty('currentTarget');
    expect(effects).toEqual(['stop', 'prepare', 'start']);
    await expect(runner.observe(invoke)).resolves.toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(effects).toEqual(['stop', 'prepare', 'start']);
  });
  it('retains the observed old native binding in source operation custody after an unknown Stop, without replay or replacement', async () => {
    const { effects, ports, handle, request, oldTarget } = await harness('accepted');
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'source-coordinator' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'unknown-stop-operation',
      resolveAction: actionId => ({ actionId, title: 'Move service', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
      } }),
    });
    const invoke = { actionId: 'projects.service.relocate', requestId: request.requestId, input: request, scope,
      cancellation: 'supported' as const, execute: createProjectServiceRelocation(ports).bind(undefined, request) };
    await runner.observe(invoke);
    await runner.waitForTerminal(scope, 'unknown-stop-operation');
    expect(store.get(scope, 'unknown-stop-operation')).toMatchObject({
      state: 'running', scope: { machineId: 'source-coordinator' }, observation: { kind: 'stop_unconfirmed' },
      domainRef: { kind: 'projectService', purpose: 'relocation',
        workspace: { serverId: 'home', machineId: 'old', workspaceId: 'old-ref', rootPath: '/old' },
        declaration, currentTarget: oldTarget },
    });
    expect(store.get(scope, 'unknown-stop-operation')).not.toHaveProperty('settledAt');
    expect(handle.snapshot().state).not.toBe('stopped');
    await expect(runner.observe(invoke)).resolves.toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(effects).toEqual(['stop']);
  });
  it('refuses an observed native binding outside the actual retained workspace before Stop', async () => {
    const { effects, ports, handle, oldTarget, request } = await harness();
    ports.readService = async () => ({ status: 'resolved', execution: 'portable', currentTarget: oldTarget,
      workspace: { ...oldWorkspace, rootPath: '/old-sibling' },
      instanceId: handle.snapshot().instanceId, snapshot: handle.snapshot() });
    await expect(createProjectServiceRelocation(ports)(request))
      .resolves.toMatchObject({ ok: false, errorCode: 'service_inputs_changed' });
    expect(effects).toEqual([]);
  });
  it.each(['accepted', 'unsupported', 'termination_incomplete'] as const)('never replaces a Compose resource after %s stop without a stopped witness', async status => {
    const { effects, ports, handle, request } = await harness(status);
    expect(handle.snapshot().state).not.toBe('stopped'); // The starter already exited successfully.
    const result = await createProjectServiceRelocation(ports)(request);
    expect(result).toMatchObject({ ok: false, errorCode: status === 'unsupported' ? 'service_control_unsupported' : 'stop_unconfirmed' });
    expect(effects).toEqual(['stop']);
  });
  it('prepares the source ref through the routed controller only after confirmed stop, then starts exactly once', async () => {
    const { effects, ports, request, newTarget } = await harness();
    ports.handoffPrepareBetween = async preparation => {
      expect(preparation).toEqual({ sourceWorkspaceRefId: 'primary', targetWorkspaceRefId: 'new-ref' });
      effects.push('controller-routed-prepare'); return { ok: true, traversed: [] };
    };
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toEqual({ ok: true, result: {
      status: 'moved', currentTarget: newTarget } });
    expect(effects).toEqual(['stop', 'controller-routed-prepare', 'start']);
  });
  it('refuses primary-only, stale instance and unavailable destination before native effects', async () => {
    const { effects, ports, handle, oldTarget, request } = await harness();
    ports.readService = async () => ({ status: 'resolved', execution: 'primary', currentTarget: oldTarget,
      workspace: oldWorkspace, instanceId: handle.snapshot().instanceId, snapshot: handle.snapshot() });
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: false, errorCode: 'primary_only' });
    ports.readService = async () => ({ status: 'resolved', execution: 'portable',
      currentTarget: { ...oldTarget, managedServiceId: 'different-instance' },
      workspace: oldWorkspace, instanceId: handle.snapshot().instanceId, snapshot: handle.snapshot() });
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: false, errorCode: 'service_inputs_changed' });
    ports.readService = async () => ({ status: 'resolved', execution: 'portable',
      currentTarget: { ...oldTarget, cwd: '/different-root', declaration: { ...declaration, selection: { kind: 'manifest', name: 'changed' } } },
      workspace: oldWorkspace, instanceId: handle.snapshot().instanceId, snapshot: handle.snapshot() });
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: false, errorCode: 'service_inputs_changed' });
    ports.readService = async () => ({ status: 'resolved', execution: 'portable', currentTarget: oldTarget,
      workspace: oldWorkspace, instanceId: handle.snapshot().instanceId, snapshot: handle.snapshot() });
    ports.resolveDestination = async () => ({ status: 'refused', reasonCode: 'target_offline' });
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: false, errorCode: 'target_offline' });
    expect(effects).toEqual([]);
  });
  it('makes the same exact destination a no-op', async () => {
    const { effects, ports, request } = await harness();
    ports.resolveDestination = async () => ({ status: 'resolved', workspace: { ...destination, id: 'old-ref', machineId: 'old' } });
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: true, result: { status: 'unchanged' } });
    expect(effects).toEqual([]);
  });
  it('refuses a stale supplied initial occurrence before destination admission or native Stop', async () => {
    const { effects, ports, oldTarget, request } = await harness();
    const replacement = await harness();
    ports.readService = async () => ({ status: 'resolved', execution: 'portable', currentTarget: oldTarget,
      workspace: oldWorkspace, instanceId: replacement.handle.snapshot().instanceId, snapshot: replacement.handle.snapshot() });
    ports.resolveDestination = async () => { effects.push('admit'); return { status: 'resolved', workspace: destination }; };
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: false, errorCode: 'service_inputs_changed' });
    expect(effects).toEqual([]);
  });
  it('refuses a replaced native instance with the same managed name after destination admission', async () => {
    const { effects, ports, handle, oldTarget, request } = await harness();
    const replacement = await harness();
    let replaced = false;
    ports.resolveDestination = async () => { replaced = true; return { status: 'resolved', workspace: destination }; };
    ports.readService = async () => ({ status: 'resolved', execution: 'portable', currentTarget: oldTarget,
      workspace: oldWorkspace, instanceId: replaced ? replacement.handle.snapshot().instanceId : handle.snapshot().instanceId,
      snapshot: replaced ? replacement.handle.snapshot() : handle.snapshot() });
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: false, errorCode: 'service_inputs_changed' });
    expect(effects).toEqual([]);
  });
  it('leaves stopped with retained custody after failed preparation or cancellation before launch', async () => {
    const { effects, ports, handle, request } = await harness();
    const controller = new AbortController();
    ports.handoffPrepareBetween = async () => { effects.push('prepare'); controller.abort(); return { ok: true, traversed: [] }; };
    await expect(createProjectServiceRelocation(ports)(request, { signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(handle.snapshot().state).toBe('stopped');
    expect(effects).toEqual(['stop', 'prepare']);
  });
  it('never starts after a clean preparation refusal, and preserves the stopped native handle', async () => {
    const { effects, ports, handle, request } = await harness();
    ports.handoffPrepareBetween = async () => { effects.push('prepare'); return { ok: false, errorCode: 'sync_conflict', completed: [] }; };
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toMatchObject({ ok: false, errorCode: 'sync_conflict' });
    expect(handle.snapshot().state).toBe('stopped');
    expect(effects).toEqual(['stop', 'prepare']);
  });
  it('keeps cancellation nonterminal without a replacement when native Stop observation becomes unconfirmed', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { effects, ports, handle, request } = await harness('stopped', gate);
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'source-coordinator' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'cancel-move',
      resolveAction: actionId => ({ actionId, title: 'Move service', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
      } }),
    });
    try {
      await expect(runner.observe({ actionId: 'projects.service.relocate', requestId: request.requestId, input: request,
        scope, cancellation: 'supported', execute: createProjectServiceRelocation(ports).bind(undefined, request) }))
        .resolves.toMatchObject({ ok: true, result: { status: 'accepted' } });
      expect(runner.cancel(scope, 'cancel-move')).toEqual({ kind: 'requested' });
      await runner.waitForTerminal(scope, 'cancel-move');
      expect(store.get(scope, 'cancel-move')).toMatchObject({ state: 'running', observation: { kind: 'stop_unconfirmed' } });
      expect(store.get(scope, 'cancel-move')).not.toHaveProperty('settledAt');
      expect(handle.snapshot().state).not.toBe('stopped');
      expect(effects).toEqual(['stop']);
    } finally { release(); }
    expect(effects).toEqual(['stop']);
  });
  it('keeps an unknown new start on its exact target even when cancellation arrives during establishment', async () => {
    const { effects, ports, request } = await harness();
    const controller = new AbortController();
    ports.startService = async (_input, selected) => {
      expect(selected.machineId).toBe('new'); effects.push('start'); controller.abort(); throw new Error('lost acknowledgement');
    };
    await expect(createProjectServiceRelocation(ports)(request, { signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    expect(effects).toEqual(['stop', 'prepare', 'start']);
  });
  it.each([
    { status: 'succeeded' as const },
    { status: 'denied' as const, reasonCode: 'plugin_operation_aborted' },
  ])('retains uncertain exact start custody when the actual starter reports $status without a fresh binding', async outcome => {
    const { effects, ports, request } = await harness();
    // The destination native starter is a Machine IO boundary. Its real public outcome
    // cannot establish no-launch merely from denied after an effect was dispatched.
    ports.startService = async (_input, selected) => {
      expect(selected).toEqual(destination);
      effects.push('start');
      return outcome;
    };
    await expect(createProjectServiceRelocation(ports)(request))
      .resolves.toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    expect(effects).toEqual(['stop', 'prepare', 'start']);
  });
  it.each(['oldTarget', 'workspace', 'selection', 'cwd', 'instance', 'preview'] as const)(
    'does not claim a moved lifetime from a succeeded exact starter reply with mismatched %s', async mismatch => {
      const { effects, ports, request, oldTarget, newTarget } = await harness();
      const currentTarget = mismatch === 'oldTarget' ? oldTarget
        : mismatch === 'workspace' ? { ...newTarget, workspaceId: 'other-ref' }
        : mismatch === 'selection' ? { ...newTarget, declaration: { ...newTarget.declaration,
          selection: { kind: 'manifest' as const, name: 'other-service' } } }
        : mismatch === 'cwd' ? { ...newTarget, cwd: '/new-sibling' }
        : mismatch === 'instance' ? { ...newTarget, managedServiceId: oldTarget.managedServiceId }
        : { ...newTarget, previewUrl: 'http://old-preview.invalid' };
      ports.startService = async (_input, selected) => {
        expect(selected).toEqual(destination);
        effects.push('start');
        return { status: 'succeeded', currentTarget };
      };
      await expect(createProjectServiceRelocation(ports)(request))
        .resolves.toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
      expect(effects).toEqual(['stop', 'prepare', 'start']);
    },
  );
  it('accepts a fresh declared service in a nested Windows cwd with mixed separators', async () => {
    const { effects, ports, request, newTarget } = await harness();
    const selected = { ...destination, rootPath: 'C:\\Work\\Project' };
    const currentTarget = { ...newTarget, cwd: 'c:/Work/Project/packages/api' };
    ports.resolveDestination = async () => ({ status: 'resolved', workspace: selected });
    ports.startService = async (_input, target) => {
      expect(target).toEqual(selected);
      effects.push('start');
      return { status: 'succeeded', currentTarget };
    };
    await expect(createProjectServiceRelocation(ports)(request)).resolves.toEqual({ ok: true,
      result: { status: 'moved', currentTarget } });
    expect(effects).toEqual(['stop', 'prepare', 'start']);
  });
});
