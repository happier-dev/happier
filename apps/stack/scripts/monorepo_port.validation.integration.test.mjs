import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { run, runCapture } from './utils/proc/proc.mjs';
import { withTempRoot, gitEnv, initMonorepoStub, initSplitRepoStub } from './testkit/monorepo_port_testkit.mjs';

test('monorepo port rejects when target repo is dirty', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });
  const base = await initSplitRepoStub({ dir: sourceCli, env, name: 'cli', seed: { 'hello.txt': 'v1\n' } });
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env });

  // Make target dirty.
  await writeFile(join(target, 'apps', 'cli', 'uncommitted.txt'), 'dirty\n', 'utf-8');

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

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });
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

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });
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

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v2\n' } });
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
  assert.equal((await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString(), 'v2\n');
});

test('monorepo port auto-skips identical multi-file new-file patches when all files already exist identically', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({
    dir: target,
    env,
    seed: { 'apps/cli/a.txt': 'same-a\n', 'apps/cli/b.txt': 'same-b\n' },
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

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/newfile.txt': 'target\n' } });
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

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'value=target\n' } });

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
  await writeFile(join(target, 'apps', 'cli', 'dirty.txt'), 'dirty\n', 'utf-8');

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

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });
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

  assert.equal((await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString(), 'v1\n');
});

test('monorepo port rejects when --branch already exists in the target repo', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });
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

  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'v1\n' } });

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
  assert.equal((await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString(), 'v2\n');
});

test('monorepo port preflight reports conflicts without modifying the target repo', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');
  const env = gitEnv();

  // Target monorepo stub with cli/hello.txt="value=target".
  await initMonorepoStub({ dir: target, env, seed: { 'apps/cli/hello.txt': 'value=target\n' } });
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
