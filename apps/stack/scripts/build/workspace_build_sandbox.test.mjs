import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createWorkspaceBuildSandbox } from './workspace_build_sandbox.mjs';

test('createWorkspaceBuildSandbox exposes the source node_modules to staged workspaces', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'workspace-build-sandbox-test-'));
  const packageDir = join(repoRoot, 'apps', 'server');
  const agentsDir = join(repoRoot, 'packages', 'agents');
  const nodeModulesDir = join(repoRoot, 'node_modules');

  await mkdir(packageDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(nodeModulesDir, { recursive: true });
  await writeFile(join(repoRoot, 'package.json'), '{}');
  await writeFile(join(repoRoot, 'yarn.lock'), '');
  await writeFile(join(packageDir, 'package.json'), '{}');
  await writeFile(join(agentsDir, 'package.json'), '{}');
  await writeFile(join(nodeModulesDir, 'sentinel.txt'), 'reachable');

  const sandbox = await createWorkspaceBuildSandbox({
    packageDir,
    extraRelativePaths: ['packages/agents'],
  });

  try {
    const sandboxNodeModulesLink = join(sandbox.sandboxRoot, 'node_modules');
    const target = await readlink(sandboxNodeModulesLink);
    assert.equal(target, nodeModulesDir);
  } finally {
    await sandbox.cleanup();
    await rm(repoRoot, { recursive: true, force: true });
  }
});
