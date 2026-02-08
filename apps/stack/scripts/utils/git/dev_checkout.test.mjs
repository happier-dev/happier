import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDevCheckout } from './dev_checkout.mjs';

function runCapture(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const e = new Error(`${cmd} failed (code=${code})`);
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
  });
}

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-checkout-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function initBareRepo(dir) {
  await mkdir(dir, { recursive: true });
  await runCapture('git', ['init', '--bare'], { cwd: dir });
}

async function seedRepoWithBranches({ seedDir, upstreamBareDir, originBareDir }) {
  await mkdir(seedDir, { recursive: true });
  await runCapture('git', ['init'], { cwd: seedDir });
  await runCapture('git', ['config', 'user.email', 'test@example.com'], { cwd: seedDir });
  await runCapture('git', ['config', 'user.name', 'Test'], { cwd: seedDir });

  await writeFile(join(seedDir, 'README.md'), 'seed\n', 'utf-8');
  await runCapture('git', ['add', '.'], { cwd: seedDir });
  await runCapture('git', ['commit', '-m', 'seed'], { cwd: seedDir });

  await runCapture('git', ['branch', '-M', 'main'], { cwd: seedDir });
  await runCapture('git', ['checkout', '-b', 'dev'], { cwd: seedDir });

  await runCapture('git', ['remote', 'add', 'upstream', upstreamBareDir], { cwd: seedDir });
  await runCapture('git', ['remote', 'add', 'origin', originBareDir], { cwd: seedDir });
  await runCapture('git', ['push', 'upstream', 'main:main', 'dev:dev'], { cwd: seedDir });
  await runCapture('git', ['push', 'origin', 'main:main', 'dev:dev'], { cwd: seedDir });
}

async function cloneIntoWorkspaceMain({ workspaceDir, upstreamBareDir, originBareDir }) {
  const mainDir = join(workspaceDir, 'main');
  await mkdir(workspaceDir, { recursive: true });
  await runCapture('git', ['clone', upstreamBareDir, mainDir], { cwd: workspaceDir });

  // Simulate the common contributor layout:
  // - upstream = canonical repo
  // - origin = fork
  await runCapture('git', ['remote', 'set-url', 'origin', originBareDir], { cwd: mainDir });
  await runCapture('git', ['remote', 'add', 'upstream', upstreamBareDir], { cwd: mainDir });
  await runCapture('git', ['fetch', '--all'], { cwd: mainDir });
}

async function createDevCheckoutFixture(t, { forkWorkflow }) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const stackRootDir = dirname(dirname(dirname(scriptsDir)));
  const tempRoot = await withTempRoot(t);
  const workspaceDir = join(tempRoot, 'workspace');
  const upstreamBareDir = join(tempRoot, 'upstream.git');
  const originBareDir = forkWorkflow ? join(tempRoot, 'origin.git') : upstreamBareDir;
  const seedDir = join(tempRoot, 'seed');

  await initBareRepo(upstreamBareDir);
  if (forkWorkflow) {
    await initBareRepo(originBareDir);
  }
  await seedRepoWithBranches({ seedDir, upstreamBareDir, originBareDir });
  await cloneIntoWorkspaceMain({ workspaceDir, upstreamBareDir, originBareDir });

  return {
    stackRootDir,
    workspaceDir,
    originBareDir,
  };
}

test('ensureDevCheckout prefers upstream/dev when upstream is pushable', async (t) => {
  const fixture = await createDevCheckoutFixture(t, { forkWorkflow: false });
  const env = { ...process.env, HAPPIER_STACK_WORKSPACE_DIR: fixture.workspaceDir };
  const res = await ensureDevCheckout({ rootDir: fixture.stackRootDir, env });
  assert.equal(res.ok, true);
  assert.equal(res.trackingRemote, 'upstream');
});

test('ensureDevCheckout uses origin/dev when upstream is not pushable (fork workflow)', async (t) => {
  const fixture = await createDevCheckoutFixture(t, { forkWorkflow: true });
  const env = { ...process.env, HAPPIER_STACK_WORKSPACE_DIR: fixture.workspaceDir };
  const res = await ensureDevCheckout({ rootDir: fixture.stackRootDir, env });
  assert.equal(res.ok, true);
  assert.equal(res.trackingRemote, 'origin');

  const devDir = join(fixture.workspaceDir, 'dev');
  const { stdout } = await runCapture('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: devDir });
  assert.equal(stdout.trim(), 'origin/dev');
});
