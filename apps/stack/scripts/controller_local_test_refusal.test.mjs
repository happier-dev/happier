import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// Escape hatch (P03 ORCH 2026-11-18): a named reason and at most two existing
// test files. The reason and files land in the execution-provenance audit log.
test('--allow-local-test runs up to two named files locally and records why', { skip: process.platform === 'win32' }, async t => {
  const { run, root } = await fixture(t);
  const files = ['apps/stack/scripts/controller_local_test_refusal.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_commands.focused.test.mjs'];
  const allowed = run(['--allow-local-test=bisecting a hang', '--', 'vitest', 'run', ...files], { HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' });
  assert.doesNotMatch(allowed.stderr, /HSTACK_LOCAL_TEST_REFUSED/);
  assert.match(allowed.stderr, /allowed by --allow-local-test: bisecting a hang/);
  const rows = (await readFile(join(root, 'stacks', 'repo-controller', 'dev-target-command-load-native', 'provenance.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.at(-1).localTestOverride, { reason: 'bisecting a hang', files });
  assert.equal(rows.at(-1).target, 'local');
});

test('--allow-local-test still refuses suites, globs, directories and a third file', { skip: process.platform === 'win32' }, async t => {
  const { run, started } = await fixture(t);
  const file = 'apps/stack/scripts/controller_local_test_refusal.test.mjs';
  for (const payload of [['vitest', 'run'], ['vitest', 'run', 'apps/stack/scripts'], ['vitest', 'run', 'apps/stack/scripts/*.test.mjs'],
    ['vitest', 'run', file, 'apps/stack/scripts/heavyweight_reservations.test.mjs', 'apps/stack/scripts/utils/dev_targets/protocol_preparation.test.mjs'],
    ['vitest', 'run', 'apps/stack/scripts/missing.test.mjs'], ['bash', '-c', `vitest run ${file}`]]) {
    const refused = run(['--allow-local-test=why', '--', ...payload]);
    assert.equal(refused.status, 1, payload.join(' ') + '\n' + refused.stderr);
    assert.match(refused.stderr, /HSTACK_LOCAL_TEST_REFUSED/, payload.join(' '));
  }
  const empty = run(['--allow-local-test=', '--', 'vitest', 'run', file]);
  assert.equal(empty.status, 64, empty.stderr);
  assert.equal(await started(), false);
});
