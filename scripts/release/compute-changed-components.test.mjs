import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

for (const [changedPath, changedComponent] of [
  ['apps/cli/README.md', 'cli'],
  ['deploy/iroh-relay/Dockerfile', 'iroh_relay'],
  ['deploy/sqlite-helper/Dockerfile', 'sqlite_helper'],
]) {
test(`compute-changed-components emits exact ${changedComponent} flags and commit_count for a git range`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-changed-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await mkdir(dirname(join(dir, changedPath)), { recursive: true });
  await writeFile(join(dir, changedPath), 'base\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);

  await writeFile(join(dir, changedPath), 'changed\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-changed-components.mjs');
  const res = run(dir, process.execPath, [script, '--base', base, '--head', head]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed[`changed_${changedComponent}`], 'true');
  assert.equal(parsed.changed_cli, String(changedComponent === 'cli'));
  assert.equal(parsed.changed_sqlite_helper, String(changedComponent === 'sqlite_helper'));
  assert.equal(parsed.changed_iroh_relay, String(changedComponent === 'iroh_relay'));
  assert.equal(parsed.changed_server, 'false');
  assert.equal(parsed.commit_count, '1');
});
}

test('compute-changed-components exposes cli-common changes as cli/stack shared release inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-shared-'));

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
  assert.equal(parsed.changed_cli_stack_shared, 'true');
  assert.equal(parsed.changed_shared, 'false');
  assert.equal(parsed.changed_ui, 'true');
  assert.equal(parsed.changed_cli, 'false');
  assert.equal(parsed.changed_stack, 'false');
});

test('compute-changed-components treats plugin SDK changes as UI and plugin-pair release inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-ui-dependency-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await mkdir(join(dir, 'packages', 'plugin-sdk'), { recursive: true });
  await writeFile(join(dir, 'packages', 'plugin-sdk', 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  await writeFile(join(dir, 'packages', 'plugin-sdk', 'README.md'), 'changed\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-changed-components.mjs');
  const res = run(dir, process.execPath, [script, '--base', base, '--head', head]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const output = JSON.parse(String(res.stdout).trim());
  assert.equal(output.changed_ui, 'true');
  assert.equal(output.changed_plugin_sdk, 'true');
  assert.equal(output.changed_sdk, 'false');
  assert.equal(output.risk_plugin_sdk_package_changed, 'true');
  assert.equal(output.risk_plugin_runtime_compatibility, 'false');
});

test('compute-changed-components unions paths across multiple release bases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-compute-changed-multiple-bases-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await writeFile(join(dir, 'README.md'), 'shared head\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'shared head']);
  const head = git(dir, ['rev-parse', 'HEAD']);

  git(dir, ['checkout', '-b', 'preview-base']);
  await mkdir(join(dir, 'apps', 'cli'), { recursive: true });
  await writeFile(join(dir, 'apps', 'cli', 'README.md'), 'preview-only\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'preview base']);
  const previewBase = git(dir, ['rev-parse', 'HEAD']);

  git(dir, ['checkout', '-b', 'production-base', head]);
  await mkdir(join(dir, 'apps', 'server'), { recursive: true });
  await writeFile(join(dir, 'apps', 'server', 'README.md'), 'production-only\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'production base']);
  const productionBase = git(dir, ['rev-parse', 'HEAD']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-changed-components.mjs');
  const res = run(dir, process.execPath, [script, '--bases', `${previewBase},${productionBase}`, '--head', head]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.changed_server, 'true');
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
