import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { buildRemoteStackCommand, resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { parseEnvToObject } from '../env/dotenv.mjs';

const execFileAsync = promisify(execFile);

async function remoteEnvironmentFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-remote-env-' });
  const target = { name: 'fixture', platform: 'posix', repoDir: fixture.path('repo'), cliHomeDir: fixture.path('remote') };
  await mkdir(target.repoDir);
  await mkdir(fixture.path('repo/apps/stack/scripts/utils'), { recursive: true });
  // The fixture replaces service processes; log observation is another OS
  // process boundary and has its own real-runtime coverage.
  await mkdir(fixture.path('repo/apps/stack/scripts/utils/dev_targets'), { recursive: true });
  await writeFile(fixture.path('repo/apps/stack/scripts/utils/dev_targets/runtime_observer.mjs'), '');
  await symlink(new URL('../env', import.meta.url), fixture.path('repo/apps/stack/scripts/utils/env'), 'dir');
  const options = { stackName: 'operator-env', services: { daemon: true }, serverUrl: 'http://127.0.0.1:43001',
    env: { HAPPIER_STACK_ENV_FILE: fixture.path('controller.env'), SHELL_ONLY_SETTING: 'inherited' } };
  const paths = resolveRemoteStackStatePaths(target, options);
  // Only the external process launcher is replaced. Its env mutation uses the
  // same real writer as stack env set, and the service reads the real parser.
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'pnpm', content: `#!/usr/bin/env node
(async () => {
  const fs = require('node:fs/promises');
  const { ensureEnvFileUpdated } = await import(${JSON.stringify(new URL('../env/env_file.mjs', import.meta.url).href)});
  const args = process.argv.slice(process.argv.indexOf('stack') + 1);
  if (args[0] === 'env') {
    await ensureEnvFileUpdated({ envPath: ${JSON.stringify(paths.stackEnvPath)}, updates: args.slice(3).map(entry => {
      const equals = entry.indexOf('='); return { key: entry.slice(0, equals), value: entry.slice(equals + 1) };
    }) });
  }
  if (args[0] === 'dev') await fs.writeFile(${JSON.stringify(fixture.path('service.env'))}, await fs.readFile(${JSON.stringify(paths.stackEnvPath)}));
})().catch(() => process.exit(1));
` });
  target.remotePath = [binDir];
  return { fixture, target, options, paths };
}

test('placed services receive only operator stack env and retain target-owned placement', async t => {
  const { fixture, target, options, paths } = await remoteEnvironmentFixture(t);
  const operatorValue = `spaces ' quotes $() and = signs`;
  const privateValue = randomUUID();
  await mkdir(dirname(paths.stackEnvPath), { recursive: true });
  await writeFile(paths.stackEnvPath, `TARGET_ONLY_SETTING=obsolete\nHAPPIER_STACK_AUTO_AUTH_SEED=0\nHAPPIER_STACK_AUTH_SEED_FROM=worker-seed\nS3_ACCESS_KEY=${privateValue}\nHAPPIER_SERVER_LIGHT_DATA_DIR=/worker/data\nHAPPIER_MANAGED_NODE_BIN=/removed/legacy-node\n`);
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, [
    `OPERATOR_SETTING=${operatorValue}`,
    'OPERATOR.DOTTED=retained',
    `OPERATOR_SECRET=${privateValue}`,
    'GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=http.sslVerify', 'GIT_CONFIG_VALUE_0=true',
    'HAPPIER_STACK_REPO_DIR=/controller/repo', 'HAPPIER_STACK_CLI_HOME_DIR=/controller/cli',
    'HAPPIER_STACK_STORAGE_DIR=/controller/storage', 'HAPPIER_STACK_ENV_FILE=/controller/env',
    'HAPPIER_STACK_SERVER_PORT=49999', 'HAPPIER_DEV_TARGET_EXECUTION=0',
  ].join('\n'));
  const command = buildRemoteStackCommand(target, options);
  const result = await execFileAsync('/bin/bash', ['-c', command]);
  assert.equal((result.stdout + result.stderr).includes(privateValue), false);
  let observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.OPERATOR_SETTING === operatorValue, true, 'operator value round-trips through the service env');
  assert.equal(observed['OPERATOR.DOTTED'], 'retained', 'forward names accepted by the canonical stack env writer');
  assert.equal(observed.OPERATOR_SECRET === privateValue, true, 'explicit private values reach the service');
  assert.equal(observed.HAPPIER_STACK_AUTO_AUTH_SEED, '0');
  assert.equal(observed.HAPPIER_STACK_AUTH_SEED_FROM, 'worker-seed');
  assert.equal(observed.S3_ACCESS_KEY === privateValue, true);
  assert.equal(observed.HAPPIER_SERVER_LIGHT_DATA_DIR, '/worker/data');
  assert.equal(observed.GIT_CONFIG_COUNT, '1');
  assert.equal(observed.GIT_CONFIG_KEY_0 === 'http.sslVerify', true);
  assert.equal(observed.SHELL_ONLY_SETTING, undefined);
  assert.equal(observed.HAPPIER_STACK_REPO_DIR === target.repoDir, true);
  assert.equal(observed.HAPPIER_STACK_CLI_HOME_DIR === paths.cliHomeDir, true);
  assert.equal(observed.HAPPIER_STACK_STORAGE_DIR, undefined);
  assert.equal(observed.HAPPIER_STACK_ENV_FILE, undefined);
  assert.equal(observed.HAPPIER_STACK_SERVER_PORT, undefined);
  assert.equal(observed.HAPPIER_DEV_TARGET_EXECUTION, '1');
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, 'OPERATOR_SETTING=changed\n');
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.OPERATOR_SETTING === 'changed', true);
  assert.equal(observed['OPERATOR.DOTTED'], undefined, 'withdrawing an operator key removes its previous projection');
  assert.equal(observed.GIT_CONFIG_COUNT, undefined);
  assert.equal(observed.TARGET_ONLY_SETTING, undefined);
  assert.equal(observed.HAPPIER_MANAGED_NODE_BIN, undefined);
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, '');
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.OPERATOR_SETTING, undefined, 'an empty operator file also withdraws keys');
  assert.equal(observed.HAPPIER_STACK_AUTO_AUTH_SEED, '0');
  assert.equal(observed.HAPPIER_STACK_AUTH_SEED_FROM, 'worker-seed');
  assert.equal(observed.S3_ACCESS_KEY === privateValue, true);
});

test('operator relay opt-out does not grant a placed consumer control of its host relay', async t => {
  const { fixture, target, options } = await remoteEnvironmentFixture(t);
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, 'HAPPIER_STACK_IROH_RELAY=0\n');
  options.env.HAPPIER_IROH_RELAY_POLICY = 'disabled';
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  const observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.HAPPIER_STACK_IROH_RELAY, undefined);
  assert.equal(observed.HAPPIER_IROH_RELAY_POLICY, 'disabled');
  assert.equal(observed.HAPPIER_IROH_RELAY_URLS, '');
});

test('a stale explicit managed Node override fails before mutation with its configured path', async t => {
  const { fixture, target, options, paths } = await remoteEnvironmentFixture(t);
  const configuredPath = fixture.path('missing managed node');
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, `HAPPIER_MANAGED_NODE_BIN=${configuredPath}\n`);
  await assert.rejects(execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]), error => {
    const failure = JSON.parse(error.stderr.trim()).error;
    assert.equal(failure.code, 'remote_stack_env_path_unavailable');
    assert.equal(failure.variable, 'HAPPIER_MANAGED_NODE_BIN');
    assert.equal(failure.path, configuredPath);
    assert.equal(failure.reason, 'not_found');
    assert.equal(failure.retryable, false);
    return true;
  });
  await assert.rejects(readFile(paths.stackEnvPath), { code: 'ENOENT' });
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, `HAPPIER_MANAGED_NODE_BIN=${process.execPath}\n`);
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  const observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.HAPPIER_MANAGED_NODE_BIN, process.execPath);
});

test('placed services refuse missing target files with a typed value-free error before env mutation', async t => {
  const { fixture, target, options, paths } = await remoteEnvironmentFixture(t);
  const targetFile = fixture.path('trust certificate.pem');
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, `NODE_EXTRA_CA_CERTS=${targetFile}\n`);
  await assert.rejects(execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]), error => {
    const failure = JSON.parse(error.stderr.trim());
    assert.equal(failure.error.code, 'remote_stack_env_path_unavailable');
    assert.equal(failure.error.variable, 'NODE_EXTRA_CA_CERTS');
    assert.equal(failure.error.retryable, false);
    assert.equal(error.stderr.includes(targetFile), false);
    return true;
  });
  await assert.rejects(readFile(paths.stackEnvPath), { code: 'ENOENT' });
  await writeFile(targetFile, 'public certificate fixture');
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  const observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.NODE_EXTRA_CA_CERTS === targetFile, true);
  await writeFile(`${target.repoDir}/relative-ca.pem`, 'public certificate fixture');
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, 'NODE_EXTRA_CA_CERTS=relative-ca.pem\n');
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  const relativeObserved = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(relativeObserved.NODE_EXTRA_CA_CERTS === `${target.repoDir}/relative-ca.pem`, true,
    'relative file settings must keep their target repository meaning after a service changes cwd');
  const missingGitFile = 'missing Git CA.pem';
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE,
    `GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=http.sslCAInfo\nGIT_CONFIG_VALUE_0=${missingGitFile}\n`);
  await assert.rejects(execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]), error => {
    const failure = JSON.parse(error.stderr.trim());
    assert.equal(failure.error.code, 'remote_stack_env_path_unavailable');
    assert.equal(failure.error.variable, 'GIT_CONFIG_VALUE_0');
    assert.equal(error.stderr.includes(missingGitFile), false);
    return true;
  });
});

test('operator values are not assumed to be paths, while every module search directory is checked', async t => {
  const { fixture, target, options } = await remoteEnvironmentFixture(t);
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, 'HTTP_PREFIX=/api\n');
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  const observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.HTTP_PREFIX, '/api');
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, 'GIT_CONFIG_GLOBAL=/dev/null\n');
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  await mkdir(fixture.path('library'));
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, `NODE_PATH=${fixture.path('library')}:missing-library\n`);
  await assert.rejects(execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]), error => {
    assert.equal(JSON.parse(error.stderr.trim()).error.variable, 'NODE_PATH');
    return true;
  });
});

test('Windows placed command carries operator env, protects placement, and checks files before initialization', async t => {
  const { target, options } = await remoteEnvironmentFixture(t);
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, 'OPERATOR_SETTING=windows\nnode_extra_ca_certs=C:/trust/ca.pem\nHAPPIER_STACK_REPO_DIR=C:/controller\nhappier_stack_repo_dir=C:/controller-lower\n');
  const encoded = buildRemoteStackCommand({ ...target, platform: 'windows' }, options);
  const command = Buffer.from(encoded.split(' ').at(-1), 'base64').toString('utf16le');
  assert.equal(command.includes('OPERATOR_SETTING=windows'), true);
  assert.equal(command.includes('HAPPIER_STACK_REPO_DIR=C:/controller'), false);
  assert.equal(command.includes('C:/controller-lower'), false);
  assert.equal(command.includes('node_extra_ca_certs='), false);
  assert.equal(command.includes('NODE_EXTRA_CA_CERTS='), true);
  assert.equal(command.includes('remote_stack_env_path_unavailable'), true);
  assert.equal(command.indexOf('remote_stack_env_path_unavailable') < command.indexOf('stack new'), true);
});

test('operator SQLite paths stay target-owned while network database URLs are projected', async t => {
  const { fixture, target, options, paths } = await remoteEnvironmentFixture(t);
  const workerDatabaseUrl = 'file:/worker/retained/happier-server-light.sqlite';
  await mkdir(dirname(paths.stackEnvPath), { recursive: true });
  await writeFile(paths.stackEnvPath, `DATABASE_URL=${workerDatabaseUrl}\n`);
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE,
    'DATABASE_URL=file:/controller/retained/happier-server-light.sqlite\n');
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  let observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.DATABASE_URL, workerDatabaseUrl, 'a controller file URL cannot relocate the target database');

  const networkDatabaseUrl = 'postgresql://operator@database.example.test/qa';
  await writeFile(options.env.HAPPIER_STACK_ENV_FILE, `DATABASE_URL=${networkDatabaseUrl}\n`);
  await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, options)]);
  observed = parseEnvToObject(await readFile(fixture.path('service.env'), 'utf8'));
  assert.equal(observed.DATABASE_URL, networkDatabaseUrl, 'network database configuration still reaches the placed service');
});
