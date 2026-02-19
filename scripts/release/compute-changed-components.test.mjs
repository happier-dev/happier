import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function run(cwd, cmd, args) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.error) throw res.error;
  return res;
}

function git(cwd, args) {
  const res = run(cwd, 'git', args);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return String(res.stdout || '').trim();
}

test('compute-changed-components emits changed flags and commit_count for a git range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-changed-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await mkdir(join(dir, 'apps', 'cli'), { recursive: true });
  await writeFile(join(dir, 'apps', 'cli', 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);

  await writeFile(join(dir, 'apps', 'cli', 'README.md'), 'changed\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-changed-components.mjs');
  const res = run(dir, process.execPath, [script, '--base', base, '--head', head]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.commit_count, '1');
});
