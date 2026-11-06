import { expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import type { ActionExecutorContext } from './executor/types.js';

const context: ActionExecutorContext = { serverId: 'home', defaultSessionId: 'current',
  externalActionTarget: { kind: 'machine', machineId: 'guest' }, executionRunTargetMachineId: 'guest' };

it('demands the explicit Sync controller for flush while passive relationship reads stay asleep', () => {
  expect(getActionSpec('workspace.sync.relationship.flush').machineRuntimeDemandForInput?.(
    { controllerMachineId: 'sync-controller', relationshipId: 'link' }, context))
    .toEqual({ target: { kind: 'machine', machineId: 'sync-controller' }, serverId: 'home' });
  expect(getActionSpec('workspace.sync.relationships.list').machineRuntimeDemandForInput?.({}, context) ?? null).toBeNull();
});
