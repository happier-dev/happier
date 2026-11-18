import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Owner 2026-11-18 (P03-LOCAL-GUARD): the controller does not run agents' test
// suites under explicit --local; they run routed. Other local commands, placed
// worker payloads, nested payloads and CI keep their existing local execution.
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const launcher = join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
const placementEnvironment = ['CI', 'HAPPIER_DEV_TARGET_EXECUTION', 'HAPPIER_HSTACK_EXECUTION',
  'HAPPIER_HSTACK_DISPATCH_CONTROL', 'HAPPIER_EXEC_CONFIG_PATH', 'HAPPIER_PREFERRED_EXECUTION',
  'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN', 'HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT', 'HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE',
  'HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED', 'npm_node_execpath', 'npm_execpath'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-local-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const marker = join(root, 'payload-started');
  // The controller routes: its Stack execution projection places commands on a target.
  await mkdir(join(root, 'stacks', 'repo-controller'), { recursive: true });
  await writeFile(join(root, 'stacks', 'repo-controller', 'dev-target-exec-v1.sh'),
    "HSTACK_EXEC_PROJECTION_VERSION='2'\ncommand_mode='auto'\ntarget_count='1'\ntarget_1_name='worker'\n");
  // The controller is the Linux development host; runners are external tools.
  for (const [name, body] of [['uname', 'printf "Linux\\n"'],
    ['vitest', `: > ${JSON.stringify(marker)}`], ['jest', `: > ${JSON.stringify(marker)}`]]) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !placementEnvironment.includes(key)));
  const run = (args, extraEnv = {}) => spawnSync('/bin/sh', [launcher, '--local', ...args], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60_000,
    env: { ...env, HOME: root, HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'), PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
  });
  const started = () => access(marker).then(() => true, () => false);
  return { run, started, root };
}

test('controller --local refuses test runners and names the routed form', { skip: process.platform === 'win32' }, async t => {
  const { run, started } = await fixture(t);
  for (const args of [['--', 'vitest', 'run', 'a.test.ts'], ['--', 'jest', 'a.test.ts'],
    ['--', 'bash', '-c', 'cd apps/ui && vitest run a.test.tsx']]) {
    const refused = run(args);
    assert.equal(refused.status, 1, args.join(' ') + '\n' + refused.stderr);
    assert.match(refused.stderr, /HSTACK_LOCAL_TEST_REFUSED/);
    assert.match(refused.stderr, /hstack-exec -- /);
    assert.equal(await started(), false, args.join(' '));
  }
});

test('a host that does not route keeps --local test runs local', { skip: process.platform === 'win32' }, async t => {
  const { run, root } = await fixture(t);
  await writeFile(join(root, 'stacks', 'repo-controller', 'dev-target-exec-v1.sh'),
    "HSTACK_EXEC_PROJECTION_VERSION='2'\ncommand_mode='local'\ntarget_count='1'\n");
  const result = run(['--', 'vitest', 'run', 'a.test.ts'], { HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' });
  assert.doesNotMatch(result.stderr, /HSTACK_LOCAL_TEST_REFUSED/);
});

test('controller --local keeps other commands local', { skip: process.platform === 'win32' }, async t => {
  const { run } = await fixture(t);
  const result = run(['--', 'printf', 'local-ok']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local-ok');
  assert.doesNotMatch(result.stderr, /HSTACK_LOCAL_TEST_REFUSED/);
});

test('controller --local keeps a tracked-file regeneration run local and says why', { skip: process.platform === 'win32' }, async t => {
  const { run } = await fixture(t);
  // The decision is the contract; the payload then enters ordinary local
  // validation preparation, which this fixture does not exercise.
  const result = run(['--', 'env', 'UPDATE_AUTOMATION_VERB_MATRIX=1', 'vitest', 'run', 'a.test.ts'],
    { HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' });
  assert.doesNotMatch(result.stderr, /HSTACK_LOCAL_TEST_REFUSED/);
  assert.match(result.stderr, /regenerates tracked files/);
});
