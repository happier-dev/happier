import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { run, runCapture } from './utils/proc/proc.mjs';
import { withTempRoot, gitEnv, spawnNodeWithCapture } from './testkit/monorepo_port_testkit.mjs';

test('monorepo port status reports the current patch and conflicted files during git am', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
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
    parsed.conflictedFiles.includes('apps/cli/hello.txt') || parsed.currentPatch?.files?.includes('apps/cli/hello.txt'),
    `expected apps/cli/hello.txt in conflictedFiles or currentPatch.files\n${out}`
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
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
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'apps/cli/hello.txt'], { cwd: target, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'continue', `--target=${target}`, '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, false);

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
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
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=source\n', 'utf-8');

  const out = await runCapture(
    process.execPath,
    [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'continue', `--target=${target}`, '--stage', '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, false);

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'value=source\n');
});

test('monorepo port guide refuses to run in non-tty mode', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
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
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
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

  const guide = spawnNodeWithCapture(
    process.execPath,
    [scriptPath, 'port', 'guide'],
    {
      cwd: process.cwd(),
      env: { ...gitEnv(), HAPPIER_STACK_TEST_TTY: '1', HAPPIER_STACK_DISABLE_LLM_AUTOEXEC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  t.after(() => {
    guide.kill('SIGKILL');
  });
  let conflictSeen = false;

  const sendLine = (line) => guide.sendLine(line);

  // Feed the wizard answers step-by-step (readline can be picky under non-tty runners).
  await guide.waitForText('Target monorepo path:', 15_000);
  sendLine(inputLines[0]);
  await guide.waitForText('New branch name:', 15_000);
  sendLine(inputLines[1]);
  await guide.waitForText('Use 3-way merge', 15_000);
  sendLine(inputLines[2]);
  await guide.waitForText('old happy (UI)', 15_000);
  sendLine(inputLines[3]);
  await guide.waitForText('old happy-cli', 15_000);
  sendLine(inputLines[4]);
  await guide.waitForText('old happy-server', 15_000);
  sendLine(inputLines[5]);

  // Preflight now runs before starting the port. Accept the default (guided) mode.
  await guide.waitForText('Preflight detected conflicts', 10_000);
  sendLine('');

  // Wait for the guide to detect a conflict and start waiting for user action.
  await Promise.race([guide.waitForText('guide: conflict detected', 10_000), guide.waitForText('guide: waiting for conflict resolution', 10_000)]);
  conflictSeen = true;

  // Wait until the guide is actually prompting for the action.
  await guide.waitForText('Resolve conflicts, then choose an action:', 10_000);

  // Resolve conflict in target repo by choosing value=source and staging.
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'apps/cli/hello.txt'], { cwd: target, env: gitEnv() });

  // Tell the guide to continue.
  sendLine('');

  const guideResult = await guide.waitForExit(20_000);
  assert.ok(
    conflictSeen,
    `expected conflict handling markers\nstdout:\n${guideResult.stdout}\nstderr:\n${guideResult.stderr}`
  );
  assert.ok(
    guideResult.combined.includes('guide complete') || guideResult.combined.includes('port complete'),
    `expected completion output\nstdout:\n${guideResult.stdout}\nstderr:\n${guideResult.stderr}`
  );
  assert.equal(
    guideResult.code,
    0,
    `expected guide to exit 0\nstdout:\n${guideResult.stdout}\nstderr:\n${guideResult.stderr}`
  );

  const content = (await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'value=source\n');
});

test('monorepo port guide quit leaves a plan; port continue resumes and completes after conflicts are resolved', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'apps', 'ui'), { recursive: true });
  await mkdir(join(target, 'apps', 'cli'), { recursive: true });
  await mkdir(join(target, 'apps', 'server'), { recursive: true });
  await writeFile(join(target, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
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
  const guide = spawnNodeWithCapture(
    process.execPath,
    [scriptPath, 'port', 'guide'],
    {
      cwd: process.cwd(),
      env: { ...gitEnv(), HAPPIER_STACK_TEST_TTY: '1', HAPPIER_STACK_DISABLE_LLM_AUTOEXEC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  t.after(() => {
    guide.kill('SIGKILL');
  });
  const sendLine = (line) => guide.sendLine(line);

  // Feed the wizard answers step-by-step.
  await guide.waitForText('Target monorepo path:', 5_000);
  sendLine(target);
  await guide.waitForText('New branch name:', 5_000);
  sendLine('port/test-guide-quit');
  await guide.waitForText('Use 3-way merge', 5_000);
  sendLine('1');
  await guide.waitForText('old happy (UI)', 5_000);
  sendLine('');
  await guide.waitForText('old happy-cli', 5_000);
  sendLine(sourceCli);
  await guide.waitForText('old happy-server', 5_000);
  sendLine('');

  // Preflight now runs before starting the port. Accept the default (guided) mode.
  await guide.waitForText('Preflight detected conflicts', 10_000);
  sendLine('');

  // Wait for conflict prompt, then quit.
  await Promise.race([guide.waitForText('guide: waiting for conflict resolution', 10_000), guide.waitForText('guide: conflict detected', 10_000)]);
  await guide.waitForText('Resolve conflicts, then choose an action:', 10_000);
  const menuTail = guide.getOutput().combined.split('Resolve conflicts, then choose an action:').pop() || '';
  const m = menuTail.match(/\n\s*(\d+)\)\s*quit guide \(leave state as-is\)/);
  if (!m?.[1]) {
    const output = guide.getOutput();
    throw new Error(`failed to locate quit option index\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  }
  sendLine(m[1]);
  const quitResult = await guide.waitForExit(10_000);
  assert.notEqual(
    quitResult.code,
    0,
    `expected guide to exit non-zero on quit\nstdout:\n${quitResult.stdout}\nstderr:\n${quitResult.stderr}`
  );

  // Ensure the plan exists.
  const planRel = (await runCapture('git', ['rev-parse', '--git-path', 'happy-stacks/monorepo-port-plan.json'], { cwd: target, env: gitEnv() })).trim();
  const planAbs = planRel.startsWith('/') ? planRel : join(target, planRel);
  assert.equal(await readFile(planAbs, 'utf-8').then(() => true), true);

  // Resolve + stage conflict.
  await writeFile(join(target, 'apps', 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'apps/cli/hello.txt'], { cwd: target, env: gitEnv() });

  // Continue should complete `git am` and then resume remaining patches from the plan (including extra.txt).
  const contOut = await runCapture(
    process.execPath,
    [scriptPath, 'port', 'continue', `--target=${target}`, '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(contOut.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, false);

  assert.equal((await readFile(join(target, 'apps', 'cli', 'hello.txt'), 'utf-8')).toString(), 'value=source\n');
  assert.equal((await readFile(join(target, 'apps', 'cli', 'extra.txt'), 'utf-8')).toString(), 'extra\n');

  await assert.rejects(async () => await readFile(planAbs, 'utf-8'));
});
