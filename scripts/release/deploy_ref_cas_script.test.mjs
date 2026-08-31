import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { promoteDeployRef, readRemoteRef } from '../pipeline/github/deploy-ref-cas.mjs';

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Happier Test',
      GIT_AUTHOR_EMAIL: 'test@happier.dev',
      GIT_COMMITTER_NAME: 'Happier Test',
      GIT_COMMITTER_EMAIL: 'test@happier.dev',
      ...env,
    },
  }).trim();
}

function createRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-deploy-ref-cas-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(root, ['init', '--quiet', '--bare', remote]);
  fs.mkdirSync(work);
  git(work, ['init', '--quiet']);
  fs.writeFileSync(path.join(work, 'state.txt'), 'base\n');
  git(work, ['add', 'state.txt']);
  git(work, ['commit', '--quiet', '-m', 'base']);
  const baseSha = git(work, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(work, 'state.txt'), 'candidate\n');
  git(work, ['commit', '--quiet', '-am', 'candidate']);
  const candidateSha = git(work, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(work, 'state.txt'), 'competing\n');
  git(work, ['commit', '--quiet', '-am', 'competing']);
  const competingSha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '--quiet', 'origin', `${baseSha}:refs/heads/deploy/preview/ui`]);
  git(work, ['push', '--quiet', 'origin', `${candidateSha}:refs/heads/candidate`]);
  git(work, ['push', '--quiet', 'origin', `${competingSha}:refs/heads/competing`]);
  return { root, remote, work, baseSha, candidateSha, competingSha };
}

test('deploy-ref CAS promotes an exact remote commit and rejects stale observed state', () => {
  const fixture = createRemote();
  const originalCwd = process.cwd();
  try {
    process.chdir(fixture.work);
    const promoted = promoteDeployRef({
      candidateSha: fixture.candidateSha,
      targetRef: 'refs/heads/deploy/preview/ui',
      remote: 'origin',
      expectedCurrentSha: fixture.baseSha,
    });
    assert.deepEqual(promoted, {
      oldSha: fixture.baseSha,
      newSha: fixture.candidateSha,
      changed: true,
    });
    assert.equal(readRemoteRef('origin', 'refs/heads/deploy/preview/ui'), fixture.candidateSha);

    git(fixture.work, [
      'push', '--quiet', '--force', 'origin',
      `${fixture.competingSha}:refs/heads/deploy/preview/ui`,
    ]);
    assert.throws(
      () => promoteDeployRef({
        candidateSha: fixture.candidateSha,
        targetRef: 'refs/heads/deploy/preview/ui',
        remote: 'origin',
        expectedCurrentSha: fixture.baseSha,
      }),
      /changed concurrently|expected current/i,
    );
    assert.equal(readRemoteRef('origin', 'refs/heads/deploy/preview/ui'), fixture.competingSha);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deploy-ref CAS creates a missing allowed ref with an empty lease', () => {
  const fixture = createRemote();
  const originalCwd = process.cwd();
  try {
    process.chdir(fixture.work);
    const promoted = promoteDeployRef({
      candidateSha: fixture.candidateSha,
      targetRef: 'refs/heads/deploy/production/docs',
      remote: 'origin',
      expectedCurrentSha: null,
    });
    assert.equal(promoted.oldSha, null);
    assert.equal(readRemoteRef('origin', 'refs/heads/deploy/production/docs'), fixture.candidateSha);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deploy-ref CAS verifies an ambiguous failed push instead of retrying the mutation', () => {
  const fixture = createRemote();
  const originalCwd = process.cwd();
  const binDir = path.join(fixture.root, 'bin');
  const callsPath = path.join(fixture.root, 'git-calls.jsonl');
  fs.mkdirSync(binDir);
  const realGit = execFileSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(binDir, 'git'),
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_CALLS_PATH, JSON.stringify(args) + '\\n');
const result = spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' });
if (args.includes('push')) process.exit(1);
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  const originalRealGit = process.env.REAL_GIT;
  const originalCallsPath = process.env.GIT_CALLS_PATH;
  try {
    process.chdir(fixture.work);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.REAL_GIT = realGit;
    process.env.GIT_CALLS_PATH = callsPath;
    const promoted = promoteDeployRef({
      candidateSha: fixture.candidateSha,
      targetRef: 'refs/heads/deploy/preview/ui',
      remote: 'origin',
      expectedCurrentSha: fixture.baseSha,
    });
    assert.equal(promoted.newSha, fixture.candidateSha);
    const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.filter((args) => args.includes('push')).length, 1, 'ambiguous mutation must never be retried');
    assert.ok(calls.filter((args) => args.includes('ls-remote')).length >= 2, 'ambiguous mutation must be observed');
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalRealGit === undefined) delete process.env.REAL_GIT; else process.env.REAL_GIT = originalRealGit;
    if (originalCallsPath === undefined) delete process.env.GIT_CALLS_PATH; else process.env.GIT_CALLS_PATH = originalCallsPath;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deploy-ref CAS rejects refs outside the four deploy components', () => {
  assert.throws(
    () => promoteDeployRef({
      candidateSha: 'a'.repeat(40),
      targetRef: 'refs/heads/main',
      remote: 'origin',
      dryRun: true,
    }),
    /allowed deploy branch ref/i,
  );
});
