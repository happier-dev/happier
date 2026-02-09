import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { run, runCapture } from './utils/proc/proc.mjs';
import { withTempRoot, gitEnv, initMonorepoStub, initSplitRepoStub, spawnNodeWithCapture } from './testkit/monorepo_port_testkit.mjs';

test('monorepo port applies split-repo commits into subdirectories', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });

  // Source CLI repo with one change commit
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

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
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port --skip-applied skips patches that are already present in the target', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v2\n' } });

  // Source CLI repo with one change commit (v1 -> v2)
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

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
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port accepts monorepo sources without double-prefixing paths', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const source = join(root, 'source-mono');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'apps/ui/hello.txt': 'v1\n' } });

  // Source monorepo repo with one change commit in apps/ui/
  await initMonorepoStub({ dir: source, env, seed: { 'apps/ui/hello.txt': 'v1\n' } });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: source, env })).trim();
  await writeFile(join(source, 'apps', 'ui', 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: source, env });
  await run('git', ['commit', '-q', '-m', 'feat: update happy-app hello'], { cwd: source, env });

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
    { cwd: process.cwd(), env }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  const content = (await readFile(join(target, 'apps', 'ui', 'hello.txt'), 'utf-8')).toString();
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
    seed: { 'apps/cli/hello.txt': 'v1\n' },
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

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
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
    seed: { 'apps/cli/hello.txt': 'v1\n' },
  });

  // Source CLI repo with one change commit (v1 -> v2)
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  // Guide requires a TTY, but with all args provided it should not prompt.
  // We spawn so the guide sees a TTY (required), but still feed no input.
  const guide = spawnNodeWithCapture(
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
      env: { ...env, HAPPIER_STACK_TEST_TTY: '1', HAPPIER_STACK_DISABLE_LLM_AUTOEXEC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  t.after(() => {
    guide.kill('SIGKILL');
  });
  const guideResult = await guide.waitForExit(20_000);
  assert.equal(
    guideResult.code,
    0,
    `expected guide to exit 0\nstdout:\n${guideResult.stdout}\nstderr:\n${guideResult.stderr}`
  );

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port accepts source repo URLs by cloning them into a temp checkout', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  // Target monorepo stub (seed base file)
  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });

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

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'v3\n', 'utf-8');
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'newfile.txt'), 'same\n', 'utf-8');
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'v1\n', 'utf-8');
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
  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Create a divergent branch and leave it checked out (simulates running port from a non-base branch).
  await run('git', ['checkout', '-q', '-b', 'dev'], { cwd: target, env: gitEnv() });
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'v3\n', 'utf-8');
  await run('git', ['add', 'apps/cli/hello.txt'], { cwd: target, env: gitEnv() });
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

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'v3\n', 'utf-8');
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

test('monorepo port works via bin/hstack.mjs entrypoint (CLI registry end-to-end)', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'v1\n', 'utf-8');
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

  const env = { ...gitEnv(), HAPPIER_STACK_HOME_DIR: join(root, 'home') };
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'bin', 'hstack.mjs'),
      'monorepo',
      'port',
      `--target=${target}`,
      `--branch=port/test-hstack`,
      '--base=main',
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env }
  );

  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'ui', 'hello.txt'), 'ui-v1\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'cli-v1\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'hello.txt'), 'srv-v1\n', 'utf-8');
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

  assert.equal((await readFile(join(target, 'apps', 'ui', 'hello.txt'), 'utf-8')).toString(), 'ui-v2\n');
  assert.equal((await readFile(join(target, 'apps', 'ui', 'extra.txt'), 'utf-8')).toString(), 'extra-ui\n');
  assert.equal((await readFile(join(target, 'apps', 'cli', 'greeting.txt'), 'utf-8')).toString(), 'cli-v2\n');
  await assert.rejects(async () => await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8'));
  assert.equal((await readFile(join(target, 'apps', 'server', 'routes.txt'), 'utf-8')).toString(), 'routes\n');
});
