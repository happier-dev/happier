import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { resolveRuntimeBuildAuthority } from './runtime_build_authority.mjs';

test('runtime builds for different consumers share the repository stack authority', () => {
  const env = {
    HAPPIER_STACK_STORAGE_DIR: '/tmp/happier-stacks',
    HAPPIER_STACK_REPO_DIR: '/work/happier',
  };
  const resolveRepoStackIdentityImpl = ({ repoRoot, stacksStorageRoot }) => ({
    stackName: 'repo-happier-authority1',
    stackBaseDir: join(stacksStorageRoot, 'repo-happier-authority1'),
    repoRoot,
  });

  const first = resolveRuntimeBuildAuthority({
    rootDir: '/tool',
    consumerStackName: 'qa-one',
    env,
    resolveRepoStackIdentityImpl,
  });
  const second = resolveRuntimeBuildAuthority({
    rootDir: '/tool',
    consumerStackName: 'qa-two',
    env,
    resolveRepoStackIdentityImpl,
  });

  assert.equal(first.producerStackName, 'repo-happier-authority1');
  assert.equal(second.producerStackName, first.producerStackName);
  assert.equal(second.producerStackBaseDir, first.producerStackBaseDir);
  assert.equal(first.consumerStackBaseDir, '/tmp/happier-stacks/qa-one');
  assert.equal(second.consumerStackBaseDir, '/tmp/happier-stacks/qa-two');
});

test('runtime build authority supports one explicit managed-stack override', () => {
  const env = {
    HAPPIER_STACK_STORAGE_DIR: '/tmp/happier-stacks',
    HAPPIER_STACK_REPO_DIR: '/work/happier',
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'build-owner',
  };

  const authority = resolveRuntimeBuildAuthority({
    rootDir: '/tool',
    consumerStackName: 'qa-one',
    env,
    resolveRepoStackIdentityImpl: () => {
      throw new Error('explicit authority must not require repository identity creation');
    },
  });

  assert.equal(authority.producerStackName, 'build-owner');
  assert.equal(authority.producerStackBaseDir, '/tmp/happier-stacks/build-owner');
});

test('runtime build authority rejects non-canonical managed stack names', () => {
  assert.throws(
    () => resolveRuntimeBuildAuthority({
      rootDir: '/repo',
      consumerStackName: '../consumer',
      env: { HAPPIER_STACK_STORAGE_DIR: '/stacks' },
      resolveRepoStackIdentityImpl: () => ({ stackName: 'repo-happier', stackBaseDir: '/stacks/repo-happier' }),
    }),
    /invalid consumer stack name/i,
  );
  assert.throws(
    () => resolveRuntimeBuildAuthority({
      rootDir: '/repo',
      consumerStackName: 'qa-agent',
      env: {
        HAPPIER_STACK_STORAGE_DIR: '/stacks',
        HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: '../producer',
      },
      resolveRepoStackIdentityImpl: () => ({ stackName: 'repo-happier', stackBaseDir: '/stacks/repo-happier' }),
    }),
    /invalid producer stack name/i,
  );
});
