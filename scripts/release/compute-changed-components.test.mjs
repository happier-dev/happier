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

test('compute-changed-components marks changed_ui when an app dependency package changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-changed-app-dependency-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await mkdir(join(dir, 'packages', 'cli-common'), { recursive: true });
  await writeFile(join(dir, 'packages', 'cli-common', 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);

  await writeFile(join(dir, 'packages', 'cli-common', 'README.md'), 'changed\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-changed-components.mjs');
  const res = run(dir, process.execPath, [script, '--base', base, '--head', head]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_ui, 'true');
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.commit_count, '1');
});

test('compute-changed-components unions changes and commits across --bases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-changed-bases-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await mkdir(join(dir, 'apps', 'cli'), { recursive: true });
  await mkdir(join(dir, 'apps', 'stack'), { recursive: true });
  await writeFile(join(dir, 'apps', 'cli', 'README.md'), 'base\n', 'utf8');
  await writeFile(join(dir, 'apps', 'stack', 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'main base']);
  const mainBase = git(dir, ['rev-parse', 'HEAD']);

  await writeFile(join(dir, 'apps', 'stack', 'README.md'), 'preview\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'preview base']);
  const previewBase = git(dir, ['rev-parse', 'HEAD']);

  await writeFile(join(dir, 'apps', 'cli', 'README.md'), 'head\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-changed-components.mjs');
  const res = run(dir, process.execPath, [script, '--bases', `${previewBase},${mainBase}`, '--head', head]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(String(res.stdout).trim());
  // Union: the stack change is only visible from the main base, the cli change from both.
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.changed_stack, 'true');
  assert.equal(parsed.commit_count, '2');

  const both = run(dir, process.execPath, [script, '--base', mainBase, '--bases', previewBase, '--head', head]);
  assert.notEqual(both.status, 0);
});

test('compute-changed-components treats channel bases at the same commit as one base', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-changed-samebase-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await mkdir(join(dir, 'apps', 'cli'), { recursive: true });
  await writeFile(join(dir, 'apps', 'cli', 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  await writeFile(join(dir, 'apps', 'cli', 'README.md'), 'head\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-changed-components.mjs');
  // preview and main both at `base` (e.g. right after a production promotion).
  const res = run(dir, process.execPath, [script, '--bases', `${base},${base}`, '--head', head]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.commit_count, '1');
});
