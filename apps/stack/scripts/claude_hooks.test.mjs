import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptsDir);
const repoRoot = resolve(packageRoot, '../..');

function runHook(scriptPath, command, env = {}) {
  return spawnSync('bash', [scriptPath], {
    input: JSON.stringify({ tool: 'Bash', args: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('Claude destructive-git guard blocks destructive git commands', () => {
  const scriptPath = join(repoRoot, '.claude/hooks/prevent-destructive-git.sh');
  const result = runHook(scriptPath, 'git reset --hard HEAD');

  assert.equal(result.status, 1);
  assert.match(result.stdout, /destructive git command/i);
  assert.match(result.stdout, /git reset/);
});

test('Claude destructive-git guard blocks branch checkout commands', () => {
  const scriptPath = join(repoRoot, '.claude/hooks/prevent-destructive-git.sh');
  const result = runHook(scriptPath, 'git checkout main');

  assert.equal(result.status, 1);
  assert.match(result.stdout, /git checkout/);
});

test('Claude destructive-git guard allows safe git inspection commands', () => {
  const scriptPath = join(repoRoot, '.claude/hooks/prevent-destructive-git.sh');
  const result = runHook(scriptPath, 'git status --porcelain');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('Claude destructive-git guard honors explicit override env', () => {
  const scriptPath = join(repoRoot, '.claude/hooks/prevent-destructive-git.sh');
  const result = runHook(scriptPath, 'git clean -xfd', { ALLOW_DESTRUCTIVE_GIT: '1' });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
