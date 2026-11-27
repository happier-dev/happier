import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function run(cwd, cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', ...options });
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

test('plugin baselines emit selected plugin JSON only for changes in that plugin folder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-plugin-component-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  for (const relative of ['scripts/pipeline/release/compute-versioned-component-changes.mjs', 'scripts/pipeline/release/component-registry.mjs', 'scripts/plugins/publishable.mjs']) {
    await mkdir(resolve(dir, relative, '..'), { recursive: true });
    await copyFile(resolve(process.cwd(), relative), resolve(dir, relative));
  }
  await writeRepoFile(dir, 'packages/plugins/asciinema/package.json', JSON.stringify({ name: '@example/fixture-plugin', happier: { bundled: false } }));
  await writeRepoFile(dir, 'packages/plugins/asciinema/index.mjs', 'export {};\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'plugin baseline']);
  git(dir, ['tag', 'plugin-asciinema-v0.3.0-preview.1']);
  await writeRepoFile(dir, 'packages/plugin-sdk/README.md', 'SDK change\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'SDK change']);
  const script = resolve(dir, 'scripts/pipeline/release/compute-versioned-component-changes.mjs');
  const before = run(dir, process.execPath, [script, '--environment', 'preview', '--head', 'HEAD']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).changed_plugins, '[]');
  await writeRepoFile(dir, 'packages/plugins/asciinema/index.mjs', 'export const changed = true;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'plugin change']);
  const after = run(dir, process.execPath, [script, '--environment', 'preview', '--head', 'HEAD']);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).changed_plugins, '["asciinema"]');
});

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

test('compute-versioned-component-changes handles repositories whose tracked path list exceeds the child-process default buffer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-versioned-components-large-index-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  const blob = run(dir, 'git', ['hash-object', '-w', '--stdin'], { input: 'fixture\n' });
  assert.equal(blob.status, 0, blob.stderr || blob.stdout);
  const blobSha = String(blob.stdout).trim();
  const indexEntries = Array.from({ length: 14_000 }, (_, index) => {
    const suffix = String(index).padStart(5, '0');
    return `100644 ${blobSha}\tapps/cli/generated/${suffix}-${'x'.repeat(72)}.txt`;
  }).join('\n');
  const updateIndex = run(dir, 'git', ['update-index', '--index-info'], { input: `${indexEntries}\n` });
  assert.equal(updateIndex.status, 0, updateIndex.stderr || updateIndex.stdout);
  git(dir, ['commit', '-q', '-m', 'large tracked path index']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-versioned-component-changes.mjs');
  const res = run(dir, process.execPath, [script, '--environment', 'production', '--head', 'HEAD']);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_cli, 'true');
});
