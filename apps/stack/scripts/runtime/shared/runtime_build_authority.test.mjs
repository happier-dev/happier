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

test('a repository identity stack stays its own authority when the inherited repo dir names another checkout', () => {
  // 2026-11-18 08:50:39Z: a 0.3 command run with the 0.2 Stack's inherited
  // HAPPIER_STACK_REPO_DIR treated repo-dev (0.3) as a consumer of the 0.2
  // registry and overwrote its dev-targets.json with the 0.2 host list.
  const env = {
    HAPPIER_STACK_STORAGE_DIR: '/tmp/happier-stacks',
    HAPPIER_STACK_REPO_DIR: '/work/other-checkout',
  };
  const authority = resolveRuntimeBuildAuthority({
    rootDir: '/tool',
    consumerStackName: 'repo-dev-a1cc5e0671',
    env,
    resolveRepoStackIdentityImpl: ({ stacksStorageRoot }) => ({
      stackName: 'repo-remote-dev-d72117acdb',
      stackBaseDir: join(stacksStorageRoot, 'repo-remote-dev-d72117acdb'),
    }),
  });

  assert.equal(authority.producerStackName, 'repo-dev-a1cc5e0671');
  assert.equal(authority.producerStackBaseDir, '/tmp/happier-stacks/repo-dev-a1cc5e0671');
  assert.equal(authority.consumerStackBaseDir, authority.producerStackBaseDir);
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
