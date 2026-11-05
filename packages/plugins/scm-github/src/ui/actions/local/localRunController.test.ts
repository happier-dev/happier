import { describe, expect, it, vi } from 'vitest';
import type { PluginUiActionControlExecution, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { PluginUiActionOperationHostReadResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import type { LocalActInspection } from '../../../actions/local/contracts.js';
import { createLocalRunControllerV1, reconcileLocalActInspectionV1 } from './localRunController.js';

const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' };
function inspection(): LocalActInspection {
  return { workspace, tool: { kind: 'ready', executablePath: '/tools/act', version: 'act 0.2.89' },
    preferenceAddress: { serverId: 'home', refId: 'checkout' },
    preference: { status: 'ready', revision: 'absent', provenance: 'default', preference: {
      enabled: false, allowAdHoc: false, unavailable: 'ask', scriptOverrides: {},
    } }, secretRequirements: [], workflows: ['.github/workflows/ci.yml'], workflowPath: '.github/workflows/ci.yml',
    workflow: { events: ['push'], jobs: Array.from({ length: 1000 }, (_, index) => ({
      id: `job-${index}`, needs: [], runsOn: ['ubuntu-latest'],
    })) } };
}
function fixture(options: { mutationResult?: unknown; allowExecution?: PluginUiActionControlExecution; runResult?: unknown; compute?: () => Promise<PluginUiActionControlExecution> } = {}) {
  let observed = inspection();
  const execute = vi.fn(async (action: unknown, input: unknown, _request?: { signal?: AbortSignal }) => {
    if (typeof action === 'object') return { ok: true, result: (action as { localId: string }).localId.endsWith('local-run')
      ? options.runResult : structuredClone(observed) };
    if (action === 'projects.worker.preferences.set') {
      if (options.allowExecution !== undefined) return options.allowExecution;
      if (options.mutationResult !== undefined) return options.mutationResult;
      if (observed.preference.status !== 'ready') throw new Error('Unavailable preference');
      observed = { ...observed, preference: { ...observed.preference, revision: 1, provenance: 'saved',
        preference: { ...observed.preference.preference, allowAdHoc: true } } };
      return { ...observed.preference, status: 'applied' };
    }
    if (action === 'projects.worker.preferences.get') return observed.preference;
    if (action === 'projects.compute.exec') return { ok: true, result: options.runResult };
    if (action === 'projects.execution.output.open' || action === 'action.operations.cancel') return null;
    throw new Error(`Unexpected Action ${String(action)}`);
  });
  // Real controller; only host Action transport is substituted.
  const host = { executeAction: execute as PluginUiHostApi['executeAction'] };
  const controller = createLocalRunControllerV1({ accountId: 'account', host,
    seed: { target: { kind: 'session', sessionId: 'session-a6' }, workspace, workflowPath: '.github/workflows/ci.yml', event: 'push' } });
  // Simulate the host boundary: preparation supplies operands; only the host invokes compute and returns its original envelope.
  const run = async (signal = new AbortController().signal) => {
    const prepared = await controller.runControl.prepare({ signal });
    if (!prepared) return;
    await execute('projects.compute.exec', prepared.input);
    await controller.runControl.onSettled(options.compute ? await options.compute() : { ok: true, result: options.runResult });
  };
  const allow = async (signal = new AbortController().signal) => {
    const prepared = await controller.allowControl.prepare({ signal });
    if (!prepared) return;
    const result = await execute('projects.worker.preferences.set', prepared.input);
    await controller.allowControl.onSettled(options.allowExecution ?? { ok: true, result });
  };
  return { controller, run, allow, execute, observed: () => observed, setObservation(next: LocalActInspection) { observed = next; } };
}
describe('local form scoped producer', () => {
  it('prepares the exact existing preference change for a host Allow control without writing or starting a command', async () => {
    const h = fixture();
    await h.controller.inspect();
    const before = h.controller.getSnapshot();
    const control = h.controller.allowControl;
    expect(control).toMatchObject({ prepare: expect.any(Function), onSettled: expect.any(Function) });
    expect(await control.prepare({ signal: AbortSignal.abort() })).toBeNull();
    expect(h.controller.getSnapshot()).toBe(before);
    expect(await control.prepare({ signal: new AbortController().signal })).toEqual({ input: {
      workspace: { serverId: 'home', refId: 'checkout' }, expectedRevision: 'absent',
      expected: { kind: 'absent' }, next: { enabled: false, allowAdHoc: true, unavailable: 'ask', scriptOverrides: {} },
    } });
    expect(h.controller.allowControl).toBe(control);
    expect(h.controller.getSnapshot()).toMatchObject({ permissionPending: true, permissionNeedsObservation: false });
    expect(h.controller.getSnapshot().selection).toBe(before.selection);
    expect(h.controller.getSnapshot().inspection).toBe(before.inspection);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.worker.preferences.set')).toHaveLength(0);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    expect(h.controller.canRun()).toBe(false);
    const retired = h.controller.getSnapshot();
    h.controller.dispose();
    await control.onSettled({ ok: false, errorCode: 'action_outcome_unknown', error: 'Late retired receipt' });
    expect(h.controller.getSnapshot()).toBe(retired);
  });
  it('ignores the old Allow receipt after the accepted checkout changes', async () => {
    const h = fixture();
    await h.controller.inspect();
    const previous = h.observed().preference;
    if (previous.status !== 'ready') throw new Error('Expected ready fixture');
    expect(await h.controller.allowControl.prepare({ signal: new AbortController().signal })).not.toBeNull();
    const nextWorkspace = { ...workspace, machineId: 'secondary', workspaceId: 'checkout-b', rootPath: '/repo-b' };
    h.setObservation({ ...h.observed(), workspace: nextWorkspace, preferenceAddress: { serverId: 'home', refId: 'checkout-b' } });
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, workspace: nextWorkspace });
    await h.controller.inspect();
    const current = h.controller.getSnapshot();
    const reads = h.execute.mock.calls.length;
    await h.controller.allowControl.onSettled({ ok: true, result: { status: 'applied',
      preference: { ...previous.preference, allowAdHoc: true }, revision: 1, provenance: 'saved' } });
    expect(h.controller.getSnapshot()).toBe(current);
    expect(h.controller.getSnapshot()).toMatchObject({ permissionPending: false, permissionResult: null,
      inspection: { workspace: nextWorkspace, preference: { preference: { allowAdHoc: false } } } });
    expect(h.execute.mock.calls).toHaveLength(reads);
    h.controller.dispose();
  });
  it.each([
    { ok: true, result: { kind: 'approval_request_created', artifactId: 'allow-approval', actionId: 'projects.worker.preferences.set' } },
    { ok: false, errorCode: 'action_outcome_unknown', error: 'Original Allow failure', details: { phase: 'settlement' } },
  ] satisfies PluginUiActionControlExecution[])('retains the full Allow settlement envelope without launching or replaying', async execution => {
    const h = fixture({ allowExecution: execution });
    await h.controller.inspect();
    await h.allow();
    expect(h.controller.getSnapshot().permissionResult).toBe(execution);
    expect(h.controller.getSnapshot()).toMatchObject({ permissionPending: false,
      permissionNeedsObservation: !execution.ok, inspection: { preference: { preference: { allowAdHoc: false } } } });
    if (!execution.ok) {
      await h.allow();
      expect(h.execute.mock.calls.filter(([action]) => action === 'projects.worker.preferences.set')).toHaveLength(1);
    }
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    h.controller.dispose();
  });
  it('prepares the current reviewed command for a host control without executing it', async () => {
    const h = fixture();
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    const control = h.controller.runControl;
    expect(control).toMatchObject({ prepare: expect.any(Function), onSettled: expect.any(Function) });
    const prepared = await control.prepare({ signal: new AbortController().signal });
    expect(prepared).toEqual({ input: expect.objectContaining({ workspace, executable: '/tools/act',
      execution: 'primary', choice: { kind: 'primary' }, argv: expect.arrayContaining(['--rm=true', '--reuse=false']) }) });
    expect(h.controller.runControl).toBe(control);
    expect(h.controller.getSnapshot().runState).toBe('submitting');
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    expect(h.execute.mock.calls.filter(([action]) => typeof action === 'object')).toHaveLength(2);
    h.controller.dispose();
  });
  it('projects selected and dependency runner labels once at the producer and preserves equal requirements across unrelated changes', async () => {
    const h = fixture();
    h.setObservation({ ...h.observed(), workflow: { events: ['push'], jobs: [
      { id: 'build', needs: [], runsOn: ['ubuntu-24.04'] },
      { id: 'test', needs: ['build'], runsOn: ['ubuntu-latest'] },
      { id: 'other', needs: [], runsOn: ['other-linux'] },
    ] } });
    await h.controller.inspect();
    expect(h.controller.getSnapshot().runnerRequirements).toEqual({ kind: 'ready',
      labels: ['other-linux', 'ubuntu-latest', 'ubuntu-24.04'] });
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, yamlJobId: 'test' });
    const required = h.controller.getSnapshot().runnerRequirements;
    expect(required).toEqual({ kind: 'ready', labels: ['ubuntu-latest', 'ubuntu-24.04'] });
    h.setObservation({ ...h.observed(), workflow: { ...h.observed().workflow!,
      jobs: h.observed().workflow!.jobs.map(job => job.id === 'other' ? { ...job, runsOn: ['different-linux'] } : job) } });
    await h.controller.inspect();
    expect(h.controller.getSnapshot().runnerRequirements).toBe(required);
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64' });
    expect(h.controller.getSnapshot().runnerRequirements).toBe(required);
    h.controller.dispose();
  });
  it('settles a reviewed preference conflict before a deliberate Allow using the fresh expectation', async () => {
    const first = inspection().preference;
    if (first.status !== 'ready') throw new Error('Expected ready fixture');
    const h = fixture({ mutationResult: { ...first, status: 'conflict' } });
    await h.controller.inspect(); await h.allow();
    const current = { ...first, revision: 8, provenance: 'saved' as const,
      preference: { ...first.preference, unavailable: 'fail' as const, scriptOverrides: { lint: 'primary' as const } } };
    h.setObservation({ ...h.observed(), preference: current });
    const draft = h.controller.getSnapshot().selection;
    await h.controller.observePermission();
    expect(h.controller.getSnapshot()).toMatchObject({ permissionResult: null, permissionNeedsObservation: false,
      inspection: { preference: current } });
    expect(h.controller.getSnapshot().selection).toBe(draft);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.worker.preferences.set')).toHaveLength(1);
    await h.allow();
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.worker.preferences.set')[1]?.[1])
      .toEqual({ workspace: { serverId: 'home', refId: 'checkout' }, expectedRevision: 8,
        expected: { kind: 'value', value: current.preference }, next: { ...current.preference, allowAdHoc: true } });
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    h.controller.dispose();
  });
  it('retires an unsent Run preflight to idle when the mounted selection changes scope', async () => {
    const h = fixture({ runResult: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'review' } });
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    let settle!: (value: LocalActInspection) => void;
    h.execute.mockImplementationOnce(async () => await new Promise<LocalActInspection>(resolve => { settle = resolve; }));
    const running = h.run();
    const oldInspection = h.observed();
    const workflowPath = '.github/workflows/other.yml';
    h.setObservation({ ...oldInspection, workflowPath });
    await h.controller.invoke({ kind: 'setSelection', selection: { ...h.controller.getSnapshot().selection, workflowPath } });
    expect(h.controller.getSnapshot().runState).toBe('idle');
    settle(oldInspection); await running;
    expect(h.controller.canRun()).toBe(true);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    await h.run();
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(1);
    h.controller.dispose();
  });
  it('exposes a failed inspection separately from setting state and retries without replacing the draft or launching', async () => {
    const h = fixture();
    h.execute.mockImplementationOnce(async () => ({ ok: false, errorCode: 'machine_offline' }));
    await h.controller.inspect();
    expect(h.controller.getSnapshot()).toMatchObject({ inspectionError: 'machine_offline', loading: false, inspection: null });
    const draft = h.controller.getSnapshot().selection;
    await h.controller.inspect();
    expect(h.controller.getSnapshot()).toMatchObject({ inspectionError: null, loading: false, inspection: { workspace } });
    expect(h.controller.getSnapshot().selection).toBe(draft);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    h.controller.dispose();
  });
  it('projects only the bound Home/Machine name and preserves unrelated form identity', async () => {
    const h = fixture();
    await h.controller.inspect();
    const initial = h.controller.getSnapshot();
    expect(initial.machineDisplayName).toBeNull();
    const address = { serverId: workspace.serverId, machineId: workspace.machineId };
    h.controller.receiveMachineDisplayName(address, 'Build box');
    const named = h.controller.getSnapshot();
    expect(named.machineDisplayName).toBe('Build box');
    expect(named.selection).toBe(initial.selection);
    expect(named.inspection).toBe(initial.inspection);
    h.controller.receiveMachineDisplayName(address, 'Build box');
    expect(h.controller.getSnapshot()).toBe(named);
    h.controller.receiveMachineDisplayName({ ...address, serverId: 'another-home' }, 'Wrong Home');
    h.controller.receiveMachineDisplayName({ ...address, machineId: 'another-machine' }, 'Wrong Machine');
    expect(h.controller.getSnapshot()).toBe(named);
    h.controller.receiveMachineDisplayName(address, null);
    expect(h.controller.getSnapshot().machineDisplayName).toBeNull();
    h.controller.dispose();
    h.controller.receiveMachineDisplayName(address, 'Late retired name');
    expect(h.controller.getSnapshot().machineDisplayName).toBeNull();
  });
  it('clears a previous Machine name on exact address change and rejects its late receipt', () => {
    const h = fixture();
    const address = { serverId: workspace.serverId, machineId: workspace.machineId };
    h.controller.receiveMachineDisplayName(address, 'Build box');
    const sameMachineCheckout = { ...workspace, workspaceId: 'checkout-b', rootPath: '/repo-b' };
    h.setObservation({ ...h.observed(), workspace: sameMachineCheckout });
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, workspace: sameMachineCheckout });
    expect(h.controller.getSnapshot().machineDisplayName).toBe('Build box');
    const nextWorkspace = { ...sameMachineCheckout, serverId: 'home-b', machineId: 'secondary' };
    h.setObservation({ ...h.observed(), workspace: nextWorkspace });
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, workspace: nextWorkspace });
    expect(h.controller.getSnapshot().machineDisplayName).toBeNull();
    h.controller.receiveMachineDisplayName(address, 'Late old name');
    expect(h.controller.getSnapshot().machineDisplayName).toBeNull();
    h.controller.receiveMachineDisplayName({ serverId: nextWorkspace.serverId, machineId: nextWorkspace.machineId }, 'Secondary box');
    expect(h.controller.getSnapshot().machineDisplayName).toBe('Secondary box');
    h.controller.dispose();
  });
  it('preserves keyed jobs/choices across equal inspection, reorder and one changed row', () => {
    const previous = inspection();
    const equal = reconcileLocalActInspectionV1(previous, structuredClone(previous));
    expect(equal).toBe(previous);
    const reordered = reconcileLocalActInspectionV1(previous, { ...structuredClone(previous),
      workflow: { ...previous.workflow!, jobs: [...previous.workflow!.jobs].reverse() } });
    expect(reordered.workflow!.jobs[999]).toBe(previous.workflow!.jobs[0]);
    const changed = reconcileLocalActInspectionV1(previous, { ...structuredClone(previous),
      workflow: { ...previous.workflow!, jobs: previous.workflow!.jobs.map((job, index) => index === 500
        ? { ...job, runsOn: ['ubuntu-24.04'] } : { ...job }) } });
    expect(changed.workflow!.jobs.filter((job, index) => job !== previous.workflow!.jobs[index])).toHaveLength(1);
    expect(changed.workflow!.events).toBe(previous.workflow!.events);
  });
  it('reads once per deliberate inspection and permission receipt preserves draft and job identities without another inspect/run', async () => {
    const h = fixture();
    await h.controller.inspect();
    const before = h.controller.getSnapshot();
    h.controller.setSelection({ ...before.selection, architecture: 'linux/arm64', matrix: ['node:22'] });
    const draft = h.controller.getSnapshot().selection;
    expect(draft.platforms).toBe(before.selection.platforms);
    expect(draft.workspace).toBe(before.selection.workspace);
    let jobPublications = 0;
    const jobs = before.inspection!.workflow!.jobs;
    h.controller.subscribe(() => { if (h.controller.getSnapshot().inspection!.workflow!.jobs !== jobs) jobPublications++; });
    await h.controller.inspect();
    await h.allow();
    expect(h.controller.getSnapshot().selection).toBe(draft);
    expect(h.controller.getSnapshot().inspection!.workflow!.jobs).toBe(jobs);
    expect(jobPublications).toBe(0);
    expect(h.execute.mock.calls.map(([action]) => typeof action === 'object' ? 'inspect' : action))
      .toEqual(['inspect', 'inspect', 'projects.worker.preferences.set']);
    expect(h.execute.mock.calls[2]![1]).toEqual({ workspace: { serverId: 'home', refId: 'checkout' },
      expectedRevision: 'absent', expected: { kind: 'absent' }, next: { enabled: false, allowAdHoc: true, unavailable: 'ask', scriptOverrides: {} } });
    h.controller.dispose();
  });
  it('does no work after disposal and rejects retired mounted selection without process effects', async () => {
    const h = fixture(); await h.controller.inspect();
    h.controller.dispose();
    expect(await h.controller.invoke({ kind: 'readSelection' })).toEqual({ status: 'unavailable' });
    expect(await h.controller.invoke({ kind: 'setSelection', selection: h.controller.getSnapshot().selection })).toEqual({ status: 'unavailable' });
    await h.controller.inspect();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('freshly inspects for the host control and consumes the original setup envelope', async () => {
    const hold = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'review' };
    const h = fixture({ runResult: hold });
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    await h.run();
    expect(h.execute.mock.calls.filter(([action]) => typeof action === 'object').map(([action]) => (action as { localId: string }).localId))
      .toEqual(['github/actions/local-inspect', 'github/actions/local-inspect']);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec').map(([, input]) => input))
      .toEqual([expect.objectContaining({ workspace, executable: '/tools/act', cwd: '/repo', execution: 'primary',
        choice: { kind: 'primary' }, argv: expect.arrayContaining(['--insecure-secrets=false', '--rm=true', '--reuse=false']) })]);
    expect(h.controller.getSnapshot().lastResult).toEqual({ ok: true, result: hold });
    h.controller.dispose();
  });
  it('refuses changed tool readiness on explicit Run without treating a no-launch refusal as uncertain acceptance', async () => {
    const h = fixture();
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    h.setObservation({ ...h.observed(), tool: { kind: 'unavailable', code: 'system_tool_missing' } });
    await h.run();
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    expect(h.controller.getSnapshot()).toMatchObject({ runState: 'idle', error: 'system_tool_missing' });
    expect(h.controller.canRun()).toBe(false);
    h.controller.dispose();
  });
  it('keeps output and Stop on the accepted operation after the editable checkout changes', async () => {
    const result = { operation: { version: 1, operationId: 'accepted-a', revision: 1,
      actionId: 'projects.compute.exec', state: 'accepted', scope: { accountId: 'account', machineId: 'custodian-a' },
      title: 'Local command', createdAt: 1, cancellation: 'supported',
      domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: 'primary', workspaceRefId: 'checkout', cwd: '/repo' },
    } };
    let settle!: (execution: PluginUiActionControlExecution) => void;
    let entered!: () => void;
    const invoked = new Promise<void>(resolve => { entered = resolve; });
    const h = fixture({ compute: async () => { entered(); return await new Promise(resolve => { settle = resolve; }); } });
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection,
      architecture: 'linux/arm64', platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    const running = h.run(); await invoked;
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, workspace: { ...workspace, machineId: 'other', workspaceId: 'checkout-b' } });
    const execution = { ok: true, result } satisfies PluginUiActionControlExecution;
    settle(execution); await running;
    expect(h.controller.getSnapshot().lastResult).toBe(execution);
    expect(h.controller.getSnapshot().operationWorkspace).toEqual(workspace);
    await h.controller.openOutput(); await h.controller.stop();
    const ref = { serverId: 'home', machineId: 'custodian-a', operationId: 'accepted-a' };
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.execution.output.open').map(([, input]) => input)).toEqual([ref]);
    expect(h.execute.mock.calls.filter(([action]) => action === 'action.operations.cancel').map(([, input]) => input)).toEqual([ref]);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(1);
    h.controller.dispose();
  });
  it.each(['succeeded', 'failed', 'cancelled'] as const)('derives explicit rerun from available qualified %s settlement, not acceptance or Stop intent', async state => {
    const operation = { version: 1 as const, operationId: 'accepted-a', revision: 1,
      actionId: 'projects.compute.exec' as const, state: 'accepted' as const,
      scope: { accountId: 'account', machineId: 'custodian-a' }, title: 'Local command', createdAt: 1,
      cancellation: 'supported' as const,
      domainRef: { kind: 'projectCommand' as const, purpose: 'exec' as const, serverId: 'home',
        machineId: 'primary', workspaceRefId: 'checkout', cwd: '/repo' } };
    const h = fixture({ runResult: { operation } });
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    await h.run();
    const ref = h.controller.getSnapshot().operationRef!;
    expect(h.controller.canRun()).toBe(false);
    expect(h.controller.getSnapshot().operation?.state).toBe('accepted');
    const receive = (address: typeof ref, observed: unknown) =>
      h.controller.receiveOperation(address, PluginUiActionOperationHostReadResultV1ProtocolSchema.parse(observed));
    receive(ref, { operation: { ...operation, state: 'running', revision: 2, startedAt: 2 }, observation: 'available' });
    expect(h.controller.getSnapshot().operation?.state).toBe('running');
    await h.controller.stop();
    expect(h.controller.canRun()).toBe(false);
    const terminal = { ...operation, state, revision: 3, startedAt: 2, settledAt: 3,
      ...(state === 'failed' ? { error: { errorCode: 'process_failed', error: 'Process failed' } } : {}) };
    receive({ ...ref, operationId: 'other' }, {
      operation: { ...terminal, operationId: 'other' }, observation: 'available' });
    expect(h.controller.getSnapshot().operation?.state).toBe('running');
    receive(ref, { operation: terminal, observation: 'reconnecting' });
    expect(h.controller.canRun()).toBe(false);
    receive(ref, { operation: terminal, observation: 'available' });
    expect(h.controller.getSnapshot().operation?.state).toBe(state);
    expect(h.controller.canRun()).toBe(true);
    const settled = h.controller.getSnapshot();
    receive(ref, { operation: structuredClone(settled.operation), observation: 'available' });
    expect(h.controller.getSnapshot()).toBe(settled);
    await h.controller.openOutput();
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(1);
    await h.run();
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(2);
    h.controller.dispose();
  });
  it('keeps uncertain in-flight acceptance visible after the editable checkout retires its signal, without replay', async () => {
    let settle!: (value: PluginUiActionControlExecution) => void;
    let entered!: () => void;
    const invoked = new Promise<void>(resolve => { entered = resolve; });
    const h = fixture({ compute: async () => {
      entered(); return await new Promise(resolve => { settle = resolve; });
    } });
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    const running = h.run(); await invoked;
    const nextWorkspace = { ...workspace, machineId: 'other', workspaceId: 'checkout-b' };
    h.setObservation({ ...h.observed(), workspace: nextWorkspace, preferenceAddress: { serverId: 'home', refId: 'checkout-b' } });
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, workspace: nextWorkspace });
    const execution = { ok: false, errorCode: 'aborted', error: 'No observed acceptance', details: { layer: 'transport', phase: 'settlement' } } as const;
    settle(execution);
    await running;
    expect(h.controller.getSnapshot()).toMatchObject({ runState: 'uncertain', error: 'aborted',
      selection: { workspace: nextWorkspace } });
    expect(h.controller.getSnapshot().lastResult).toBe(execution);
    expect(h.controller.canRun()).toBe(false);
    h.controller.dispose();
  });
  it('cancels host-aborted preparation before compute and returns the unchanged form to idle', async () => {
    const h = fixture();
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    const draft = h.controller.getSnapshot().selection;
    const signal = new AbortController();
    let settle!: (value: LocalActInspection) => void;
    const inspected: { signal?: AbortSignal } = {};
    h.execute.mockImplementationOnce(async (_action, _input, request) => {
      inspected.signal = request?.signal;
      return await new Promise<LocalActInspection>(resolve => { settle = resolve; });
    });
    const preparing = h.controller.runControl.prepare({ signal: signal.signal });
    signal.abort();
    expect(inspected.signal?.aborted).toBe(true);
    settle(h.observed());
    expect(await preparing).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({ runState: 'idle', loading: false });
    expect(h.controller.getSnapshot().selection).toBe(draft);
    expect(h.controller.canRun()).toBe(true);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    h.controller.dispose();
  });
  it.each([
    ['action_not_admitted', 'idle'],
    ['action_outcome_unknown', 'uncertain'],
  ] as const)('retains the complete %s host envelope without replay', async (errorCode, runState) => {
    const execution = { ok: false, errorCode, error: 'Original failure', details: { phase: 'settlement', reason: 'fixture' }, operationCredentialUses: [] } satisfies PluginUiActionControlExecution;
    const h = fixture({ compute: async () => execution });
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    await h.run();
    expect(h.controller.getSnapshot().lastResult).toBe(execution);
    expect(h.controller.getSnapshot()).toMatchObject({ runState, error: errorCode, operationRef: null });
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(1);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.execution.output.open')).toHaveLength(0);
    h.controller.dispose();
  });
  it('retains an original approval envelope and ignores settlement after retirement', async () => {
    const execution = { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'projects.compute.exec' }, operationCredentialUses: [] } satisfies PluginUiActionControlExecution;
    const h = fixture({ compute: async () => execution });
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    await h.run();
    expect(h.controller.getSnapshot().lastResult).toBe(execution);
    expect(h.controller.getSnapshot()).toMatchObject({ runState: 'idle', operationRef: null });
    expect(await h.controller.runControl.prepare({ signal: new AbortController().signal })).not.toBeNull();
    const retired = h.controller.getSnapshot();
    h.controller.dispose();
    await h.controller.runControl.onSettled({ ok: false, errorCode: 'action_outcome_unknown', error: 'Late settlement' });
    expect(h.controller.getSnapshot()).toBe(retired);
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(1);
  });
  it('retains definite no-launch refusal when its permission observation fails', async () => {
    const h = fixture();
    await h.controller.inspect(); await h.allow();
    h.controller.setSelection({ ...h.controller.getSnapshot().selection, architecture: 'linux/arm64',
      platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }] });
    expect(await h.controller.runControl.prepare({ signal: new AbortController().signal })).not.toBeNull();
    h.execute.mockImplementationOnce(async () => { throw new Error('Permission transport unavailable'); });
    const execution = { ok: false, errorCode: 'ad_hoc_disabled', error: 'Commands were disabled' } satisfies PluginUiActionControlExecution;
    await expect(h.controller.runControl.onSettled(execution)).resolves.toBeUndefined();
    expect(h.controller.getSnapshot()).toMatchObject({ lastResult: execution, error: 'ad_hoc_disabled',
      runState: 'idle', permissionNeedsObservation: true });
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.compute.exec')).toHaveLength(0);
    h.controller.dispose();
  });
  it.each(['locked', 'invalid', 'unavailable', 'outcomeUnknown'] as const)('does not reinterpret %s as disabled or auto-replay the preference write', async status => {
    const h = fixture({ mutationResult: { status } });
    await h.controller.inspect(); await h.allow();
    expect(h.controller.canRun()).toBe(false);
    await h.allow();
    expect(h.execute.mock.calls.filter(([action]) => action === 'projects.worker.preferences.set')).toHaveLength(1);
    h.controller.dispose();
  });
});
