import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ensureStagedGitRepo } from '../../../scripts/pipeline/git/ensure-staged-git-repo.mjs';

function hasHeadCommit(repoDir) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoDir, stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function readLocalGitConfigValue(repoDir, key) {
  try {
    const out = execFileSync('git', ['config', '--local', '--get', key], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const v = String(out ?? '').trim();
    return v || null;
  } catch {
    return null;
  }
}

test('ensureStagedGitRepo initializes git repo and creates an empty commit', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-staged-repo-'));
  try {
    ensureStagedGitRepo({ repoDir, env: process.env, dryRun: false });
    assert.ok(fs.existsSync(path.join(repoDir, '.git')));
    assert.ok(hasHeadCommit(repoDir));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('ensureStagedGitRepo creates a commit when .git exists but HEAD is missing', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-staged-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore', timeout: 60_000 });
    assert.equal(hasHeadCommit(repoDir), false);
    ensureStagedGitRepo({ repoDir, env: process.env, dryRun: false });
    assert.ok(hasHeadCommit(repoDir));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('ensureStagedGitRepo does not rewrite repo-local git identity when HEAD already exists', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-staged-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore', timeout: 60_000 });
    execFileSync('git', ['config', 'user.email', 'alice@example.com'], { cwd: repoDir, stdio: 'ignore', timeout: 10_000 });
    execFileSync('git', ['config', 'user.name', 'Alice'], { cwd: repoDir, stdio: 'ignore', timeout: 10_000 });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '--no-gpg-sign', '--no-verify'], {
      cwd: repoDir,
      stdio: 'ignore',
      timeout: 60_000,
    });

    assert.equal(readLocalGitConfigValue(repoDir, 'user.email'), 'alice@example.com');
    assert.equal(readLocalGitConfigValue(repoDir, 'user.name'), 'Alice');

    ensureStagedGitRepo({ repoDir, env: process.env, dryRun: false });

    assert.equal(readLocalGitConfigValue(repoDir, 'user.email'), 'alice@example.com');
    assert.equal(readLocalGitConfigValue(repoDir, 'user.name'), 'Alice');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('ensureStagedGitRepo does not persist identity config when creating an initial commit', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-staged-repo-'));
  try {
    ensureStagedGitRepo({ repoDir, env: process.env, dryRun: false });
    assert.ok(hasHeadCommit(repoDir));

    assert.equal(readLocalGitConfigValue(repoDir, 'user.email'), null);
    assert.equal(readLocalGitConfigValue(repoDir, 'user.name'), null);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('ensureStagedGitRepo is a no-op on dryRun', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-staged-repo-'));
  try {
    ensureStagedGitRepo({ repoDir, env: process.env, dryRun: true });
    assert.equal(fs.existsSync(path.join(repoDir, '.git')), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
