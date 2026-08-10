import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { resolveRemoteReleasePlanningRefs } from '../pipeline/release/lib/release-planning-remote-refs.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function snapshotRefs(cwd) {
  return git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
}

test('remote release planning checks advertised commits in one batch per availability pass', () => {
  if (process.platform === 'win32') return;

  const root = mkdtempSync(join(tmpdir(), 'release-planning-batch-check-'));
  const shimPath = join(root, 'git');
  const logPath = join(root, 'git-calls.jsonl');
  const previousPath = process.env.PATH;
  const previousLog = process.env.GIT_SHIM_LOG;
  const mainObject = 'a'.repeat(40);
  const previewObject = 'b'.repeat(40);

  try {
    writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.GIT_SHIM_LOG, JSON.stringify({ args, input }) + '\\n');
if (args[0] === 'ls-remote') {
  process.stdout.write('${mainObject}\\trefs/heads/main\\n${previewObject}\\trefs/heads/preview\\n');
  process.exit(0);
}
if (args[0] === 'cat-file' && String(args[1] || '').startsWith('--batch-check=')) {
  for (const row of input.trim().split(/\\r?\\n/).filter(Boolean)) {
    process.stdout.write(row.replace(/\\^\\{commit\\}$/, '') + ' commit\\n');
  }
  process.exit(0);
}
process.exit(97);
`);
    chmodSync(shimPath, 0o755);
    process.env.PATH = `${root}${delimiter}${previousPath ?? ''}`;
    process.env.GIT_SHIM_LOG = logPath;

    assert.deepEqual(resolveRemoteReleasePlanningRefs({
      repoRoot: root,
      branchNames: ['main', 'preview'],
      tagPrefixes: [],
    }), {
      branches: { main: mainObject, preview: previewObject },
      tags: {},
    });

    const calls = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const batchCalls = calls.filter((call) => call.args[0] === 'cat-file');
    assert.equal(batchCalls.length, 2, 'availability is checked once before and once after any fetch');
    for (const call of batchCalls) {
      assert.match(call.args[1], /^--batch-check=/);
      assert.deepEqual(call.input.trim().split(/\r?\n/), [
        `${mainObject}^{commit}`,
        `${previewObject}^{commit}`,
      ]);
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.GIT_SHIM_LOG;
    else process.env.GIT_SHIM_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote release planning resolves and fetches immutable objects without changing local refs', () => {
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
    git(seed, ['checkout', '-b', 'dev']);
    writeFileSync(join(seed, 'README.md'), 'dev\n');
    git(seed, ['commit', '-am', 'dev']);
    git(seed, ['checkout', '-b', 'preview']);
    writeFileSync(join(seed, 'README.md'), 'preview\n');
    git(seed, ['commit', '-am', 'preview']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', 'origin', 'main', 'dev', 'preview', 'refs/tags/cli-v0.2.1']);

    git(root, ['clone', '--no-tags', '--single-branch', '--branch', 'dev', remote, work]);
    const before = snapshotRefs(work);

    const resolved = resolveRemoteReleasePlanningRefs({
      repoRoot: work,
      branchNames: ['main', 'dev', 'preview'],
      tagPrefixes: ['cli-v'],
    });

    assert.equal(resolved.branches.main, git(seed, ['rev-parse', 'main']));
    assert.equal(resolved.branches.dev, git(seed, ['rev-parse', 'dev']));
    assert.equal(resolved.branches.preview, git(seed, ['rev-parse', 'preview']));
    assert.equal(resolved.tags['cli-v0.2.1'], git(seed, ['rev-parse', 'cli-v0.2.1^{}']));
    assert.equal(git(work, ['cat-file', '-t', `${resolved.branches.preview}^{commit}`]), 'commit');
    assert.equal(git(work, ['cat-file', '-t', `${resolved.tags['cli-v0.2.1']}^{commit}`]), 'commit');
    assert.equal(snapshotRefs(work), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public deploy-plan command resolves current remote objects without changing heads, remotes, or tags', () => {
  const sourceRepo = resolve(new URL('../..', import.meta.url).pathname);
  const root = mkdtempSync(join(tmpdir(), 'release-deploy-plan-refs-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const work = join(root, 'work');

  try {
    git(root, ['init', '--bare', remote]);
    git(root, ['init', seed]);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test']);
    writeFileSync(join(seed, 'README.md'), 'initial\n');
    git(seed, ['add', 'README.md']);
    git(seed, ['commit', '-m', 'initial']);
    git(seed, ['branch', '-M', 'dev']);
    for (const branch of ['main', 'preview', 'deploy/preview/server', 'stale']) {
      git(seed, ['branch', branch]);
    }
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', 'origin', 'dev', 'main', 'preview', 'deploy/preview/server', 'stale']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/dev']);

    git(root, ['clone', '--no-tags', remote, work]);
    mkdirSync(join(work, 'scripts'), { recursive: true });
    cpSync(join(sourceRepo, 'scripts', 'pipeline'), join(work, 'scripts', 'pipeline'), { recursive: true });
    mkdirSync(join(work, 'packages', 'release-runtime'), { recursive: true });
    cpSync(
      join(sourceRepo, 'packages', 'release-runtime', 'releaseRings.cjs'),
      join(work, 'packages', 'release-runtime', 'releaseRings.cjs'),
    );
    mkdirSync(join(work, 'apps', 'ui'), { recursive: true });
    cpSync(join(sourceRepo, 'apps', 'ui', 'appVariantConfig.cjs'), join(work, 'apps', 'ui', 'appVariantConfig.cjs'));
    symlinkSync(join(sourceRepo, 'node_modules'), join(work, 'node_modules'), 'dir');
    git(work, ['tag', 'keep-local']);

    git(seed, ['checkout', 'preview']);
    writeFileSync(join(seed, 'README.md'), 'advanced preview\n');
    git(seed, ['commit', '-am', 'advance preview']);
    git(seed, ['push', 'origin', 'preview']);
    git(seed, ['push', 'origin', '--delete', 'stale']);

    const advertisedPreview = git(seed, ['rev-parse', 'preview']);
    const before = snapshotRefs(work);
    const output = execFileSync(process.execPath, [
      join(work, 'scripts', 'pipeline', 'run.mjs'),
      'release-compute-deploy-plan',
      '--deploy-environment', 'preview',
      '--source-ref', 'preview',
      '--force-deploy', 'false',
      '--deploy-ui', 'false',
      '--deploy-server', 'true',
      '--deploy-website', 'false',
      '--deploy-docs', 'false',
      '--secrets-source', 'env',
    ], {
      cwd: work,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());

    assert.equal(result.source_sha, advertisedPreview);
    assert.equal(snapshotRefs(work), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
