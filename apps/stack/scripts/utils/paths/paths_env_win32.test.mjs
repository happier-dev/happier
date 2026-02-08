import test from 'node:test';
import assert from 'node:assert/strict';

import { getRepoDir, isWin32ShapedAbsolutePath } from './paths.mjs';

test('getRepoDir treats win32 absolute paths as absolute (does not resolve under workspace)', () => {
  const rootDir = '/tmp/happier-stack-root';
  const env = {
    HAPPIER_STACK_WORKSPACE_DIR: '/tmp/happier-stack-workspace',
    HAPPIER_STACK_REPO_DIR: 'C:\\happier\\workspace\\main',
  };
  assert.equal(getRepoDir(rootDir, env), 'C:\\happier\\workspace\\main');
});

test('isWin32ShapedAbsolutePath recognizes win32 absolute forms and rejects relative paths', () => {
  assert.equal(isWin32ShapedAbsolutePath('C:\\foo\\bar'), true);
  assert.equal(isWin32ShapedAbsolutePath('C:/foo/bar'), true);
  assert.equal(isWin32ShapedAbsolutePath('\\\\server\\share\\path'), true);
  assert.equal(isWin32ShapedAbsolutePath('\\\\?\\C:\\foo\\bar'), true);
  assert.equal(isWin32ShapedAbsolutePath('\\foo\\bar'), true);

  assert.equal(isWin32ShapedAbsolutePath('foo/bar'), false);
  assert.equal(isWin32ShapedAbsolutePath('./x'), false);
  assert.equal(isWin32ShapedAbsolutePath('~/x'), false);
  assert.equal(isWin32ShapedAbsolutePath('/tmp/x'), false);
  assert.equal(isWin32ShapedAbsolutePath('   '), false);
});

test('getRepoDir treats current-drive rooted win32 paths as absolute', () => {
  const rootDir = '/tmp/happier-stack-root';
  const env = {
    HAPPIER_STACK_WORKSPACE_DIR: '/tmp/happier-stack-workspace',
    HAPPIER_STACK_REPO_DIR: '\\happier\\workspace\\main',
  };
  assert.equal(getRepoDir(rootDir, env), '\\happier\\workspace\\main');
});
