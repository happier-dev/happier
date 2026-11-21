import { afterEach, expect, it } from 'vitest';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import type { ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';

import { useWorkflowProjectGroupDisplay } from './workflowLibraryProjectGroups';

afterEach(standardCleanup);

it('lists managed and Machine Projects without assigning the controller name to the managed checkout', async () => {
  const { id: serverId } = await selectActiveTestHomeForTests();
  const scope = { serverId, accountId: 'workflow-project-account' };
  const previousState = storage.getState();
  const machine = createMachineFixture({
    id: 'workflow-project-controller',
    metadata: createMachineMetadataFixture({ displayName: 'Dev box' }),
  });
  storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId });
  const common = { serverId: scope.serverId, rootPath: '/work/website', createdAtMs: 1 };
  const census: ProjectAccountRowsSnapshot = {
    scope,
    status: 'ready',
    coverage: 'complete',
    workspaceRefs: [
      WorkspaceRefV1Schema.parse({ ...common, id: 'local', machineId: machine.id, projectKey: 'a' }),
      WorkspaceRefV1Schema.parse({ ...common, id: 'native', v: 2, kind: 'managed', managedId: 'native-workflow', projectKey: 'b',
        controller: { machineId: machine.id, installationId: 'workflow-project-installation' } }),
    ],
    relationships: [],
    organizations: [],
    revisionsByPhysicalKey: {},
  };
  try {
    const hook = await renderHook(() => useWorkflowProjectGroupDisplay(census, true));
    expect([...hook.getCurrent()!.values()].map(({ title }) => title)).toEqual([
      'website · Dev box',
      'website · 2',
    ]);
    await hook.unmount();
  } finally {
    storage.setState(previousState, true);
  }
});
