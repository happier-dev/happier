import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkspaceChildBuildEnv } from './workspaceChildBuildEnv.mjs';

test('workspace child builds do not inherit the parent package staged output directory', () => {
  const parentEnv = {
    PATH: '/repo/bin',
    HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: '/repo/packages/plugin-sdk/.dist.parent-stage',
    Happier_Workspace_Dist_Output_Dir: '/repo/packages/plugin-sdk/.dist.mixed-case-parent-stage',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: 'parent-lease',
    Happier_Workspace_Dist_Build_Lock_Held: 'mixed-case-parent-lease',
    HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1',
    Happier_Workspace_Package_Prerequisites_Ready: '1',
  };

  const childEnv = createWorkspaceChildBuildEnv({
    env: parentEnv,
    heldLockValue: 'child-lease',
  });

  assert.equal(childEnv.PATH, '/repo/bin');
  assert.equal(childEnv.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, undefined);
  assert.equal(childEnv.Happier_Workspace_Dist_Output_Dir, undefined);
  assert.equal(childEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, 'child-lease');
  assert.equal(childEnv.Happier_Workspace_Dist_Build_Lock_Held, undefined);
  assert.equal(childEnv.HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY, undefined);
  assert.equal(childEnv.Happier_Workspace_Package_Prerequisites_Ready, undefined);
  assert.equal(parentEnv.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, '/repo/packages/plugin-sdk/.dist.parent-stage');
  assert.equal(
    parentEnv.Happier_Workspace_Dist_Output_Dir,
    '/repo/packages/plugin-sdk/.dist.mixed-case-parent-stage',
  );
  assert.equal(parentEnv.Happier_Workspace_Dist_Build_Lock_Held, 'mixed-case-parent-lease');
  assert.equal(parentEnv.HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY, '1');
});

test('workspace child builds unset inherited lock lease aliases when no lease is held', () => {
  const childEnv = createWorkspaceChildBuildEnv({
    env: {
      Happier_Workspace_Dist_Build_Lock_Held: 'mixed-case-parent-lease',
    },
  });

  assert.equal(childEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, undefined);
  assert.equal(childEnv.Happier_Workspace_Dist_Build_Lock_Held, undefined);
});
