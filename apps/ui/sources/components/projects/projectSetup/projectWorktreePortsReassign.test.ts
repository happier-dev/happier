import { expect, it } from 'vitest';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createProjectManifestActionClient } from './projectManifestActionClient';

it('returns authoritative stopped-port reassignment results through the existing Project Action', async () => {
  const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/repo' };
  const results = [
    { kind: 'unavailable', code: 'project_worktree_ports_active', reason: 'active' },
    { kind: 'ready', assignment: { ports: [4100], listenerPorts: {} } },
  ] as const;
  const requests: unknown[] = [];
  let index = 0;
  const execute = createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
    projectDefinitionAction: async request => { requests.push(request); return results[index++]; },
  }), 'alice'));
  const actions = createProjectManifestActionClient({ workspace, expectedAccountId: 'alice', execute });
  expect(await actions.reassignWorktreePorts({ confirmed: true })).toEqual(results[0]);
  expect(await actions.reassignWorktreePorts({ confirmed: true })).toEqual(results[1]);
  expect(requests).toEqual(results.map(() => expect.objectContaining({ input: { workspace } })));
});
