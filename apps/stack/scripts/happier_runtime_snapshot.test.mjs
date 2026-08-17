import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

async function createSourceCliFixture(t, options = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-cli-fixture-' });
  const repoRoot = join(fixture.root, 'repo');
  const entrypointDir = options.entrypointDir ?? 'dist';
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/app" }\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server" }\n', 'utf8');
  await writeStubHappierCliFiles(repoRoot, {
    packageJsonContent: '{ "name": "@happier-dev/cli" }\n',
    distIndexScript: options.cliSource ?? 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
    binHappierScript: `import '../${entrypointDir}/index.mjs';\n`,
  });
  return { repoRoot };
}

async function createTsxSourceCliFixture(t, options = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-tsx-source-cli-fixture-' });
  const repoRoot = join(fixture.root, 'repo');
  await mkdir(join(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{ "name": "@happier-dev/cli" }\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/app" }\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server" }\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{ "compilerOptions": { "target": "ES2022" } }\n', 'utf8');
  await writeFile(
    join(repoRoot, 'apps', 'cli', 'src', 'index.ts'),
    options.cliSource ??
      [
        'process.stdout.write(JSON.stringify({',
        '  tsconfigPath: process.env.TSX_TSCONFIG_PATH ?? null,',
        '  args: process.argv.slice(2),',
        '}) + "\\n");',
        '',
      ].join('\n'),
    'utf8',
  );
  return { repoRoot };
}

test('hstack happier uses the active runtime snapshot when runtime mode is required', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
    cliEntrypoint: 'cli/happier.mjs',
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
    ...process.env,
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
    ...process.env,
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

test('hstack happier projects admitted runtime provenance to the nested runtime CLI', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, {
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
    ...process.env,
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
  assert.equal(payload.entryPath, join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'));
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

test('hstack happier source repo override detaches stale inherited stack env', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const stale = await createRuntimeSnapshotFixture(t, {
    stackName: 'stale-stack',
    cliEntrypoint: 'cli/happier.mjs',
    cliStdout: 'STALE SNAPSHOT SHOULD NOT RUN',
  });
  await writeFile(
    join(stale.stackDir, 'env'),
    [
      `HAPPIER_STACK_REPO_DIR=${stale.root}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(stale.stackDir, 'cli')}`,
      'HAPPIER_STACK_RUNTIME_MODE=require',
      '',
    ].join('\n'),
    'utf8',
  );

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

  const env = {
    ...process.env,
    HAPPIER_STACK_ENV_FILE: join(stale.stackDir, 'env'),
    HAPPIER_STACK_STACK: stale.stackName,
    HAPPIER_STACK_STORAGE_DIR: stale.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_CLI_HOME_DIR: join(stale.stackDir, 'cli'),
    HAPPIER_HOME_DIR: join(stale.stackDir, 'cli'),
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), 'service', 'install', '--dry-run', '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.argvEntryPath, join(fixture.repoRoot, 'apps', 'cli', 'dist', 'index.mjs'));
  assert.deepEqual(payload.args, ['service', 'install', '--dry-run', '--json']);
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
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SHELL: process.env.SHELL,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    HAPPIER_STACK_HOME_DIR: join(fixture.repoRoot, '.happier-stack-home'),
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
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
    ...process.env,
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
    HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/stale/runtime/index.mjs',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'abcdef1234567890',
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--source', '--version'], { cwd: rootDir, env });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { runtimeBacked: null, fingerprint: null });
});

test('hstack happier source mode overrides stale TSX_TSCONFIG_PATH for the selected checkout', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createTsxSourceCliFixture(t);
  const staleTsconfigPath = join(fixture.repoRoot, 'stale-tsconfig.json');
  await writeFile(staleTsconfigPath, '{ "compilerOptions": { "target": "ES2020" } }\n', 'utf8');

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SHELL: process.env.SHELL,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    HAPPIER_STACK_HOME_DIR: join(fixture.repoRoot, '.happier-stack-home'),
    HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    HAPPIER_HOME_DIR: join(fixture.repoRoot, '.happy-home'),
    TSX_TSCONFIG_PATH: staleTsconfigPath,
  };

  const res = await runNode([join(rootDir, 'scripts', 'happier.mjs'), '--source', 'providers', 'list', '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.tsconfigPath, join(fixture.repoRoot, 'apps', 'cli', 'tsconfig.json'));
  assert.deepEqual(payload.args, ['providers', 'list', '--json']);
});
