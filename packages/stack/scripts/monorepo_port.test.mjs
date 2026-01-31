import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { run, runCapture } from './utils/proc/proc.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-monorepo-port-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function gitEnv() {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HAPPY_STACKS_') || k.startsWith('HAPPY_LOCAL_')) continue;
    clean[k] = v;
  }
  return {
    ...clean,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

async function initMonorepoStub({ dir, env, seed = {}, layout = 'legacy' }) {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-q'], { cwd: dir, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: dir, env });

  const kind = String(layout ?? '').trim() === 'packages' ? 'packages' : 'legacy';
  if (kind === 'packages') {
    await mkdir(join(dir, 'packages', 'happy-app'), { recursive: true });
    await mkdir(join(dir, 'packages', 'happy-cli'), { recursive: true });
    await mkdir(join(dir, 'packages', 'happy-server'), { recursive: true });
    await writeFile(join(dir, 'packages', 'happy-app', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(dir, 'packages', 'happy-cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(dir, 'packages', 'happy-server', 'package.json'), '{}\n', 'utf-8');
  } else {
    await mkdir(join(dir, 'expo-app'), { recursive: true });
    await mkdir(join(dir, 'cli'), { recursive: true });
    await mkdir(join(dir, 'server'), { recursive: true });
    await writeFile(join(dir, 'expo-app', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(dir, 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(dir, 'server', 'package.json'), '{}\n', 'utf-8');
  }
  for (const [rel, content] of Object.entries(seed)) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(dir, rel), content, 'utf-8');
  }
  await run('git', ['add', '.'], { cwd: dir, env });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: dir, env });
}

async function initSplitRepoStub({ dir, env, name, seed = {} }) {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-q'], { cwd: dir, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: dir, env });
  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  for (const [rel, content] of Object.entries(seed)) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(dir, rel), content, 'utf-8');
  }
  await run('git', ['add', '.'], { cwd: dir, env });
  await run('git', ['commit', '-q', '-m', `chore: init ${name}`], { cwd: dir, env });
  return (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: dir, env })).trim();
}

test('monorepo port applies split-repo commits into subdirectories', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'packages', 'happy-app'), { recursive: true });
  await mkdir(join(target, 'packages', 'happy-cli'), { recursive: true });
  await mkdir(join(target, 'packages', 'happy-server'), { recursive: true });
  await writeFile(join(target, 'packages', 'happy-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-cli', 'package.json'), '{}\n', 'utf-8');
  // Seed the target with the "base" file so the ported patch has something to apply to.
  await writeFile(join(target, 'packages', 'happy-cli', 'hello.txt'), 'v1\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-server', 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run port command
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'packages', 'happy-cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port --skip-applied skips patches that are already present in the target', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub (already at v2 for cli/hello.txt)
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'packages', 'happy-app'), { recursive: true });
  await mkdir(join(target, 'packages', 'happy-cli'), { recursive: true });
  await mkdir(join(target, 'packages', 'happy-server'), { recursive: true });
  await writeFile(join(target, 'packages', 'happy-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-cli', 'hello.txt'), 'v2\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-server', 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2)
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run port command with skip-applied
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-skip`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--skip-applied',
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'packages', 'happy-cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port accepts monorepo sources without double-prefixing paths', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const source = join(root, 'source-mono');

  // Target monorepo stub
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'packages', 'happy-app'), { recursive: true });
  await mkdir(join(target, 'packages', 'happy-cli'), { recursive: true });
  await mkdir(join(target, 'packages', 'happy-server'), { recursive: true });
  await writeFile(join(target, 'packages', 'happy-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'packages', 'happy-app', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source monorepo repo with one change commit in packages/happy-app/
  await mkdir(source, { recursive: true });
  await run('git', ['init', '-q'], { cwd: source, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: source, env: gitEnv() });
  await mkdir(join(source, 'packages', 'happy-app'), { recursive: true });
  await mkdir(join(source, 'packages', 'happy-cli'), { recursive: true });
  await mkdir(join(source, 'packages', 'happy-server'), { recursive: true });
  await writeFile(join(source, 'packages', 'happy-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(source, 'packages', 'happy-cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(source, 'packages', 'happy-server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(source, 'packages', 'happy-app', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: source, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init source monorepo'], { cwd: source, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: source, env: gitEnv() })).trim();
  await writeFile(join(source, 'packages', 'happy-app', 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: source, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update happy-app hello'], { cwd: source, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-mono-source`,
      `--from-happy=${source}`,
      `--from-happy-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  const content = (await readFile(join(target, 'packages', 'happy-app', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port can clone the target monorepo into a new directory', async (t) => {
  const root = await withTempRoot(t);
  const seedMono = join(root, 'seed-mono');
  const target = join(root, 'target-cloned'); // does not exist yet
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  // Seed monorepo repo that will be cloned into `target`
  await initMonorepoStub({
    dir: seedMono,
    env,
    layout: 'packages',
    seed: { 'packages/happy-cli/hello.txt': 'v1\n' },
  });

  // Source CLI repo with one change commit (v1 -> v2)
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      '--clone-target',
      `--target-repo=${seedMono}`,
      `--branch=port/test-target-clone`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'packages', 'happy-cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port guide auto-clones target when --target does not exist', async (t) => {
  const root = await withTempRoot(t);
  const seedMono = join(root, 'seed-mono');
  const target = join(root, 'target-guide-autoclone'); // does not exist yet
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  // Seed monorepo repo that will be cloned into `target`
  await initMonorepoStub({
    dir: seedMono,
    env,
    layout: 'packages',
    seed: { 'packages/happy-cli/hello.txt': 'v1\n' },
  });

  // Source CLI repo with one change commit (v1 -> v2)
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  // Guide requires a TTY, but with all args provided it should not prompt.
  // We spawn so the guide sees a TTY (required), but still feed no input.
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      'guide',
      `--target=${target}`,
      `--target-repo=${seedMono}`,
      '--branch=port/test-guide-autoclone',
      '--3way',
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    {
      cwd: process.cwd(),
      env: { ...env, HAPPY_STACKS_TEST_TTY: '1', HAPPY_STACKS_DISABLE_LLM_AUTOEXEC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  });
  let out = '';
  let err = '';
  let exitCode = null;
  child.stdout?.on('data', (d) => (out += d.toString()));
  child.stderr?.on('data', (d) => (err += d.toString()));
  child.on('exit', (code) => {
    exitCode = code;
  });

  const waitForExit = async (timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (exitCode != null) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for guide to exit\nstdout:\n${out}\nstderr:\n${err}`);
  };
  await waitForExit(20_000);
  assert.equal(exitCode, 0, `expected guide to exit 0\nstdout:\n${out}\nstderr:\n${err}`);

  const content = (await readFile(join(target, 'packages', 'happy-cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port accepts source repo URLs by cloning them into a temp checkout', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  // Target monorepo stub (seed base file)
  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v1\n' } });

  // Source CLI repo with one change commit
  const base = await initSplitRepoStub({
    dir: sourceCli,
    env,
    name: 'cli',
    seed: { 'hello.txt': 'v1\n' },
  });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-source-url`,
      `--from-happy-cli=file://${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port --continue-on-failure completes even when some patches do not apply', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with v3 already (so v1->v2 patch won't apply, and also can't be detected as already-applied).
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v3\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2)
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run port command: patch should fail to apply, but command succeeds.
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-continue`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--skip-applied',
      '--continue-on-failure',
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.results[0].failedPatches, 1);
});

test('monorepo port auto-skips identical "new file" patches when the file already exists in the target', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub already contains cli/newfile.txt with the same content.
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'newfile.txt'), 'same\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo adds newfile.txt in a single commit.
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'newfile.txt'), 'same\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: add newfile'], { cwd: sourceCli, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-identical-newfile`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );

  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results[0].failedPatches, 0);
  // This commit cannot be applied (it would "create" an existing file), so the port must skip it.
  assert.equal(parsed.results[0].appliedPatches, 0);
  assert.equal(parsed.results[0].skippedAlreadyApplied, 0);
  assert.equal(parsed.results[0].skippedAlreadyExistsIdentical, 1);
});

test('monorepo port --onto-current applies onto the currently checked-out branch', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub on a custom branch (so we can verify it doesn't switch).
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'existing'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2)
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--onto-current',
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const branch = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, env: gitEnv() })).trim();
  assert.equal(branch, 'existing');
  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port branches from target default base (not current HEAD)', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub on main with cli/hello.txt=v1.
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Create a divergent branch and leave it checked out (simulates running port from a non-base branch).
  await run('git', ['checkout', '-q', '-b', 'dev'], { cwd: target, env: gitEnv() });
  await writeFile(join(target, 'cli', 'hello.txt'), 'v3\n', 'utf-8');
  await run('git', ['add', 'cli/hello.txt'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: dev drift'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2).
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Port should branch from target main by default (not dev), so the v1->v2 patch applies.
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-target-base`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port prints an actionable summary in non-json mode when patches fail', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt=v3 (so v1->v2 patch fails).
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v3\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2).
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run without --json and ensure it prints a useful failure summary.
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-nonjson`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--continue-on-failure',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );

  assert.ok(out.includes('port complete with failures'), `expected failure summary in stdout\n${out}`);
  assert.ok(out.includes('feat: update hello'), `expected failed patch subject in stdout\n${out}`);
});

test('monorepo port status reports the current patch and conflicted files during git am', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with base="value=base" and a commit changing to "value=source".
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Start a port that will stop with an am conflict.
  await assert.rejects(
    async () =>
      await runCapture(
        process.execPath,
        [
          join(process.cwd(), 'scripts', 'monorepo.mjs'),
          'port',
          `--target=${target}`,
          `--branch=port/test-status`,
          `--from-happy-cli=${sourceCli}`,
          `--from-happy-cli-base=${base}`,
          '--3way',
        ],
        { cwd: process.cwd(), env: gitEnv() }
      )
  );

  const out = await runCapture(
    process.execPath,
    [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'status', `--target=${target}`, '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, true);
  assert.ok(parsed.currentPatch?.subject?.includes('feat: update hello'), `expected subject in status\n${out}`);
  // Depending on git's 3-way behavior, it may stop without creating unmerged entries.
  // In that case, status should still expose the file(s) touched by the current patch.
  assert.ok(
    parsed.conflictedFiles.includes('cli/hello.txt') || parsed.currentPatch?.files?.includes('cli/hello.txt'),
    `expected cli/hello.txt in conflictedFiles or currentPatch.files\n${out}`
  );
});

test('monorepo port continue runs git am --continue after conflicts are resolved', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with base="value=base" and a commit changing to "value=source".
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Start a port that will stop with an am conflict.
  await assert.rejects(
    async () =>
      await runCapture(
        process.execPath,
        [
          join(process.cwd(), 'scripts', 'monorepo.mjs'),
          'port',
          `--target=${target}`,
          `--branch=port/test-continue-helper`,
          `--from-happy-cli=${sourceCli}`,
          `--from-happy-cli-base=${base}`,
          '--3way',
        ],
        { cwd: process.cwd(), env: gitEnv() }
      )
  );

  // Resolve the conflict by choosing "value=source".
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'cli/hello.txt'], { cwd: target, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'continue', `--target=${target}`, '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, false);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'value=source\n');
});

test('monorepo port continue --stage stages conflicted files before continuing', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with base="value=base" and a commit changing to "value=source".
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Start a port that will stop with an am conflict.
  await assert.rejects(
    async () =>
      await runCapture(
        process.execPath,
        [
          join(process.cwd(), 'scripts', 'monorepo.mjs'),
          'port',
          `--target=${target}`,
          `--branch=port/test-continue-stage`,
          `--from-happy-cli=${sourceCli}`,
          `--from-happy-cli-base=${base}`,
          '--3way',
        ],
        { cwd: process.cwd(), env: gitEnv() }
      )
  );

  // Resolve the conflict by choosing "value=source", but DO NOT stage it.
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=source\n', 'utf-8');

  const out = await runCapture(
    process.execPath,
    [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'continue', `--target=${target}`, '--stage', '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, false);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'value=source\n');
});

test('monorepo port guide refuses to run in non-tty mode', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  await assert.rejects(
    async () =>
      await runCapture(
        process.execPath,
        [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'guide', `--target=${target}`],
        { cwd: process.cwd(), env: gitEnv() }
      )
  );
});

test('monorepo port guide can wait for conflict resolution and finish the port', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo: keep main at base commit, then branch for the change.
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run guide in "test TTY" mode so it can prompt even under non-interactive test runners.
  const scriptPath = join(process.cwd(), 'scripts', 'monorepo.mjs');
  const inputLines = [
    target, // Target monorepo path
    'port/test-guide', // New branch name
    '1', // Use 3-way merge: yes
    // Sources: since we provide --from-happy-cli via the prompts in this test, guide will still prompt.
    '', // Path to old happy (skip)
    sourceCli, // Path to old happy-cli
    '', // Path to old happy-server (skip)
  ];

  const child = spawn(
    process.execPath,
    [scriptPath, 'port', 'guide'],
    {
      cwd: process.cwd(),
      env: { ...gitEnv(), HAPPY_STACKS_TEST_TTY: '1', HAPPY_STACKS_DISABLE_LLM_AUTOEXEC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  });

  let out = '';
  let err = '';
  let conflictSeen = false;
  let finished = false;
  let exitCode = null;
  const waitFor = async (predicate, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for condition\nstdout:\n${out}\nstderr:\n${err}`);
  };

  child.stdout?.on('data', (d) => (out += d.toString()));
  child.stderr?.on('data', (d) => (err += d.toString()));
  child.on('exit', (code) => {
    finished = true;
    exitCode = code;
  });

  const sendLine = (line) => child.stdin?.write(String(line) + '\n');

  // Feed the wizard answers step-by-step (readline can be picky under non-tty runners).
  await waitFor(() => out.includes('Target monorepo path:'), 5_000);
  sendLine(inputLines[0]);
  await waitFor(() => out.includes('New branch name:'), 5_000);
  sendLine(inputLines[1]);
  await waitFor(() => out.includes('Use 3-way merge'), 5_000);
  sendLine(inputLines[2]);
  await waitFor(() => out.includes('old happy (UI)'), 5_000);
  sendLine(inputLines[3]);
  await waitFor(() => out.includes('old happy-cli'), 5_000);
  sendLine(inputLines[4]);
  await waitFor(() => out.includes('old happy-server'), 5_000);
  sendLine(inputLines[5]);

  // Preflight now runs before starting the port. Accept the default (guided) mode.
  await waitFor(() => out.includes('Preflight detected conflicts'), 10_000);
  sendLine('');

  // Wait for the guide to detect a conflict and start waiting for user action.
  await waitFor(() => out.includes('guide: conflict detected') || out.includes('guide: waiting for conflict resolution'), 10_000);
  conflictSeen = true;

  // Wait until the guide is actually prompting for the action.
  await waitFor(() => out.includes('Resolve conflicts, then choose an action:'), 10_000);

  // Resolve conflict in target repo by choosing value=source and staging.
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'cli/hello.txt'], { cwd: target, env: gitEnv() });

  // Tell the guide to continue.
  sendLine('');

  await waitFor(() => finished, 20_000);
  assert.ok(conflictSeen, `expected conflict handling markers\nstdout:\n${out}\nstderr:\n${err}`);
  assert.ok(out.includes('guide complete') || out.includes('port complete'), `expected completion output\nstdout:\n${out}\nstderr:\n${err}`);
  assert.equal(exitCode, 0, `expected guide to exit 0\nstdout:\n${out}\nstderr:\n${err}`);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'value=source\n');
});

test('monorepo port works via bin/happys.mjs entrypoint (CLI registry end-to-end)', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  const env = { ...gitEnv(), HAPPY_STACKS_HOME_DIR: join(root, 'home') };
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'bin', 'happys.mjs'),
      'monorepo',
      'port',
      `--target=${target}`,
      `--branch=port/test-happys`,
      '--base=main',
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );

  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port can port multiple split repos into the same monorepo branch (including renames)', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceUi = join(root, 'source-happy');
  const sourceCli = join(root, 'source-happy-cli');
  const sourceServer = join(root, 'source-happy-server');

  // Target monorepo stub seeded with base files for all three subdirs.
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'expo-app', 'hello.txt'), 'ui-v1\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'cli-v1\n', 'utf-8');
  await writeFile(join(target, 'server', 'hello.txt'), 'srv-v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // UI repo: update hello + add extra
  await mkdir(sourceUi, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceUi, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceUi, env: gitEnv() });
  await writeFile(join(sourceUi, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceUi, 'hello.txt'), 'ui-v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceUi, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init ui'], { cwd: sourceUi, env: gitEnv() });
  const uiBase = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceUi, env: gitEnv() })).trim();
  await writeFile(join(sourceUi, 'hello.txt'), 'ui-v2\n', 'utf-8');
  await writeFile(join(sourceUi, 'extra.txt'), 'extra-ui\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceUi, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update ui + add extra'], { cwd: sourceUi, env: gitEnv() });

  // CLI repo: rename hello -> greeting
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'cli-v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const cliBase = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await run('git', ['mv', 'hello.txt', 'greeting.txt'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'greeting.txt'), 'cli-v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: rename hello to greeting'], { cwd: sourceCli, env: gitEnv() });

  // Server repo: add routes.txt
  await mkdir(sourceServer, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceServer, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceServer, env: gitEnv() });
  await writeFile(join(sourceServer, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceServer, 'hello.txt'), 'srv-v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceServer, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init server'], { cwd: sourceServer, env: gitEnv() });
  const serverBase = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceServer, env: gitEnv() })).trim();
  await writeFile(join(sourceServer, 'routes.txt'), 'routes\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceServer, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: add routes'], { cwd: sourceServer, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-multi`,
      '--base=main',
      '--3way',
      '--json',
      `--from-happy=${sourceUi}`,
      `--from-happy-base=${uiBase}`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${cliBase}`,
      `--from-happy-server=${sourceServer}`,
      `--from-happy-server-base=${serverBase}`,
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  assert.equal((await readFile(join(target, 'expo-app', 'hello.txt'), 'utf-8')).toString(), 'ui-v2\n');
  assert.equal((await readFile(join(target, 'expo-app', 'extra.txt'), 'utf-8')).toString(), 'extra-ui\n');
  assert.equal((await readFile(join(target, 'cli', 'greeting.txt'), 'utf-8')).toString(), 'cli-v2\n');
  await assert.rejects(async () => await readFile(join(target, 'cli', 'hello.txt'), 'utf-8'));
  assert.equal((await readFile(join(target, 'server', 'routes.txt'), 'utf-8')).toString(), 'routes\n');
});

test('monorepo port guide quit leaves a plan; port continue resumes and completes after conflicts are resolved', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo: keep main at base, then create a feature branch with two commits.
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'extra.txt'), 'extra\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: add extra'], { cwd: sourceCli, env: gitEnv() });

  const scriptPath = join(process.cwd(), 'scripts', 'monorepo.mjs');
  const child = spawn(
    process.execPath,
    [scriptPath, 'port', 'guide'],
    {
      cwd: process.cwd(),
      env: { ...gitEnv(), HAPPY_STACKS_TEST_TTY: '1', HAPPY_STACKS_DISABLE_LLM_AUTOEXEC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  });

  let out = '';
  let err = '';
  let exitCode = null;
  const waitFor = async (predicate, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for condition\nstdout:\n${out}\nstderr:\n${err}`);
  };

  child.stdout?.on('data', (d) => (out += d.toString()));
  child.stderr?.on('data', (d) => (err += d.toString()));
  child.on('exit', (code) => {
    exitCode = code;
  });
  const sendLine = (line) => child.stdin?.write(String(line) + '\n');

  // Feed the wizard answers step-by-step.
  await waitFor(() => out.includes('Target monorepo path:'), 5_000);
  sendLine(target);
  await waitFor(() => out.includes('New branch name:'), 5_000);
  sendLine('port/test-guide-quit');
  await waitFor(() => out.includes('Use 3-way merge'), 5_000);
  sendLine('1');
  await waitFor(() => out.includes('old happy (UI)'), 5_000);
  sendLine('');
  await waitFor(() => out.includes('old happy-cli'), 5_000);
  sendLine(sourceCli);
  await waitFor(() => out.includes('old happy-server'), 5_000);
  sendLine('');

  // Preflight now runs before starting the port. Accept the default (guided) mode.
  await waitFor(() => out.includes('Preflight detected conflicts'), 10_000);
  sendLine('');

  // Wait for conflict prompt, then quit.
  await waitFor(() => out.includes('guide: waiting for conflict resolution') || out.includes('guide: conflict detected'), 10_000);
  await waitFor(() => out.includes('Resolve conflicts, then choose an action:'), 10_000);
  const menuTail = out.split('Resolve conflicts, then choose an action:').pop() || '';
  const m = menuTail.match(/\n\s*(\d+)\)\s*quit guide \(leave state as-is\)/);
  if (!m?.[1]) {
    throw new Error(`failed to locate quit option index\nstdout:\n${out}\nstderr:\n${err}`);
  }
  sendLine(m[1]);
  await waitFor(() => exitCode !== null, 10_000);
  assert.notEqual(exitCode, 0, `expected guide to exit non-zero on quit\nstdout:\n${out}\nstderr:\n${err}`);

  // Ensure the plan exists.
  const planRel = (await runCapture('git', ['rev-parse', '--git-path', 'happy-stacks/monorepo-port-plan.json'], { cwd: target, env: gitEnv() })).trim();
  const planAbs = planRel.startsWith('/') ? planRel : join(target, planRel);
  assert.equal(await readFile(planAbs, 'utf-8').then(() => true), true);

  // Resolve + stage conflict.
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'cli/hello.txt'], { cwd: target, env: gitEnv() });

  // Continue should complete `git am` and then resume remaining patches from the plan (including extra.txt).
  const contOut = await runCapture(
    process.execPath,
    [scriptPath, 'port', 'continue', `--target=${target}`, '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(contOut.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, false);

  assert.equal((await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString(), 'value=source\n');
  assert.equal((await readFile(join(target, 'cli', 'extra.txt'), 'utf-8')).toString(), 'extra\n');

  await assert.rejects(async () => await readFile(planAbs, 'utf-8'));
});

test('monorepo port rejects when target repo is dirty', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v1\n' } });
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  // Make target dirty.
  await writeFile(join(target, 'cli', 'uncommitted.txt'), 'dirty\n', 'utf-8');

  await assert.rejects(async () => {
    await runCapture(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'monorepo.mjs'),
        'port',
        `--target=${target}`,
        `--branch=port/test-dirty`,
        '--base=main',
        `--from-happy-cli=${sourceCli}`,
        `--from-happy-cli-base=${base}`,
        '--json',
      ],
      { cwd: process.cwd(), env }
    );
  });
});

test('monorepo port rejects invalid target repo layout', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'not-a-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env });
  await writeFile(join(target, 'README.md'), 'not a monorepo\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env });
  await run('git', ['commit', '-q', '-m', 'chore: init'], { cwd: target, env });

  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });

  await assert.rejects(async () => {
    await runCapture(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'monorepo.mjs'),
        'port',
        `--target=${target}`,
        `--branch=port/test-invalid-target`,
        '--base=main',
        `--from-happy-cli=${sourceCli}`,
        `--from-happy-cli-base=${base}`,
      ],
      { cwd: process.cwd(), env }
    );
  });
});

test('monorepo port validates incompatible flags with --onto-current', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v1\n' } });
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });

  await assert.rejects(async () => {
    await runCapture(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'monorepo.mjs'),
        'port',
        `--target=${target}`,
        '--onto-current',
        `--branch=port/nope`,
        `--from-happy-cli=${sourceCli}`,
        `--from-happy-cli-base=${base}`,
      ],
      { cwd: process.cwd(), env }
    );
  });

  await assert.rejects(async () => {
    await runCapture(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'monorepo.mjs'),
        'port',
        `--target=${target}`,
        '--onto-current',
        `--base=main`,
        `--from-happy-cli=${sourceCli}`,
        `--from-happy-cli-base=${base}`,
      ],
      { cwd: process.cwd(), env }
    );
  });
});

test('monorepo port succeeds with an empty commit range (no patches)', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v1\n' } });
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/empty-range`,
      '--base=main',
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );

  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results[0].patches, 0);
});

test('monorepo port skips already-applied patches even without --skip-applied', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v2\n' } });
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/skip-applied-default`,
      '--base=main',
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.ok(parsed.results[0].skippedAlreadyApplied >= 1);
  assert.equal((await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString(), 'v2\n');
});

test('monorepo port auto-skips identical multi-file new-file patches when all files already exist identically', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({
    dir: target,
    env,
    seed: { 'cli/a.txt': 'same-a\n', 'cli/b.txt': 'same-b\n' },
  });

  // Source: base commit with no a/b, then one commit adding both.
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: {} });
  await writeFile(join(sourceCli, 'a.txt'), 'same-a\n', 'utf-8');
  await writeFile(join(sourceCli, 'b.txt'), 'same-b\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: add a + b'], { cwd: sourceCli, env });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/identical-multi-newfiles`,
      '--base=main',
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );

  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results[0].appliedPatches, 0);
  assert.equal(parsed.results[0].skippedAlreadyExistsIdentical, 1);
});

test('monorepo port does not auto-skip new-file patch when the target file exists with different content', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/newfile.txt': 'target\n' } });
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: {} });
  await writeFile(join(sourceCli, 'newfile.txt'), 'source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: add newfile'], { cwd: sourceCli, env });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/newfile-differs`,
      '--base=main',
      '--continue-on-failure',
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.results[0].failedPatches, 1);
  assert.equal(parsed.results[0].skippedAlreadyExistsIdentical, 0);
});

test('monorepo port reports "git am already in progress" even when the target worktree is dirty', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'value=target\n' } });

  // Source CLI repo: base differs from target to force an am conflict.
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  // Start a port that will stop with an am conflict (leaves git am state).
  await assert.rejects(async () => {
    await runCapture(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'monorepo.mjs'),
        'port',
        `--target=${target}`,
        `--branch=port/am-in-progress`,
        '--base=main',
        '--3way',
        `--from-happy-cli=${sourceCli}`,
        `--from-happy-cli-base=${base}`,
      ],
      { cwd: process.cwd(), env }
    );
  });

  // Make the worktree dirty while am is in progress (this happens naturally for many conflicts,
  // but we force it here to ensure we prefer the more actionable "git am in progress" error).
  await writeFile(join(target, 'cli', 'dirty.txt'), 'dirty\n', 'utf-8');

  // Re-running should complain specifically about the in-progress am.
  await assert.rejects(
    async () => {
      await runCapture(
        process.execPath,
        [
          join(process.cwd(), 'scripts', 'monorepo.mjs'),
          'port',
          `--target=${target}`,
          `--onto-current`,
          `--from-happy-cli=${sourceCli}`,
          `--from-happy-cli-base=${base}`,
        ],
        { cwd: process.cwd(), env }
      );
    },
    (err) => {
      const msg = String(err?.err ?? err?.message ?? err ?? '');
      assert.ok(msg.includes('git am operation is already in progress'), `expected git am in-progress error\n${msg}`);
      return true;
    }
  );
});

test('monorepo port --dry-run does not create a branch or modify the target repo', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v1\n' } });
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  const beforeHead = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: target, env })).trim();
  const beforeBranch = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, env })).trim();

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      '--dry-run',
      `--branch=port/dry-run`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);

  const afterHead = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: target, env })).trim();
  const afterBranch = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, env })).trim();
  assert.equal(afterHead, beforeHead);
  assert.equal(afterBranch, beforeBranch);

  const hasDryBranch = await runCapture('git', ['show-ref', '--verify', '--quiet', 'refs/heads/port/dry-run'], {
    cwd: target,
    env,
  })
    .then(() => true)
    .catch(() => false);
  assert.equal(hasDryBranch, false);

  assert.equal((await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString(), 'v1\n');
});

test('monorepo port rejects when --branch already exists in the target repo', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v1\n' } });
  await run('git', ['checkout', '-q', '-b', 'port/existing'], { cwd: target, env });
  await run('git', ['checkout', '-q', 'main'], { cwd: target, env });

  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });

  await assert.rejects(async () => {
    await runCapture(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'monorepo.mjs'),
        'port',
        `--target=${target}`,
        `--branch=port/existing`,
        '--base=main',
        `--from-happy-cli=${sourceCli}`,
        `--from-happy-cli-base=${base}`,
      ],
      { cwd: process.cwd(), env }
    );
  });
});

test('monorepo port can port from a non-HEAD ref (--from-happy-cli-ref) without changing the source repo checkout', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'v1\n' } });

  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env });

  // Create a feature branch commit, then go back to main to ensure HEAD is not the ref we’re porting.
  await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: sourceCli, env });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });
  await run('git', ['checkout', '-q', 'main'], { cwd: sourceCli, env });
  const headBranch = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: sourceCli, env })).trim();
  assert.equal(headBranch, 'main');

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/from-ref`,
      '--base=main',
      `--from-happy-cli=${sourceCli}`,
      '--from-happy-cli-ref=feature',
      '--from-happy-cli-base=main',
      '--json',
    ],
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal((await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString(), 'v2\n');
});

test('monorepo port preflight reports conflicts without modifying the target repo', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  // Target monorepo stub with cli/hello.txt="value=target".
  await initMonorepoStub({ dir: target, env, seed: { 'cli/hello.txt': 'value=target\n' } });
  const targetHeadBefore = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: target, env })).trim();

  // Source CLI: base commit then feature commit that changes hello.txt (will conflict).
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env });
  await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: sourceCli, env });
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      'preflight',
      `--target=${target}`,
      '--base=main',
      '--json',
      `--from-happy-cli=${sourceCli}`,
      '--from-happy-cli-base=main',
      '--from-happy-cli-ref=feature',
    ],
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, false);
  assert.ok(parsed.firstConflict);
  assert.ok(parsed.firstConflict.currentPatch);

  // Target should remain untouched (preflight runs in a temporary detached worktree).
  const targetHeadAfter = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: target, env })).trim();
  assert.equal(targetHeadAfter, targetHeadBefore);
});
