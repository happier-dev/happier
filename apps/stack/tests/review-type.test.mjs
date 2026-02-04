import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function run(cmd, args, { cwd, env } = {}) {
  const res = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (res.status !== 0) {
    const msg = [
      `[test] command failed: ${cmd} ${args.join(' ')}`,
      res.stdout ? `--- stdout ---\n${res.stdout}` : '',
      res.stderr ? `--- stderr ---\n${res.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(msg);
  }
  return res;
}

async function writeStubBin({ dir, name }) {
  const p = join(dir, name);
  const script = `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
`;
  await writeFile(p, script, 'utf8');
  await chmod(p, 0o755);
  return p;
}

async function initGitRepo({ dir }) {
  run('git', ['init', '-b', 'main'], { cwd: dir });
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  run('git', ['config', 'user.name', 'Test User'], { cwd: dir });

  // Make this repo look like a Happier monorepo so hstack target->component resolution
  // picks real directories inside the git worktree (apps/ui|cli|server).
  await mkdir(join(dir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(dir, 'apps', 'cli'), { recursive: true });
  await mkdir(join(dir, 'apps', 'server'), { recursive: true });
  await writeFile(join(dir, 'apps', 'ui', 'package.json'), '{"name":"ui"}\n', 'utf8');
  await writeFile(join(dir, 'apps', 'cli', 'package.json'), '{"name":"cli"}\n', 'utf8');
  await writeFile(join(dir, 'apps', 'server', 'package.json'), '{"name":"server"}\n', 'utf8');
}

async function seedRepoWithCommittedAndUncommittedChanges({ dir }) {
  await writeFile(join(dir, 'a.txt'), 'base\n', 'utf8');
  run('git', ['add', '.'], { cwd: dir });
  run('git', ['commit', '-m', 'base'], { cwd: dir });
  const baseSha = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

  await writeFile(join(dir, 'a.txt'), 'committed\n', 'utf8');
  run('git', ['add', '.'], { cwd: dir });
  run('git', ['commit', '-m', 'committed change'], { cwd: dir });

  await writeFile(join(dir, 'a.txt'), 'uncommitted\n', 'utf8');
  await writeFile(join(dir, 'new.txt'), 'untracked\n', 'utf8');

  return { baseSha };
}

function runHstack({ repoRoot, args, env }) {
  const hstackBin = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');
  return spawnSync(process.execPath, [hstackBin, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function parseJsonStdout(res) {
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(String(res.stdout ?? '').trim());
}

function findSingleReviewerResult(out, reviewer) {
  const job = out?.results?.[0];
  assert.ok(job, '[test] expected one job result');
  const rr = Array.isArray(job.results) ? job.results.find((r) => r.reviewer === reviewer) : null;
  assert.ok(rr, `[test] missing reviewer result: ${reviewer}`);
  return rr;
}

test('review --type=uncommitted routes codex to --uncommitted in normal depth', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-review-type-'));
  const repoDir = join(tmp, 'repo');
  const binDir = join(tmp, 'bin');
  const homeDir = join(tmp, 'home');
  const label = `test-uncommitted-codex-normal-${Date.now()}`;
  await mkdir(repoDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  await writeStubBin({ dir: binDir, name: 'codex' });
  await writeStubBin({ dir: binDir, name: 'coderabbit' });
  await writeStubBin({ dir: binDir, name: 'auggie' });

  await initGitRepo({ dir: repoDir });
  const { baseSha } = await seedRepoWithCommittedAndUncommittedChanges({ dir: repoDir });

  const testDir = resolve(fileURLToPath(import.meta.url), '..');
  const repoRoot = resolve(testDir, '..', '..', '..');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_UPDATE_CHECK: '0',
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_CODERABBIT_HOME_DIR: join(homeDir, 'coderabbit'),
    HAPPIER_STACK_CODEX_HOME_DIR: join(homeDir, 'codex'),
    HAPPIER_STACK_AUGMENT_CACHE_DIR: join(homeDir, 'augment'),
  };

  const res = runHstack({
    repoRoot,
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=codex',
      '--depth=normal',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'codex');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  assert.ok(args.includes('--uncommitted'));
  assert.ok(!args.includes('--base'));
});

test('review --type=uncommitted uses git diff HEAD in deep prompt mode for codex', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-review-type-'));
  const repoDir = join(tmp, 'repo');
  const binDir = join(tmp, 'bin');
  const homeDir = join(tmp, 'home');
  const label = `test-uncommitted-codex-deep-${Date.now()}`;
  await mkdir(repoDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  await writeStubBin({ dir: binDir, name: 'codex' });
  await writeStubBin({ dir: binDir, name: 'coderabbit' });
  await writeStubBin({ dir: binDir, name: 'auggie' });

  await initGitRepo({ dir: repoDir });
  const { baseSha } = await seedRepoWithCommittedAndUncommittedChanges({ dir: repoDir });

  const testDir = resolve(fileURLToPath(import.meta.url), '..');
  const repoRoot = resolve(testDir, '..', '..', '..');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_UPDATE_CHECK: '0',
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_CODERABBIT_HOME_DIR: join(homeDir, 'coderabbit'),
    HAPPIER_STACK_CODEX_HOME_DIR: join(homeDir, 'codex'),
    HAPPIER_STACK_AUGMENT_CACHE_DIR: join(homeDir, 'augment'),
  };

  const res = runHstack({
    repoRoot,
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=codex',
      '--depth=deep',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'codex');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  assert.ok(!args.includes('--uncommitted'));
  assert.ok(args.some((a) => String(a).includes('git diff HEAD')));
});

test('review --type=uncommitted routes coderabbit to --type uncommitted without base', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-review-type-'));
  const repoDir = join(tmp, 'repo');
  const binDir = join(tmp, 'bin');
  const homeDir = join(tmp, 'home');
  const label = `test-uncommitted-coderabbit-${Date.now()}`;
  await mkdir(repoDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  await writeStubBin({ dir: binDir, name: 'codex' });
  await writeStubBin({ dir: binDir, name: 'coderabbit' });
  await writeStubBin({ dir: binDir, name: 'auggie' });

  await initGitRepo({ dir: repoDir });
  const { baseSha } = await seedRepoWithCommittedAndUncommittedChanges({ dir: repoDir });

  const testDir = resolve(fileURLToPath(import.meta.url), '..');
  const repoRoot = resolve(testDir, '..', '..', '..');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_UPDATE_CHECK: '0',
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_CODERABBIT_HOME_DIR: join(homeDir, 'coderabbit'),
    HAPPIER_STACK_CODEX_HOME_DIR: join(homeDir, 'codex'),
    HAPPIER_STACK_AUGMENT_CACHE_DIR: join(homeDir, 'augment'),
  };

  const res = runHstack({
    repoRoot,
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=coderabbit',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'coderabbit');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  const idx = args.indexOf('--type');
  assert.ok(idx >= 0, '[test] expected coderabbit --type flag');
  assert.equal(args[idx + 1], 'uncommitted');
  assert.ok(!args.includes('--base'));
  assert.ok(!args.includes('--base-commit'));
});

test('review --type=uncommitted uses git diff HEAD in augment prompt', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-review-type-'));
  const repoDir = join(tmp, 'repo');
  const binDir = join(tmp, 'bin');
  const homeDir = join(tmp, 'home');
  const label = `test-uncommitted-augment-${Date.now()}`;
  await mkdir(repoDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  await writeStubBin({ dir: binDir, name: 'codex' });
  await writeStubBin({ dir: binDir, name: 'coderabbit' });
  await writeStubBin({ dir: binDir, name: 'auggie' });

  await initGitRepo({ dir: repoDir });
  const { baseSha } = await seedRepoWithCommittedAndUncommittedChanges({ dir: repoDir });

  const testDir = resolve(fileURLToPath(import.meta.url), '..');
  const repoRoot = resolve(testDir, '..', '..', '..');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_UPDATE_CHECK: '0',
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_CODERABBIT_HOME_DIR: join(homeDir, 'coderabbit'),
    HAPPIER_STACK_CODEX_HOME_DIR: join(homeDir, 'codex'),
    HAPPIER_STACK_AUGMENT_CACHE_DIR: join(homeDir, 'augment'),
  };

  const res = runHstack({
    repoRoot,
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=augment',
      '--depth=deep',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'augment');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  assert.ok(args.some((a) => String(a).includes('git diff HEAD')));
});
