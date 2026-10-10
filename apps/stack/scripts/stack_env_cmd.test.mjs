import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';
import { resolveRemoteStackStatePaths } from './utils/dev_targets/remote_commands.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

async function createStackEnvFixture(t, { stackName = 'exp-test', initialEnv = 'FOO=bar\n' } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-env-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, initialEnv, 'utf-8');

  return {
    envPath,
    stackName,
    baseEnv: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    },
  };
}

test('hstack stack env set/unset writes to stack env file', async (t) => {
  const fixture = await createStackEnvFixture(t);

  const setRes = await runNodeCapture(
    [join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'set', 'OPENAI_API_KEY=sk-test'],
    { cwd: rootDir, env: fixture.baseEnv }
  );
  assert.equal(setRes.code, 0, `expected exit 0, got ${setRes.code}\nstdout:\n${setRes.stdout}\nstderr:\n${setRes.stderr}`);

  const afterSet = await readFile(fixture.envPath, 'utf-8');
  assert.ok(afterSet.includes('OPENAI_API_KEY=sk-test\n'), `expected env file to include OPENAI_API_KEY\n${afterSet}`);

  const unsetRes = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'unset', 'FOO'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(
    unsetRes.code,
    0,
    `expected exit 0, got ${unsetRes.code}\nstdout:\n${unsetRes.stdout}\nstderr:\n${unsetRes.stderr}`
  );

  const afterUnset = await readFile(fixture.envPath, 'utf-8');
  assert.ok(!afterUnset.includes('FOO=bar'), `expected env file to remove FOO\n${afterUnset}`);
});

test('hstack stack env <name> defaults to list', async (t) => {
  const fixture = await createStackEnvFixture(t);

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('FOO=bar'), `expected stdout to include FOO=bar\nstdout:\n${res.stdout}`);
});

test('hstack stack env set rejects invalid KEY=VALUE assignment form', async (t) => {
  const fixture = await createStackEnvFixture(t);

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'set', 'INVALID_ASSIGNMENT'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /expected KEY=VALUE/i, `expected invalid assignment guidance in stderr\n${res.stderr}`);
});

test('hstack stack env list fails for unknown stack', async (t) => {
  const fixture = await createStackEnvFixture(t, { stackName: 'known-stack' });
  const missingStack = 'missing-stack';

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', missingStack, 'list'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /does not exist yet/i, `expected missing stack error\n${res.stderr}`);
});

test('hstack stack env unset missing key is a no-op that keeps existing entries', async (t) => {
  const fixture = await createStackEnvFixture(t, { initialEnv: 'FOO=bar\nBAR=baz\n' });

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'unset', 'MISSING_KEY'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const afterUnset = await readFile(fixture.envPath, 'utf-8');
  assert.ok(afterUnset.includes('FOO=bar'), `expected existing key FOO to remain\n${afterUnset}`);
  assert.ok(afterUnset.includes('BAR=baz'), `expected existing key BAR to remain\n${afterUnset}`);
});

test('stack env shared-db opts a fresh QA stack into source server placement without copying secrets', async (t) => {
  const fixture = await createStackEnvFixture(t, { initialEnv: 'HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n' });
  const storage = fixture.baseEnv.HAPPIER_STACK_STORAGE_DIR;
  await mkdir(join(storage, 'dev'), { recursive: true });
  await writeFile(join(storage, 'dev', 'env'), 'HAPPIER_DB_PROVIDER=sqlite\nHANDY_MASTER_SECRET=fixture-only-secret\n');
  await writeFile(join(storage, 'dev', 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'mac-host', platform: 'posix', ssh: 'mac-host', repoDir: '/mirror', cliHomeDir: '/state/dev/cli', remoteServerPort: 43248 }],
    runtimePlacement: { server: { mode: 'prefer-target', target: 'mac-host', fallback: 'error' }, build: { mode: 'local' } } }));
  await writeFile(join(storage, fixture.stackName, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'mac-host', platform: 'posix', ssh: 'another-host', repoDir: '/other-mirror', cliHomeDir: '/other/dev/cli' },
      { name: 'own-worker', platform: 'posix', ssh: 'own-worker', repoDir: '/own-mirror', cliHomeDir: '/own/cli' }] }));
  const result = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'shared-db', 'dev', '--json'], { cwd: rootDir, env: fixture.baseEnv });
  assert.equal(result.code, 0, result.stderr);
  const written = await readFile(fixture.envPath, 'utf8');
  assert.match(written, /HAPPIER_STACK_SHARED_DB_SOURCE_STACK=dev/);
  assert.match(written, /HAPPIER_STACK_RUNTIME_MODE=require/);
  assert.match(written, /HAPPIER_SQLITE_AUTO_MIGRATE=0/);
  assert.match(written, /METRICS_ENABLED=false/);
  assert.doesNotMatch(written + result.stdout + result.stderr, /fixture-only-secret/);
  const config = JSON.parse(await readFile(join(storage, fixture.stackName, 'dev-targets.json'), 'utf8'));
  assert.equal(config.runtimePlacement.server.target, 'mac-host');
  assert.equal(config.runtimePlacement.daemon, undefined, 'fresh shared QA must not manufacture a local daemon pin');
  assert.equal(config.runtimePlacement.qa, undefined, 'the shared preset must inherit the QA command pool rather than pin a local runtime');
  assert.equal(config.targets.find(target => target.name === 'mac-host').ssh, 'mac-host');
  assert.equal(config.targets.find(target => target.name === 'mac-host').cliHomeDir, '/state/dev/cli');
  assert.equal(config.targets.find(target => target.name === 'mac-host').remoteServerPort, null,
    'QA must allocate its own remote server port rather than reuse the source listener');
  assert.equal(config.targets.find(target => target.name === 'own-worker').ssh, 'own-worker');
  const sourceTarget = config.targets.find(target => target.name === 'mac-host');
  const sourceEnvPath = resolveRemoteStackStatePaths(sourceTarget, { stackName: 'dev' }).stackEnvPath;
  assert.ok(written.includes(`HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE=${sourceEnvPath}\n`),
    'shared database reference must follow the active source remote-state owner');
  assert.ok(!written.includes('HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE=/state/dev/env\n'),
    'the retained top-level copy is not the source server authority');
  config.runtimePlacement.daemon = { mode: 'local' };
  await writeFile(join(storage, fixture.stackName, 'dev-targets.json'), JSON.stringify(config));
  const repeated = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'shared-db', 'dev', '--json'], { cwd: rootDir, env: fixture.baseEnv });
  assert.equal(repeated.code, 0, repeated.stderr);
  const pinned = JSON.parse(await readFile(join(storage, fixture.stackName, 'dev-targets.json'), 'utf8'));
  assert.deepEqual(pinned.runtimePlacement.daemon, { mode: 'local' }, 'an existing explicit daemon placement remains authoritative');

  // Existing shared consumers retain private state during a source provider switch.
  const retained = join(storage, fixture.stackName, 'server-light');
  await mkdir(retained, { recursive: true });
  await writeFile(join(retained, 'private-state'), 'retained QA state');
  // The controller carries only provider metadata; the URL stays on the source host.
  await writeFile(join(storage, 'dev', 'env'), 'HAPPIER_DB_PROVIDER=postgres\nHANDY_MASTER_SECRET=fixture-only-secret\n');
  const activated = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'shared-db', 'dev', '--json'], { cwd: rootDir, env: fixture.baseEnv });
  assert.equal(activated.code, 0, activated.stderr);
  const postgresConsumer = await readFile(fixture.envPath, 'utf8');
  assert.doesNotMatch(postgresConsumer + activated.stdout + activated.stderr, /fixture-pg-secret|fixture-only-secret|DATABASE_URL=/);
  assert.equal(await readFile(join(retained, 'private-state'), 'utf8'), 'retained QA state');
  assert.deepEqual(JSON.parse(await readFile(join(storage, fixture.stackName, 'dev-targets.json'), 'utf8')).runtimePlacement.daemon, { mode: 'local' });

  // After a host move, a local source env owns the database and file settings.
  await writeFile(join(storage, 'dev', 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [], runtimePlacement: { server: { mode: 'local' } } }));
  const local = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'shared-db', 'dev', '--json'], { cwd: rootDir, env: fixture.baseEnv });
  assert.equal(local.code, 0, local.stderr);
  const localEnv = await readFile(fixture.envPath, 'utf8');
  const localConfig = JSON.parse(await readFile(join(storage, fixture.stackName, 'dev-targets.json'), 'utf8'));
  assert.ok(localEnv.includes(`HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE=${join(storage, 'dev', 'env')}\n`));
  assert.deepEqual(localConfig.runtimePlacement.server, { mode: 'local' });
  assert.deepEqual(localConfig.runtimePlacement.daemon, { mode: 'local' });
  assert.equal(localConfig.targets.find(target => target.name === 'own-worker').ssh, 'own-worker');
  assert.doesNotMatch(localEnv + local.stdout + local.stderr, /fixture-only-secret|DATABASE_URL=/);
  assert.equal(await readFile(join(retained, 'private-state'), 'utf8'), 'retained QA state');

  // A retained standalone consumer is still refused; same-source replay is the only exception.
  await writeFile(fixture.envPath, 'HAPPIER_DB_PROVIDER=sqlite\n');
  const refused = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'shared-db', 'dev', '--json'], { cwd: rootDir, env: fixture.baseEnv });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /fresh consumer|retained server data/);
});
