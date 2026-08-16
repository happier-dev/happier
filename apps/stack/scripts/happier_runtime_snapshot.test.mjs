import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

async function createSourceCliFixture(t, options = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-cli-fixture-' });
  const repoRoot = join(fixture.root, 'repo');
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/app" }\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server" }\n', 'utf8');
  await writeStubHappierCliFiles(repoRoot, {
    packageJsonContent: '{ "name": "@happier-dev/cli" }\n',
    distIndexScript: options.cliSource ?? 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
  });
  return { repoRoot };
}

test('hstack happier uses the active runtime snapshot when runtime mode is required', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'main',
    cliEntrypoint: 'cli/happier.mjs',
  });

  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_HOME_DIR: join(fixture.root, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /SNAPSHOT CLI HELP/);
});

test('hstack happier uses source CLI for an active source-backed stack even when stack env requires snapshots', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const runtimeFixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'source-dev',
    cliEntrypoint: 'cli/happier.mjs',
  });
  const sourceFixture = await createSourceCliFixture(t, {
    cliSource: 'process.stdout.write("SOURCE CLI HELP\\n");\n',
  });
  await writeFile(join(runtimeFixture.stackDir, 'stack.runtime.json'), `${JSON.stringify({
    version: 1,
    stackName: runtimeFixture.stackName,
    script: 'dev.mjs',
    ownerPid: process.pid,
    runtimeSnapshotId: null,
  })}\n`, 'utf8');

  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_STACK: runtimeFixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: runtimeFixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(runtimeFixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: sourceFixture.repoRoot,
    HAPPIER_HOME_DIR: join(runtimeFixture.root, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /SOURCE CLI HELP/);
  assert.doesNotMatch(res.stdout, /SNAPSHOT CLI HELP/);

  const explicitRuntimeRes = await runNode(
    [join(rootDir, 'scripts', 'happier.mjs'), '--runtime', '--help'],
    { cwd: rootDir, env },
  );
  assert.equal(
    explicitRuntimeRes.code,
    0,
    `stderr:\n${explicitRuntimeRes.stderr}\nstdout:\n${explicitRuntimeRes.stdout}`,
  );
  assert.match(explicitRuntimeRes.stdout, /SNAPSHOT CLI HELP/);
});

test('hstack happier does not let stale source-backed runtime state weaken required snapshot mode', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const runtimeFixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'stale-source-dev',
    cliEntrypoint: 'cli/happier.mjs',
  });
  const sourceFixture = await createSourceCliFixture(t, {
    cliSource: 'process.stdout.write("SOURCE CLI HELP\\n");\n',
  });
  await writeFile(join(runtimeFixture.stackDir, 'stack.runtime.json'), `${JSON.stringify({
    version: 1,
    stackName: runtimeFixture.stackName,
    script: 'dev.mjs',
    ownerPid: 999_999_999,
    runtimeSnapshotId: null,
  })}\n`, 'utf8');

  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_STACK: runtimeFixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: runtimeFixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(runtimeFixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: sourceFixture.repoRoot,
    HAPPIER_HOME_DIR: join(runtimeFixture.root, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /SNAPSHOT CLI HELP/);
  assert.doesNotMatch(res.stdout, /SOURCE CLI HELP/);
});

test('hstack happier runs runtime snapshot JS entrypoints through node', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'main',
    cliEntrypoint: 'cli/happier.mjs',
    cliStdout: 'SNAPSHOT CLI JS HELP',
  });

  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_HOME_DIR: join(fixture.root, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /SNAPSHOT CLI JS HELP/);
});

test('hstack happier projects admitted runtime provenance to the nested runtime CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'main',
    cliEntrypoint: 'cli/happier.mjs',
    cliSource: [
      'process.stdout.write(JSON.stringify({',
      '  runtimeBacked: process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED ?? null,',
      '  distEntrypoint: process.env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT ?? null,',
      '  fingerprint: process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT ?? null,',
      '}) + "\\n");',
    ].join('\n'),
  });
  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_HOME_DIR: join(fixture.root, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--version'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.runtimeBacked, '1');
  assert.equal(payload.distEntrypoint, join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'));
  assert.match(payload.fingerprint, /^[a-f0-9]{16}$/);
});

test('hstack happier does not forward --runtime to the wrapped runtime CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'main',
    cliEntrypoint: 'cli/happier.mjs',
    cliSource: 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
  });

  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_HOME_DIR: join(fixture.root, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--runtime', 'session', 'run', 'list'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.deepEqual(JSON.parse(res.stdout.trim()), ['session', 'run', 'list']);
});

test('hstack happier forwards snapshot-aware daemon service runtime paths to the wrapped CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'main',
    cliEntrypoint: 'cli/happier.mjs',
    cliSource: [
      'process.stdout.write(JSON.stringify({',
      '  argv: process.argv.slice(2),',
      '  homeDir: process.env.HAPPIER_HOME_DIR ?? null,',
      '  nodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? null,',
      '  entryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? null,',
      '}) + "\\n");',
    ].join('\n'),
  });
  const runtimeBinary = join(fixture.root, 'runtime-bin', 'happier-js-runtime');
  await mkdir(dirname(runtimeBinary), { recursive: true });
  await writeFile(runtimeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(runtimeBinary, 0o755);

  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_HOME_DIR: join(fixture.root, '.happy-home'),
    HAPPIER_JS_RUNTIME_PATH: runtimeBinary,
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), 'service', 'install', '--dry-run', '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.deepEqual(JSON.parse(res.stdout.trim()), {
    argv: ['service', 'install', '--dry-run', '--json'],
    homeDir: join(fixture.stackDir, 'cli'),
    nodePath: runtimeBinary,
    entryPath: join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'),
  });
});

test('hstack happier does not forward --source to the wrapped source CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createSourceCliFixture(t);

  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--source', 'session', 'run', 'list'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.deepEqual(JSON.parse(res.stdout.trim()), ['session', 'run', 'list']);
});

test('hstack happier source mode clears stale inherited runtime provenance', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createSourceCliFixture(t, {
    cliSource: 'process.stdout.write(JSON.stringify({ runtimeBacked: process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED ?? null, fingerprint: process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT ?? null }) + "\\n");\n',
  });
  const env = {
    ...sanitizeStackTestRunnerEnv(process.env),
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
    HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/stale/runtime/index.mjs',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'abcdef1234567890',
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--source', '--version'], { cwd: rootDir, env });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { runtimeBacked: null, fingerprint: null });
});
