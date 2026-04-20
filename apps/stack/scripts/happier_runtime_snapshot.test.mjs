import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

async function createSourceCliFixture(t, options = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-cli-fixture-' });
  const repoRoot = join(fixture.root, 'repo');
  const entrypointDir = options.entrypointDir ?? 'dist';
  await mkdir(join(repoRoot, 'apps', 'cli', entrypointDir), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{ "name": "@happier-dev/cli" }\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/app" }\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server" }\n', 'utf8');
  await writeFile(
    join(repoRoot, 'apps', 'cli', entrypointDir, 'index.mjs'),
    options.cliSource ?? 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
    'utf8',
  );
  return { repoRoot };
}

test('hstack happier uses the active runtime snapshot when runtime mode is required', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);

  const env = {
    ...process.env,
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

test('hstack happier runs runtime snapshot JS entrypoints through node', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    cliEntrypoint: 'cli/happier.mjs',
    cliStdout: 'SNAPSHOT CLI JS HELP',
  });

  const env = {
    ...process.env,
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

test('hstack happier forwards snapshot-aware daemon service runtime paths to the wrapped CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    cliEntrypoint: 'cli/happier.mjs',
    cliSource: [
      'process.stdout.write(JSON.stringify({',
      '  homeDir: process.env.HAPPIER_HOME_DIR ?? null,',
      '  nodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? null,',
      '  entryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? null,',
      '}) + "\\n");',
      '',
    ].join('\n'),
  });
  const explicitRuntimePath = join(fixture.root, 'runtime', 'bin', 'happier-js-runtime');
  await mkdir(dirname(explicitRuntimePath), { recursive: true });
  await writeFile(explicitRuntimePath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(explicitRuntimePath, 0o755);

  const env = {
    ...process.env,
    HAPPIER_JS_RUNTIME_PATH: explicitRuntimePath,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_HOME_DIR: join(fixture.root, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), 'service', 'install', '--dry-run', '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.homeDir, join(fixture.stackDir, 'cli'));
  assert.equal(payload.nodePath, explicitRuntimePath);
  assert.equal(payload.entryPath, join(fixture.stackDir, 'runtime', 'current', 'cli', 'package-dist', 'index.mjs'));
});

test('hstack happier forwards dist daemon service runtime paths for source checkouts when dist is available', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createSourceCliFixture(t, {
    entrypointDir: 'dist',
    cliSource: [
      'process.stdout.write(JSON.stringify({',
      '  argvEntryPath: process.argv[1] ?? null,',
      '}) + "\\n");',
      '',
    ].join('\n'),
  });
  await mkdir(join(fixture.repoRoot, 'apps', 'cli', 'package-dist'), { recursive: true });
  await writeFile(
    join(fixture.repoRoot, 'apps', 'cli', 'package-dist', 'index.mjs'),
    [
      'process.stdout.write(JSON.stringify({',
      "  argvEntryPath: 'package-dist-should-not-run',",
      '}) + "\\n");',
      '',
    ].join('\n'),
    'utf8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), 'service', 'install', '--dry-run', '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.argvEntryPath, join(fixture.repoRoot, 'apps', 'cli', 'dist', 'index.mjs'));
});

test('hstack happier falls back to dist when package-dist exists but is incomplete in a source checkout', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createSourceCliFixture(t, {
    entrypointDir: 'dist',
    cliSource: [
      'process.stdout.write(JSON.stringify({',
      '  argvEntryPath: process.argv[1] ?? null,',
      '}) + "\\n");',
      '',
    ].join('\n'),
  });
  await mkdir(join(fixture.repoRoot, 'apps', 'cli', 'package-dist'), { recursive: true });
  await writeFile(
    join(fixture.repoRoot, 'apps', 'cli', 'package-dist', 'index.mjs'),
    "import './missing-package-dist-chunk.mjs';\nexport {};\n",
    'utf8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), 'service', 'install', '--dry-run', '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.argvEntryPath, join(fixture.repoRoot, 'apps', 'cli', 'dist', 'index.mjs'));
});

test('hstack happier falls back to dist when package-dist has stale sibling chunks in a source checkout', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createSourceCliFixture(t, {
    entrypointDir: 'dist',
    cliSource: [
      'process.stdout.write(JSON.stringify({',
      '  argvEntryPath: process.argv[1] ?? null,',
      '  args: process.argv.slice(2),',
      '}) + "\\n");',
      '',
    ].join('\n'),
  });
  await mkdir(join(fixture.repoRoot, 'apps', 'cli', 'package-dist'), { recursive: true });
  await writeFile(
    join(fixture.repoRoot, 'apps', 'cli', 'package-dist', 'index.mjs'),
    [
      'const args = process.argv.slice(2);',
      "if (args[0] === 'probe-stale-runtime') {",
      "  const staleCatalogSpecifier = './catalog-stale.mjs';",
      '  await import(staleCatalogSpecifier);',
      '}',
      'process.stdout.write(JSON.stringify({',
      '  argvEntryPath: process.argv[1] ?? null,',
      '  args,',
      '}) + "\\n");',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(fixture.repoRoot, 'apps', 'cli', 'package-dist', 'catalog-stale.mjs'),
    "import './geminiRuntimeCore-stale.mjs';\nexport {};\n",
    'utf8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), 'probe-stale-runtime'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.argvEntryPath, join(fixture.repoRoot, 'apps', 'cli', 'dist', 'index.mjs'));
  assert.deepEqual(payload.args, ['probe-stale-runtime']);
});

test('hstack happier does not forward --runtime to the wrapped runtime CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    cliEntrypoint: 'cli/happier.mjs',
    cliSource: 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
  });

  const env = {
    ...process.env,
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

test('hstack happier does not forward --source to the wrapped source CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createSourceCliFixture(t);

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--source', 'session', 'run', 'list'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.deepEqual(JSON.parse(res.stdout.trim()), ['session', 'run', 'list']);
});
