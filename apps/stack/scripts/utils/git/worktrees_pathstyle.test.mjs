import test from 'node:test';
import assert from 'node:assert/strict';

import { isWorktreePath, resolveComponentSpecToDir, worktreeSpecFromDir } from './worktrees.mjs';

test('isWorktreePath supports win32-style path separators', () => {
  const rootDir = '/tmp/happier-stack-root';
  const env = { HAPPIER_STACK_WORKSPACE_DIR: 'C:\\happier\\workspace' };
  assert.equal(isWorktreePath({ rootDir, dir: 'C:\\happier\\workspace\\pr\\123-fix-thing', env }), true);
});

test('isWorktreePath rejects non-category workspace paths for win32-style separators', () => {
  const rootDir = '/tmp/happier-stack-root';
  const env = { HAPPIER_STACK_WORKSPACE_DIR: 'C:\\happier\\workspace' };
  assert.equal(isWorktreePath({ rootDir, dir: 'C:\\happier\\workspace\\main', env }), false);
  assert.equal(isWorktreePath({ rootDir, dir: 'C:\\happier\\workspace\\dev', env }), false);
});

test('resolveComponentSpecToDir treats win32-style absolute specs as absolute', () => {
  const rootDir = '/tmp/happier-stack-root';
  const env = { HAPPIER_STACK_WORKSPACE_DIR: '/tmp/workspace' };
  const dir = resolveComponentSpecToDir({
    rootDir,
    component: 'happier-cli',
    spec: 'C:\\happier\\workspace\\pr\\123-fix-thing',
    env,
  });
  assert.equal(dir, 'C:\\happier\\workspace\\pr\\123-fix-thing');
});

test('resolveComponentSpecToDir expands local/tmp workspace specs with owner', () => {
  const rootDir = '/tmp/happier-stack-root';
  const env = { HAPPIER_STACK_WORKSPACE_DIR: '/tmp/workspace', HAPPIER_STACK_OWNER: 'alice' };
  const localDir = resolveComponentSpecToDir({ rootDir, component: 'happier-cli', spec: 'local/branch-a', env });
  const tmpDir = resolveComponentSpecToDir({ rootDir, component: 'happier-cli', spec: 'tmp/branch-b', env });
  assert.equal(localDir, '/tmp/workspace/local/alice/branch-a');
  assert.equal(tmpDir, '/tmp/workspace/tmp/alice/branch-b');
});

test('worktreeSpecFromDir documents native-only filesystem walk for win32 paths on posix', () => {
  if (process.platform === 'win32') {
    return;
  }
  const rootDir = '/tmp/happier-stack-root';
  const env = { HAPPIER_STACK_WORKSPACE_DIR: 'C:\\happier\\workspace' };
  const spec = worktreeSpecFromDir({
    rootDir,
    component: 'happier-cli',
    dir: 'C:\\happier\\workspace\\pr\\123-fix-thing\\apps\\cli',
    env,
  });
  assert.equal(spec, null);
});
