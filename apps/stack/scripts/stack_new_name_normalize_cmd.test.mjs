import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { resolveRepoStackIdentity } from './utils/stack/repo_stack_identity.mjs';
import { writeJsonAtomic } from './utils/fs/json.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { resolveControlledRuntimePlacement, resolveControlledQaBrowserTarget } from './utils/dev_targets/service_placement.mjs';

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

test('new QA stacks request the dedicated hosts while normal stacks and existing QA retain their placement', async t => {
  const fixture = await setupStackNewMonorepoFixture({ importMetaUrl: import.meta.url, t, tmpPrefix: 'hstack-qa-creation-' });
  const repoDir = await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });
  await mkdir(join(repoDir, '.git'), { recursive: true });
  for (const [name, options, enabled] of [
    ['agent-qa-example', [], true], ['custom-qa', ['--qa'], true], ['normal-stack', [], false],
  ]) {
    const created = await fixture.runStackNew([name, ...options, '--no-copy-auth', '--json']);
    assert.equal(created.code, 0, created.stderr);
    const producer = resolveRepoStackIdentity({ repoRoot: repoDir, stacksStorageRoot: fixture.storageDir }).stackName;
    const contents = await fixture.readStackEnv(name);
    assert.equal(contents.includes('HAPPIER_STACK_QA_DAEMON_TARGETS=nl1,nl2,linux3,linux2,linux1\n'), enabled);
    assert.doesNotMatch(contents, /^HAPPIER_STACK_QA_DAEMON_TARGETS=.*\bwindows1-linux\b/m,
      'the disk-unhealthy Windows host is not a default QA candidate');
    assert.equal(contents.includes('HAPPIER_STACK_RUNTIME_MODE=source-snapshot\n'), enabled);
    assert.equal(contents.includes(`HAPPIER_STACK_EXPO_SOURCE_STACK=${producer}\n`), enabled);
  }
  const before = await fixture.readStackEnv('normal-stack');
  const retained = await fixture.runStackNew(['normal-stack', '--qa', '--if-missing', '--json']);
  assert.equal(retained.code, 0, retained.stderr);
  assert.equal(await fixture.readStackEnv('normal-stack'), before, 'creation defaults never retrofit an existing Machine');
});

test('new QA stacks seed configured producer QA placement without moving development or retained stacks', async t => {
  const fixture = await setupStackNewMonorepoFixture({ importMetaUrl: import.meta.url, t, tmpPrefix: 'hstack-qa-default-placement-' });
  const repoDir = await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });
  await mkdir(join(repoDir, '.git'), { recursive: true });
  const producer = resolveRepoStackIdentity({ repoRoot: repoDir, stacksStorageRoot: fixture.storageDir }).stackName;
  const producerDir = join(fixture.storageDir, producer);
  await mkdir(producerDir, { recursive: true });
  await writeFile(join(producerDir, 'env'), 'HAPPIER_STACK_QA_DEFAULT_TARGET= QA-HOST \n');
  const producerPath = join(producerDir, 'dev-targets.json');
  await writeJsonAtomic(producerPath, { version: 3,
    targets: ['qa-host', 'builder'].map(name => ({ name, platform: 'posix', ssh: name, repoDir: `/mirror/${name}`, cliHomeDir: `/state/${name}/cli` })),
    runtimePlacement: { server: { mode: 'local' }, daemon: { mode: 'local' }, expo: { mode: 'local' }, qa: { mode: 'local' },
      build: { mode: 'prefer-target', targets: ['builder'] } }, commandExecution: { mode: 'local' },
  });
  const before = await readFile(producerPath);
  for (const [name, options] of [['agent-qa-default', []], ['qa-default', []], ['custom-default', ['--qa']]]) {
    const created = await fixture.runStackNew([name, ...options, '--no-copy-auth', '--json']);
    assert.equal(created.code, 0, created.stderr);
    const path = join(fixture.storageDir, name, 'dev-targets.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.runtimePlacement.server.target, 'qa-host');
    assert.equal(config.runtimePlacement.server.awaitingData, true, 'the first start initializes the pinned host data');
    assert.equal(config.runtimePlacement.daemon.target, 'qa-host');
    assert.deepEqual(config.runtimePlacement.qa.targets, ['qa-host']);
    assert.equal(config.commandExecution.target, 'qa-host');
    assert.equal(config.runtimePlacement.expo.mode, 'local');
    assert.equal(config.runtimePlacement.build, undefined, 'the producer retains build authority');
    const env = { ...fixture.baseEnv, ...parseEnvToObject(await fixture.readStackEnv(name)),
      HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: producer };
    assert.equal(env.HAPPIER_STACK_QA_DAEMON_TARGETS, 'qa-host');
    assert.equal(env.HAPPIER_STACK_QA_BROWSER_TARGETS, 'qa-host');
    assert.equal(env.HAPPIER_STACK_EXPO_SOURCE_STACK, producer);
    // The only mocked boundary is the remote host observation process.
    const boundaries = { runCaptureResult: async (_command, args) => {
      assert.ok(args.includes('--target=qa-host'));
      return { ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true,"unreservedMemoryKiB":16000000}\n', err: '' };
    } };
    const resolved = await resolveControlledRuntimePlacement({ stackName: name, stackBaseDir: join(fixture.storageDir, name), sourceDir: repoDir, env }, boundaries);
    assert.equal(resolved.target.name, 'qa-host');
    assert.equal(resolved.daemonTarget.name, 'qa-host');
    assert.equal((await resolveControlledQaBrowserTarget({ stackName: name, sourceDir: repoDir, env }, boundaries)).target.name, 'qa-host');
    await assert.rejects(resolveControlledRuntimePlacement({ stackName: name, sourceDir: repoDir, env }, {
      runCaptureResult: async () => ({ ok: false, exitCode: 255, err: 'unavailable' }), logger: { warn() {} },
    }), /persisted server placement is authoritative/);
    const retained = await readFile(path);
    const repeated = await fixture.runStackNew([name, '--qa', '--if-missing', '--json']);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(await readFile(path), retained);
  }
  const normal = await fixture.runStackNew(['normal-default', '--no-copy-auth', '--json']);
  assert.equal(normal.code, 0, normal.stderr);
  assert.doesNotMatch(await fixture.readStackEnv('normal-default'), /QA_DAEMON_TARGETS|QA_BROWSER_TARGETS/);
  await assert.rejects(readFile(join(fixture.storageDir, 'normal-default', 'dev-targets.json')), { code: 'ENOENT' });
  await writeFile(join(producerDir, 'env'), 'HAPPIER_STACK_QA_DEFAULT_TARGET=missing\n');
  const invalid = await fixture.runStackNew(['qa-invalid', '--no-copy-auth', '--json']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /unknown target/);
  await assert.rejects(readFile(join(fixture.storageDir, 'qa-invalid', 'env')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(producerPath), before);
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

test('hstack stack new --if-missing preserves an existing stack without changing its env', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-new-if-missing-',
  });
  await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });

  const stackName = 'existing-stack';
  const created = await fixture.runStackNew([stackName, '--no-copy-auth', '--json']);
  assert.equal(created.code, 0, `initial stack new failed\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`);

  const envPath = join(fixture.storageDir, stackName, 'env');
  await ensureEnvFileUpdated({
    envPath,
    updates: [{ key: 'SENTINEL', value: 'preserve-me' }],
  });
  const before = await fixture.readStackEnv(stackName);

  const ensured = await fixture.runStackNew([stackName, '--no-copy-auth', '--if-missing', '--json']);
  assert.equal(ensured.code, 0, `idempotent stack new failed\nstdout:\n${ensured.stdout}\nstderr:\n${ensured.stderr}`);
  assert.deepEqual(JSON.parse(ensured.stdout), {
    ok: true,
    created: false,
    stackName,
    envPath,
  });
  assert.equal(await fixture.readStackEnv(stackName), before);
});
