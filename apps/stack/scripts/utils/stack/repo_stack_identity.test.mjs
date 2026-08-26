import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveRepoStackIdentity } from './repo_stack_identity.mjs';

test('0.2 repo identity preserves its Git-owned name after moving to the versioned guest path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-0-2-repo-identity-'));
  const repoRoot = join(root, '0.2');
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  await writeFile(join(repoRoot, '.git', 'happier-stack-stackless-id'), 'd72117acdbcd88f3\n');
  await writeFile(join(repoRoot, '.git', 'happier-stack-stackless-base'), 'remote-dev\n');
  try {
    assert.equal(resolveRepoStackIdentity({
      repoRoot,
      stacksStorageRoot: join(root, 'stacks'),
    }).stackName, 'repo-remote-dev-d72117acdb');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
