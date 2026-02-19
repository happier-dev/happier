import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stageRepoForDagger } from '../pipeline/expo/stage-repo-for-dagger.mjs';

test('stageRepoForDagger uses hardlinks for regular files when possible', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-stage-repo-root-'));
  const src = path.join(repoRoot, 'apps', 'ui', 'package.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '{"name":"ui"}\n', 'utf8');

  const { stagedRepoDir, cleanup } = stageRepoForDagger({
    repoRoot,
    files: ['apps/ui/package.json'],
  });

  const dest = path.join(stagedRepoDir, 'apps', 'ui', 'package.json');
  assert.ok(fs.existsSync(dest));

  const srcStat = fs.statSync(src);
  const destStat = fs.statSync(dest);

  // On most unix filesystems, hardlinked files share the same inode + device.
  // If the filesystem doesn't support hardlinks, the staging helper falls back to copy.
  const likelyHardlinked = srcStat.ino === destStat.ino && srcStat.dev === destStat.dev && destStat.nlink >= 2;
  if (!likelyHardlinked) {
    assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(src, 'utf8'));
  }

  cleanup();
});

