import { describe, expect, it, vi } from 'vitest';

import { ActionIdSchema } from '../actionIds.js';
import { ActionSpecSchema } from '../actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { isRuntimeActionExecutorReal, resolveRuntimeActionSurfaces } from '../surfaces.js';
import { isProjectServiceMoveChildInputV1 } from '../../workspaces/projectServiceRelocationV1.js';
import { createProjectServiceDeclarationTargetIdV1 } from '../../local/services/actions/v1.js';

function relocationInput(currentTarget: Readonly<Record<string, unknown>>) {
  const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'new' } };
  return { workspace: { serverId: 'home', refId: 'workspace' }, sourceMachineId: 'source-checkout', serviceName: 'worker', requestId: 'move-1',
    currentTarget, destination,
    desiredPlacement: { workspace: { serverId: 'home', refId: 'workspace' }, serviceName: 'worker', expectedRevision: 'absent' as const,
      expected: { kind: 'absent' as const }, value: { runsOn: destination, unavailable: 'fail' as const } },
    selectedTarget: { machineId: 'new' } };
}

describe('service relocation Action', () => {
  it('keeps a reviewed destination Start on its exact workspace and resolved placement', () => {
    const selection = { kind: 'manifest' as const, name: 'worker' };
    const root = relocationInput({ kind: 'managed_service', managedServiceId: 'service', machineId: 'old',
      workspaceId: 'workspace', cwd: '/old', declaration: { workspaceRefId: 'workspace', selection } });
    const start = { machineId: 'new', targetId: createProjectServiceDeclarationTargetIdV1({ id: 'receiving',
      serverId: 'home', machineId: 'new' }, selection), workspaceId: 'receiving',
      workspace: { serverId: 'home', machineId: 'new', workspaceId: 'receiving', rootPath: '/new' },
      declaration: { workspaceRefId: 'receiving', selection }, choice: root.destination };
    expect(isProjectServiceMoveChildInputV1(root, 'localServices.launcher.start', 'new', start)).toBe(true);
    for (const change of [
      { choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'unreviewed' } } },
      { choice: { kind: 'primary' } }, { workspaceId: 'another-workspace' }, { sessionId: 'another-session' },
    ]) expect(isProjectServiceMoveChildInputV1(root, 'localServices.launcher.start', 'new', { ...start, ...change })).toBe(false);
    const inspect = { workspace: start.workspace, reviewSetupConsent: true };
    expect(isProjectServiceMoveChildInputV1(root, 'projects.inspect', 'new', inspect)).toBe(true);
    expect(isProjectServiceMoveChildInputV1(root, 'projects.inspect', 'new', { ...inspect,
      workspace: { ...start.workspace, serverId: 'another-home' } })).toBe(false);
    expect(isProjectServiceMoveChildInputV1(root, 'projects.inspect', 'new', { ...inspect,
      workspace: { ...start.workspace, machineId: 'unreviewed' } })).toBe(false);
    expect(isProjectServiceMoveChildInputV1(root, 'projects.manifest.update', 'new', inspect)).toBe(false);
  });
  it('advertises relocation with the same real runtime executor family as native controls', () => {
    expect(isRuntimeActionExecutorReal('projects.service.relocate')).toBe(true);
    expect(resolveRuntimeActionSurfaces('projects.service.relocate').ui).toBe(true);
    expect(isRuntimeActionExecutorReal('localServices.actions.stopManaged')).toBe(true);
    expect(resolveRuntimeActionSurfaces('localServices.actions.stopManaged').ui).toBe(true);
  });

  it('discovers relocation and invokes the registered runtime leaf through the Action front door', async () => {
    const currentTarget = { kind: 'managed_service' as const, managedServiceId: 'service', machineId: 'old', cwd: '/old',
      declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest' as const, name: 'worker' } } };
    const input = relocationInput(currentTarget);
    const runtimeActionExecute = vi.fn(async () => ({ status: 'moved' as const, currentTarget: { ...currentTarget, machineId: 'new' } }));
    const executor = createActionExecutor({ runtimeActionExecute } as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home' };
    expect(await executor.execute('action.spec.search', { query: 'projects.service.relocate', limit: 10 }, context))
      .toMatchObject({ ok: true, result: { actionSpecs: [expect.objectContaining({ id: 'projects.service.relocate' })] } });
    expect(await executor.execute('projects.service.relocate', input, context)).toMatchObject({ ok: true, result: { status: 'moved' } });
    expect(runtimeActionExecute).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'projects.service.relocate', input }));
    const { sourceMachineId: _sourceMachineId, ...withoutSourceMachine } = input;
    expect(await executor.execute('projects.service.relocate', withoutSourceMachine, context)).toMatchObject({ ok: false });
  });
  it('classifies relocation as dangerous and source-tracked without publishing an unbacked RPC', async () => {
    const actionId = ActionIdSchema.parse('projects.service.relocate');
    const { getActionSpec } = await import('../actionSpecs.js');
    const spec = getActionSpec(actionId);
    expect(spec.safety).toBe('danger');
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.operation).toMatchObject({ version: 1, progress: 'reported' });
    expect(spec.bindings?.rpcMethod).toBeUndefined();
    expect(spec.surfaces).toMatchObject({ cli: true, mcp: true, voice: true, rpc: false });
    expect(ActionSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('accepts only the incumbent exact managed target and refuses a second binding witness', async () => {
    const actionId = ActionIdSchema.parse('projects.service.relocate');
    const { getActionSpec } = await import('../actionSpecs.js');
    const spec = getActionSpec(actionId);
    const input = relocationInput({ kind: 'managed_service', managedServiceId: 'service', machineId: 'old', cwd: '/old',
      declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'worker' } } });
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, expectedBinding: input.currentTarget }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, currentTarget: { kind: 'inventory_entry', inventoryEntryId: 'listener', machineId: 'old' } }).success).toBe(false);
  });
});
