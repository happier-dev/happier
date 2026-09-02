import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

test('compute-versioned-component-changes accepts remote tag identities without creating local tag refs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-versioned-components-'));

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await writeRepoFile(dir, 'apps/cli/README.md', 'base cli\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'stable base']);
  const baselineSha = git(dir, ['rev-parse', 'HEAD']);
  await writeRepoFile(dir, 'apps/cli/README.md', 'changed cli\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'changed']);

  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'compute-versioned-component-changes.mjs');
  const res = run(dir, process.execPath, [
    script,
    '--environment', 'production',
    '--head', 'HEAD',
    '--tag-refs-json', JSON.stringify({ 'cli-v0.1.0': baselineSha }),
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed.changed_cli, 'true');
  assert.equal(parsed.cli_baseline_tag, 'cli-v0.1.0');
  assert.equal(git(dir, ['for-each-ref', '--format=%(refname)', 'refs/tags']), '');
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
