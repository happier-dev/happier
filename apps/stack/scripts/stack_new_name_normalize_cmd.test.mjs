import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';

test('hstack stack new normalizes stack names across valid and punctuation-heavy inputs', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-new-name-',
  });
  await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });

  const cases = [
    { rawName: 'My Stack', normalized: 'my-stack' },
    { rawName: 'already-valid', normalized: 'already-valid' },
    { rawName: '  MIXED__Case...Name  ', normalized: 'mixed-case-name' },
    { rawName: 'alpha---beta', normalized: 'alpha-beta' },
  ];

  for (const testCase of cases) {
    const res = await fixture.runStackNew([testCase.rawName, '--json']);
    assert.equal(
      res.code,
      0,
      `${testCase.rawName}: expected exit 0, got ${res.code} (signal: ${res.signal})\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.stackName, testCase.normalized, `${testCase.rawName}: unexpected stackName`);
    assert.ok(
      typeof parsed?.envPath === 'string' && parsed.envPath.includes(`/${testCase.normalized}/env`),
      `${testCase.rawName}: unexpected envPath ${parsed?.envPath}`
    );

    const contents = await fixture.readStackEnv(testCase.normalized);
    assert.ok(contents.includes(`HAPPIER_STACK_STACK=${testCase.normalized}\n`), `${testCase.rawName}\n${contents}`);
  }
});

test('hstack stack new does not prompt in a TTY when controlled flags are complete', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-new-controlled-tty-',
  });
  const repoDir = await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });
  const stackName = 'controlled-tty';
  const ttyEnv = Object.fromEntries(
    Object.entries(fixture.baseEnv).filter(([key]) => !key.startsWith('HAPPIER_STACK_')),
  );
  Object.assign(ttyEnv, {
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_HOME_DIR: fixture.homeDir,
    HAPPIER_STACK_SANDBOX_DIR: fixture.sandboxDir,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_TEST_TTY: '1',
    HAPPIER_STACK_WORKSPACE_DIR: fixture.workspaceDir,
  });

  const created = await runNodeCapture([
    join(fixture.rootDir, 'scripts', 'stack.mjs'),
    'new',
    stackName,
    `--repo=${repoDir}`,
    '--server=happier-server-light',
    '--db-provider=sqlite',
    '--no-copy-auth',
  ], {
    cwd: fixture.rootDir,
    env: ttyEnv,
    // A prompt regression would consume these and persist `origin`, proving the command
    // ignored the already-complete controlled configuration.
    input: 'ephemeral\norigin\n',
  });

  assert.equal(created.code, 0, `stack new failed\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`);
  assert.doesNotMatch(created.stdout, /\bPorts\b|\bWorktrees\b/, created.stdout);
  assert.match(await fixture.readStackEnv(stackName), /HAPPIER_STACK_STACK_REMOTE=upstream\n/);
});

test('hstack stack new refuses an existing stack without changing its env', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-new-existing-guard-',
  });
  await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });

  const stackName = 'existing-stack';
  const created = await fixture.runStackNew([stackName, '--no-copy-auth', '--json']);
  assert.equal(created.code, 0, `initial stack new failed\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`);

  const envPath = join(fixture.storageDir, stackName, 'env');
  assert.match(
    await fixture.readStackEnv(stackName),
    /HAPPIER_STACK_AUTO_AUTH_SEED=0\n/,
    '--no-copy-auth must persistently prevent a later non-interactive start from importing main credentials',
  );
  await ensureEnvFileUpdated({
    envPath,
    updates: [
      { key: 'SENTINEL', value: 'preserve-me' },
      { key: 'HAPPIER_STACK_RUNTIME_MODE', value: 'require' },
      { key: 'HAPPIER_STACK_EXPO_SOURCE_STACK', value: 'repo-producer' },
    ],
  });
  const before = await fixture.readStackEnv(stackName);

  const repeated = await fixture.runStackNew([stackName, '--no-copy-auth', '--json']);
  assert.notEqual(repeated.code, 0, `repeated stack new unexpectedly succeeded\nstdout:\n${repeated.stdout}`);
  assert.match(repeated.stderr, /stack already exists/i);
  assert.equal(await fixture.readStackEnv(stackName), before);
});
