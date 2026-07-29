import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRemoteReleasePlanningRefs } from '../pipeline/release/lib/release-planning-remote-refs.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function refs(cwd) {
  return git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
}

test('remote planning fetches immutable objects without updating user-owned refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-planning-refs-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const work = join(root, 'work');
  try {
    git(root, ['init', '--bare', remote]);
    git(root, ['init', seed]);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test']);
    writeFileSync(join(seed, 'README.md'), 'main\n');
    git(seed, ['add', 'README.md']);
    git(seed, ['commit', '-m', 'main']);
    git(seed, ['branch', '-M', 'main']);
    git(seed, ['tag', '-a', 'cli-v0.2.1', '-m', 'cli']);
    for (const branch of ['dev', 'preview']) {
      git(seed, ['checkout', '-b', branch]);
      writeFileSync(join(seed, 'README.md'), `${branch}\n`);
      git(seed, ['commit', '-am', branch]);
    }
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', 'origin', 'main', 'dev', 'preview', 'refs/tags/cli-v0.2.1']);
    git(root, ['clone', '--no-tags', '--single-branch', '--branch', 'dev', remote, work]);
    const before = refs(work);
    const resolved = resolveRemoteReleasePlanningRefs({
      repoRoot: work,
      branchNames: ['main', 'dev', 'preview'],
      optionalBranchNames: ['deploy/preview/server'],
      tagPrefixes: ['cli-v'],
    });
    assert.equal(resolved.branches.main, git(seed, ['rev-parse', 'main']));
    assert.equal(resolved.branches['deploy/preview/server'], undefined);
    assert.equal(resolved.tags['cli-v0.2.1'], git(seed, ['rev-parse', 'cli-v0.2.1^{}']));
    assert.equal(refs(work), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
