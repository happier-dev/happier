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

async function writeRepoFile(dir, relativePath, contents) {
  const filePath = join(dir, relativePath);
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

test('compute-versioned-component-changes keeps shared changes scoped to each component baseline tag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-versioned-components-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await writeRepoFile(dir, 'apps/cli/README.md', 'base cli\n');
  await writeRepoFile(dir, 'apps/stack/README.md', 'base stack\n');
  await writeRepoFile(dir, 'packages/agents/README.md', 'base shared\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  git(dir, ['tag', 'cli-v0.1.0-dev.1.1']);
  git(dir, ['tag', 'stack-v0.1.0-dev.1.1']);

  await writeRepoFile(dir, 'packages/agents/README.md', 'shared changed\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'shared change']);
  git(dir, ['tag', 'stack-v0.1.1-dev.2.1']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-versioned-component-changes.mjs');
  const res = run(dir, process.execPath, [script, '--environment', 'dev', '--head', 'HEAD']);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.changed_stack, 'false');
  assert.equal(parsed.cli_baseline_tag, 'cli-v0.1.0-dev.1.1');
  assert.equal(parsed.stack_baseline_tag, 'stack-v0.1.1-dev.2.1');
});

test('compute-versioned-component-changes uses stable baselines for production and preview baselines for preview', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-versioned-components-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await writeRepoFile(dir, 'apps/cli/README.md', 'base cli\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'stable base']);
  git(dir, ['tag', 'cli-v0.1.0']);

  await writeRepoFile(dir, 'apps/cli/README.md', 'preview cli\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'preview release']);
  git(dir, ['tag', 'cli-v0.1.1-preview.5.1']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-versioned-component-changes.mjs');

  const previewRes = run(dir, process.execPath, [script, '--environment', 'preview', '--head', 'HEAD']);
  assert.equal(previewRes.status, 0, previewRes.stderr || previewRes.stdout);
  const previewParsed = JSON.parse(String(previewRes.stdout).trim());
  assert.equal(previewParsed.changed_cli, 'false');
  assert.equal(previewParsed.cli_baseline_tag, 'cli-v0.1.1-preview.5.1');

  const productionRes = run(dir, process.execPath, [script, '--environment', 'production', '--head', 'HEAD']);
  assert.equal(productionRes.status, 0, productionRes.stderr || productionRes.stdout);
  const productionParsed = JSON.parse(String(productionRes.stdout).trim());
  assert.equal(productionParsed.changed_cli, 'true');
  assert.equal(productionParsed.cli_baseline_tag, 'cli-v0.1.0');
});

test('compute-versioned-component-changes treats cli-common changes as versioned app, cli, stack, and server changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-versioned-cli-common-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await writeRepoFile(dir, 'apps/cli/README.md', 'base cli\n');
  await writeRepoFile(dir, 'apps/stack/README.md', 'base stack\n');
  await writeRepoFile(dir, 'packages/cli-common/README.md', 'base shared\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  git(dir, ['tag', 'cli-v0.1.0']);
  git(dir, ['tag', 'stack-v0.1.0']);

  await writeRepoFile(dir, 'packages/cli-common/README.md', 'shared runtime fix\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'cli-common change']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-versioned-component-changes.mjs');
  const res = run(dir, process.execPath, [script, '--environment', 'production', '--head', 'HEAD']);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.changed_stack, 'true');
  assert.equal(parsed.changed_app, 'true');
  assert.equal(parsed.changed_server, 'true');
});
