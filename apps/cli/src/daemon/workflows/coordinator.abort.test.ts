import { getEventListeners } from 'node:events';
import { expect, it } from 'vitest';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';

it('does not retain abort listeners on the caller after completed runs', async () => {
  const controller = new AbortController();
  const initialListeners = getEventListeners(controller.signal, 'abort').length;
  const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } as const;
  for (let run = 0; run < 3; run += 1) {
    const coordinator = createTestWorkflowCoordinator({
      store: createInMemoryWorkflowCoordinatorStore(),
      resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } }),
      executeStep: async params => {
        await params.beforeInputAdmission();
        return { kind: 'completed', result: 'answer' };
      },
    });
    await expect(coordinator.run({
      runId: `completed-abort-${run}`, inputs: {},
      definition: { version: 1, inputs: [], defaults: { agentTarget }, blocks: [{
        kind: 'step', id: 'answer', document: { text: 'answer', references: [], attachments: [] },
        input: [], result: { kind: 'text' }, execution: { conversation: { kind: 'fresh' } },
      }] },
      executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      signal: controller.signal,
    })).resolves.toMatchObject({ state: 'succeeded' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(initialListeners);
  }
});
