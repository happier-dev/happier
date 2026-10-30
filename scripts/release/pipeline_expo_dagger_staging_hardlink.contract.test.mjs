import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stageRepoForDagger } from '../pipeline/expo/stage-repo-for-dagger.mjs';

test('stageRepoForDagger uses hardlinks for regular files when possible', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-stage-repo-root-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const src = path.join(repoRoot, 'apps', 'ui', 'package.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '{"name":"ui"}\n', 'utf8');

  // Probe the real filesystem independently, so a copy-only staging regression cannot pass.
  const probe = path.join(repoRoot, 'hardlink-probe');
  let supportsHardlinks = true;
  try {
    fs.linkSync(src, probe);
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
    supportsHardlinks = false;
  }

  const { stagedRepoDir, cleanup } = stageRepoForDagger({
    repoRoot,
    files: ['apps/ui/package.json'],
  });
  t.after(cleanup);

  const dest = path.join(stagedRepoDir, 'apps', 'ui', 'package.json');
  assert.ok(fs.existsSync(dest));

  const srcStat = fs.statSync(src);
  const destStat = fs.statSync(dest);

  if (supportsHardlinks) {
    assert.equal(destStat.ino, srcStat.ino);
    assert.equal(destStat.dev, srcStat.dev);
    assert.ok(destStat.nlink >= 2);
  }
  assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(src, 'utf8'));
});

