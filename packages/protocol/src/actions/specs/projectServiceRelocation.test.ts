import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from '../actionIds.js';
import { isRuntimeActionExecutorReal, resolveRuntimeActionSurfaces } from '../surfaces.js';

describe('service relocation Action', () => {
  it('keeps unbacked relocation unadvertised without disabling actual native controls', () => {
    expect(isRuntimeActionExecutorReal('projects.service.relocate')).toBe(false);
    expect(Object.values(resolveRuntimeActionSurfaces('projects.service.relocate')).every(enabled => enabled === false)).toBe(true);
    expect(isRuntimeActionExecutorReal('localServices.actions.stopManaged')).toBe(true);
    expect(resolveRuntimeActionSurfaces('localServices.actions.stopManaged').ui).toBe(true);
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
