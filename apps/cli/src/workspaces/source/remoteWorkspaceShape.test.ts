import { describe, expect, it } from 'vitest';

import { readWorkspaceSourcePlacement } from './workspaceSource';

const managedWorkspace = {
  v: 2 as const,
  kind: 'managed' as const,
  id: 'project-workspace',
  serverId: 'home',
  managedId: 'coder-workspace',
  controller: { machineId: 'controller', installationId: 'controller-installation' },
  rootPath: '/home/coder/project',
  createdAtMs: 1,
};

describe('remote workspace shape contracts', () => {
  it.fails('R1/F2/F3: admitted placement keeps a managed workspace namespace instead of falling back to rootPath-only local selection', () => {
    const placement = readWorkspaceSourcePlacement(undefined, {
      rootPath: managedWorkspace.rootPath,
      workspace: managedWorkspace,
    });

    // The expected failure is the missing managed arm in WorkspaceSourcePlacement.
    // A root path alone can alias a controller folder with the same name.
    expect(placement).toMatchObject({ workspace: managedWorkspace });
  });
});
