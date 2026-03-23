import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../utils/proc/proc.mjs';
import { collectBuildSourceMetadata } from './collect_build_source_metadata.mjs';

async function createTempRepo(t) {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-build-source-meta-'));
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  await run('git', ['init'], { cwd: repoDir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await run('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  await writeFile(join(repoDir, 'tracked.txt'), 'one\n', 'utf8');
  await run('git', ['add', 'tracked.txt'], { cwd: repoDir });
  await run('git', ['commit', '-m', 'init'], { cwd: repoDir });

  return repoDir;
}

test('collectBuildSourceMetadata changes dirtyHash when dirty file contents change without changing the dirty file set', async (t) => {
  const repoDir = await createTempRepo(t);
  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: repoDir,
  };

  await writeFile(join(repoDir, 'tracked.txt'), 'two\n', 'utf8');
  const first = await collectBuildSourceMetadata({ rootDir: repoDir, env });

  await writeFile(join(repoDir, 'tracked.txt'), 'three\n', 'utf8');
  const second = await collectBuildSourceMetadata({ rootDir: repoDir, env });

  assert.notEqual(first.dirtyHash, second.dirtyHash);
  assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);
});
