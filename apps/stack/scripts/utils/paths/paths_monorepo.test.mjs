import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { getComponentDir, getComponentRepoDir, getRepoDir } from './paths.mjs';

async function writeHappyMonorepoStub({ rootDir }) {
  const monoRoot = join(rootDir, 'main');
  await ensureMinimalMonorepoLayout(monoRoot);
  return monoRoot;
}

async function writeHappyMonorepoStubAt({ monoRoot }) {
  await ensureMinimalMonorepoLayout(monoRoot);
  return monoRoot;
}

test('getComponentDir derives monorepo component package dirs from workspace/main', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-paths-monorepo-' });
  const rootDir = fixture.root;
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });
  assert.equal(getComponentDir(rootDir, 'happier-ui', env), join(monoRoot, 'apps', 'ui'));
  assert.equal(getComponentDir(rootDir, 'happier-cli', env), join(monoRoot, 'apps', 'cli'));
  assert.equal(getComponentDir(rootDir, 'happier-server', env), join(monoRoot, 'apps', 'server'));
  assert.equal(getComponentDir(rootDir, 'happier-server-light', env), join(monoRoot, 'apps', 'server'));
});

test('getComponentRepoDir returns the shared monorepo root for monorepo components', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-paths-monorepo-' });
  const rootDir = fixture.root;
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });
  assert.equal(getComponentRepoDir(rootDir, 'happier-ui', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happier-cli', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happier-server', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happier-server-light', env), monoRoot);
});

test('getComponentDir normalizes HAPPIER_STACK_REPO_DIR that points inside the monorepo', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-paths-monorepo-' });
  const rootDir = fixture.root;
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });

  env.HAPPIER_STACK_REPO_DIR = join(monoRoot, 'apps', 'cli', 'src');
  assert.equal(getComponentDir(rootDir, 'happier-cli', env), join(monoRoot, 'apps', 'cli'));
});

test('getRepoDir falls back to the monorepo containing the CLI root when HAPPIER_STACK_REPO_DIR is unset', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-paths-monorepo-' });
  const tmpRoot = fixture.root;

  const workspaceDir = join(tmpRoot, 'workspace');
  const monoRoot = join(tmpRoot, 'happier');
  await writeHappyMonorepoStubAt({ monoRoot });

  // Simulate running hstack from an activated local clone:
  // rootDir is inside the monorepo, but there is no workspace/main checkout.
  const rootDir = join(monoRoot, 'apps', 'stack');
  const env = { HAPPIER_STACK_WORKSPACE_DIR: workspaceDir };

  assert.equal(getRepoDir(rootDir, env), monoRoot);
});

test('getRepoDir ignores the monorepo containing the CLI root in sandbox mode', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-paths-monorepo-' });
  const tmpRoot = fixture.root;

  const workspaceDir = join(tmpRoot, 'workspace');
  const monoRoot = join(tmpRoot, 'happier');
  await writeHappyMonorepoStubAt({ monoRoot });

  // Sandbox runs must be isolated: no implicit repo-local checkouts.
  const rootDir = join(monoRoot, 'apps', 'stack');
  const env = {
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_SANDBOX_DIR: join(tmpRoot, 'sandbox'),
  };

  assert.equal(getRepoDir(rootDir, env), join(workspaceDir, 'main'));
});
