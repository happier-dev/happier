import { describe, expect, it, vi } from 'vitest';

import { ActionIdSchema } from '../actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { isRuntimeActionExecutorReal, resolveRuntimeActionSurfaces } from '../surfaces.js';

describe('service relocation Action', () => {
  it('advertises relocation with the same real runtime executor family as native controls', () => {
    expect(isRuntimeActionExecutorReal('projects.service.relocate')).toBe(true);
    expect(resolveRuntimeActionSurfaces('projects.service.relocate').ui).toBe(true);
    expect(isRuntimeActionExecutorReal('localServices.actions.stopManaged')).toBe(true);
    expect(resolveRuntimeActionSurfaces('localServices.actions.stopManaged').ui).toBe(true);
  });

  it('discovers relocation and invokes the registered runtime leaf through the Action front door', async () => {
    const currentTarget = { kind: 'managed_service' as const, managedServiceId: 'service', machineId: 'old', cwd: '/old',
      declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest' as const, name: 'worker' } } };
    const input = { workspace: { serverId: 'home', refId: 'workspace' }, serviceName: 'worker', requestId: 'move-1',
      currentTarget, destination: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'new' } } };
    const runtimeActionExecute = vi.fn(async () => ({ status: 'moved' as const, currentTarget: { ...currentTarget, machineId: 'new' } }));
    const executor = createActionExecutor({ runtimeActionExecute, isActionApprovalRequired: () => false } as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home' };
    expect(await executor.execute('action.spec.search', { query: 'projects.service.relocate', limit: 10 }, context))
      .toMatchObject({ ok: true, result: { actionSpecs: [expect.objectContaining({ id: 'projects.service.relocate' })] } });
    expect(await executor.execute('projects.service.relocate', input, context)).toMatchObject({ ok: true, result: { status: 'moved' } });
    expect(runtimeActionExecute).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'projects.service.relocate', input }));
  });
  it('classifies relocation as dangerous and source-tracked without publishing an unbacked RPC', async () => {
    const actionId = ActionIdSchema.parse('projects.service.relocate');
    const { getActionSpec } = await import('../actionSpecs.js');
    const spec = getActionSpec(actionId);
    expect(spec.safety).toBe('danger');
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.operation).toMatchObject({ version: 1, progress: 'reported' });
    expect(spec.bindings?.rpcMethod).toBeUndefined();
  });

  it('accepts only the incumbent exact managed target and refuses a second binding witness', async () => {
    const actionId = ActionIdSchema.parse('projects.service.relocate');
    const { getActionSpec } = await import('../actionSpecs.js');
    const spec = getActionSpec(actionId);
    const input = { workspace: { serverId: 'home', refId: 'workspace' }, serviceName: 'worker', requestId: 'move-1',
      currentTarget: { kind: 'managed_service', managedServiceId: 'service', machineId: 'old', cwd: '/old',
        declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'worker' } } },
      destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'new' } } };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, expectedBinding: input.currentTarget }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, currentTarget: { kind: 'inventory_entry', inventoryEntryId: 'listener', machineId: 'old' } }).success).toBe(false);
  });
});
