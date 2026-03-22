import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function writeExecutable(path, contents) {
  return writeFile(path, contents, { mode: 0o755 });
}

function runSwiftbar(scriptPath, { env }) {
  return spawnSync('bash', [scriptPath], {
    cwd: dirname(scriptPath),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function runBashInline(script, { cwd, env }) {
  return spawnSync('bash', ['-lc', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('SwiftBar stack status uses server-scoped daemon state and canonical stack service label', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const stackRoot = dirname(scriptsDir);
  const swiftbarScript = join(stackRoot, 'extras', 'swiftbar', 'hstack.5s.sh');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-runtime-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const fakeHome = join(tmp, 'home');
  const fakeBin = join(tmp, 'bin');
  const storageDir = join(tmp, 'stacks');
  const stackName = 'dev-built';
  const stackDir = join(storageDir, stackName);
  const cliHome = join(stackDir, 'cli');
  const scopedServerDir = join(cliHome, 'servers', 'stack_dev-built__id_default');
  const envFile = join(stackDir, 'env');
  const plistPath = join(fakeHome, 'Library', 'LaunchAgents', 'dev.happier.stack.dev-built.plist');

  await mkdir(fakeBin, { recursive: true });
  await mkdir(scopedServerDir, { recursive: true });
  await mkdir(dirname(plistPath), { recursive: true });

  await writeExecutable(
    join(fakeBin, 'launchctl'),
    '#!/bin/bash\n' +
      'if [[ "${1:-}" == "list" ]]; then\n' +
      '  printf -- "-\\t0\\tdev.happier.stack.dev-built\\n"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n'
  );
  await writeExecutable(
    join(fakeBin, 'curl'),
    '#!/bin/bash\n' +
      'printf "{\\"status\\":\\"ok\\"}\\n"\n'
  );

  await writeFile(plistPath, '<plist></plist>\n', 'utf8');
  await writeFile(
    envFile,
    [
      'HAPPIER_STACK_STACK=dev-built',
      'HAPPIER_STACK_SERVER_PORT=23456',
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHome}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(scopedServerDir, 'daemon.state.json'),
    JSON.stringify({ pid: process.pid }) + '\n',
    'utf8'
  );

  const res = runSwiftbar(swiftbarScript, {
    env: {
      HOME: fakeHome,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_CLI_ROOT_DIR: stackRoot,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_ENV_FILE: envFile,
      HAPPIER_STACK_SWIFTBAR_PRIMARY_STACK: stackName,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_MENUBAR_MODE: 'selfhost',
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    },
  });
  const helperRes = runBashInline(
    [
      'source extras/swiftbar/lib/utils.sh',
      'source extras/swiftbar/lib/system.sh',
      `resolve_preferred_daemon_state_pair '${cliHome}'`,
    ].join('; '),
    {
      cwd: stackRoot,
      env: {
        HOME: fakeHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        HAPPIER_STACK_CLI_ROOT_DIR: stackRoot,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_ENV_FILE: envFile,
        HAPPIER_STACK_SWIFTBAR_PRIMARY_STACK: stackName,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_MENUBAR_MODE: 'selfhost',
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    }
  );

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(helperRes.status, 0, `helper stderr:\n${helperRes.stderr}`);
  assert.match(
    helperRes.stdout.trim(),
    /cli\/servers\/stack_dev-built__id_default\/daemon\.state\.json\|.*daemon\.state\.json\.lock$/,
    `helper stdout:\n${helperRes.stdout}`
  );
  assert.match(res.stdout, /Daemon \| sfimage=checkmark\.circle\.fill/, `stdout:\n${res.stdout}`);
  assert.match(res.stdout, /--Status: running/, `stdout:\n${res.stdout}`);
  assert.match(res.stdout, /--State file: /, `stdout:\n${res.stdout}`);
  assert.match(res.stdout, /Autostart \| sfimage=checkmark\.circle\.fill/, `stdout:\n${res.stdout}`);
  assert.match(res.stdout, /--Status: loaded/, `stdout:\n${res.stdout}`);
  assert.match(res.stdout, /--Plist: /, `stdout:\n${res.stdout}`);
});

test('installed SwiftBar assets resolve server-scoped daemon state without HAPPIER_STACK_CLI_ROOT_DIR', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const stackRoot = dirname(scriptsDir);
  const sourceSwiftbarDir = join(stackRoot, 'extras', 'swiftbar');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-installed-home-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const fakeHome = join(tmp, 'home');
  const fakeBin = join(tmp, 'bin');
  const storageDir = join(tmp, 'stacks');
  const stackName = 'dev-built';
  const stackDir = join(storageDir, stackName);
  const cliHome = join(stackDir, 'cli');
  const scopedServerDir = join(cliHome, 'servers', 'stack_dev-built__id_default');
  const envFile = join(stackDir, 'env');
  const installedSwiftbarDir = join(fakeHome, 'extras', 'swiftbar');
  const runtimeScriptsDir = join(
    fakeHome,
    'runtime',
    'node_modules',
    '@happier-dev',
    'stack',
    'scripts',
    'utils'
  );
  const runtimeAuthDir = join(runtimeScriptsDir, 'auth');
  const runtimeFsDir = join(runtimeScriptsDir, 'fs');

  await mkdir(fakeBin, { recursive: true });
  await mkdir(scopedServerDir, { recursive: true });
  await mkdir(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(runtimeAuthDir, { recursive: true });
  await mkdir(runtimeFsDir, { recursive: true });
  await cp(sourceSwiftbarDir, installedSwiftbarDir, { recursive: true, force: true });
  await cp(
    join(stackRoot, 'scripts', 'utils', 'auth', 'credentials_paths.mjs'),
    join(runtimeAuthDir, 'credentials_paths.mjs'),
    { force: true }
  );
  await cp(
    join(stackRoot, 'scripts', 'utils', 'fs', 'file_has_content.mjs'),
    join(runtimeFsDir, 'file_has_content.mjs'),
    { force: true }
  );

  await writeExecutable(
    join(fakeBin, 'launchctl'),
    '#!/bin/bash\n' +
      'if [[ "${1:-}" == "list" ]]; then\n' +
      '  printf -- "-\\t0\\tdev.happier.stack.dev-built\\n"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n'
  );
  await writeExecutable(
    join(fakeBin, 'curl'),
    '#!/bin/bash\n' +
      'printf "{\\"status\\":\\"ok\\"}\\n"\n'
  );

  await writeFile(
    join(fakeHome, 'Library', 'LaunchAgents', 'dev.happier.stack.dev-built.plist'),
    '<plist></plist>\n',
    'utf8'
  );
  await writeFile(
    envFile,
    [
      'HAPPIER_STACK_STACK=dev-built',
      'HAPPIER_STACK_SERVER_PORT=23456',
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHome}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(scopedServerDir, 'daemon.state.json'),
    JSON.stringify({ pid: process.pid }) + '\n',
    'utf8'
  );

  const helperRes = runBashInline(
    [
      `source '${join(installedSwiftbarDir, 'lib', 'utils.sh')}'`,
      `source '${join(installedSwiftbarDir, 'lib', 'system.sh')}'`,
      `resolve_preferred_daemon_state_pair '${cliHome}'`,
    ].join('; '),
    {
      cwd: fakeHome,
      env: {
        HOME: fakeHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        HAPPIER_STACK_HOME_DIR: fakeHome,
        HAPPIER_STACK_CANONICAL_HOME_DIR: fakeHome,
        HAPPIER_STACK_RUNTIME_DIR: join(fakeHome, 'runtime'),
        HAPPIER_STACK_ENV_FILE: envFile,
        HAPPIER_STACK_SWIFTBAR_PRIMARY_STACK: stackName,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_MENUBAR_MODE: 'selfhost',
      },
    }
  );
  assert.equal(helperRes.status, 0, `helper stderr:\n${helperRes.stderr}`);
  assert.match(
    helperRes.stdout.trim(),
    /cli\/servers\/stack_dev-built__id_default\/daemon\.state\.json\|.*daemon\.state\.json\.lock$/,
    `helper stdout:\n${helperRes.stdout}`
  );
});

test('installed SwiftBar assets prefer the stack repo helper from HAPPIER_STACK_REPO_DIR when the helper path contains spaces', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const stackRoot = dirname(scriptsDir);
  const repoRoot = resolve(stackRoot, '..', '..');
  const sourceSwiftbarDir = join(stackRoot, 'extras', 'swiftbar');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-repo-helper-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const fakeHome = join(tmp, 'home');
  const fakeBin = join(tmp, 'bin');
  const storageDir = join(tmp, 'stacks');
  const relativeRepoRoot = './repo with spaces';
  const fakeRepoRoot = join(fakeHome, 'repo with spaces');

  // This test intentionally includes spaces so the Node ESM loader requires a
  // proper file URL conversion for `import(...)`.
  assert.equal(relativeRepoRoot.includes(' '), true);
  assert.equal(fakeRepoRoot.includes(' '), true);

  const stackName = 'dev-built';
  const stackDir = join(storageDir, stackName);
  const cliHome = join(stackDir, 'cli');
  const scopedServerDir = join(cliHome, 'servers', 'stack_dev-built__id_default');
  const envFile = join(stackDir, 'env');
  const installedSwiftbarDir = join(fakeHome, 'extras', 'swiftbar');
  const runtimeAuthDir = join(
    fakeHome,
    'runtime',
    'node_modules',
    '@happier-dev',
    'stack',
    'scripts',
    'utils',
    'auth'
  );
  const repoAuthDir = join(fakeRepoRoot, 'apps', 'stack', 'scripts', 'utils', 'auth');
  const repoFsDir = join(fakeRepoRoot, 'apps', 'stack', 'scripts', 'utils', 'fs');

  await mkdir(fakeBin, { recursive: true });
  await mkdir(scopedServerDir, { recursive: true });
  await mkdir(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(runtimeAuthDir, { recursive: true });
  await mkdir(repoAuthDir, { recursive: true });
  await mkdir(repoFsDir, { recursive: true });
  await cp(sourceSwiftbarDir, installedSwiftbarDir, { recursive: true, force: true });
  await cp(
    join(stackRoot, 'scripts', 'utils', 'auth', 'credentials_paths.mjs'),
    join(repoAuthDir, 'credentials_paths.mjs'),
    { force: true }
  );
  await cp(
    join(stackRoot, 'scripts', 'utils', 'fs', 'file_has_content.mjs'),
    join(repoFsDir, 'file_has_content.mjs'),
    { force: true }
  );
  await writeFile(
    join(runtimeAuthDir, 'credentials_paths.mjs'),
    [
      'export function resolvePreferredStackDaemonStatePaths({ cliHomeDir }) {',
      "  return { statePath: `${cliHomeDir}/daemon.state.json`, lockPath: `${cliHomeDir}/daemon.state.json.lock` };",
      '}',
      '',
    ].join('\n'),
    'utf8'
  );

  await writeExecutable(
    join(fakeBin, 'launchctl'),
    '#!/bin/bash\n' +
      'if [[ "${1:-}" == "list" ]]; then\n' +
      '  printf -- "-\\t0\\tdev.happier.stack.dev-built\\n"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n'
  );
  await writeExecutable(
    join(fakeBin, 'curl'),
    '#!/bin/bash\n' +
      'printf "{\\"status\\":\\"ok\\"}\\n"\n'
  );

  await writeFile(
    join(fakeHome, 'Library', 'LaunchAgents', 'dev.happier.stack.dev-built.plist'),
    '<plist></plist>\n',
    'utf8'
  );
  await writeFile(
    envFile,
    [
      'HAPPIER_STACK_STACK=dev-built',
      'HAPPIER_STACK_SERVER_PORT=23456',
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHome}`,
      `HAPPIER_STACK_REPO_DIR=${relativeRepoRoot}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(scopedServerDir, 'daemon.state.json'),
    JSON.stringify({ pid: process.pid }) + '\n',
    'utf8'
  );

  const helperRes = runBashInline(
    [
      `source '${join(installedSwiftbarDir, 'lib', 'utils.sh')}'`,
      `source '${join(installedSwiftbarDir, 'lib', 'system.sh')}'`,
      `resolve_preferred_daemon_state_pair '${cliHome}'`,
    ].join('; '),
    {
      cwd: fakeHome,
      env: {
        HOME: fakeHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        HAPPIER_STACK_HOME_DIR: fakeHome,
        HAPPIER_STACK_CANONICAL_HOME_DIR: fakeHome,
        HAPPIER_STACK_RUNTIME_DIR: join(fakeHome, 'runtime'),
        HAPPIER_STACK_ENV_FILE: envFile,
        HAPPIER_STACK_SWIFTBAR_PRIMARY_STACK: stackName,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_MENUBAR_MODE: 'selfhost',
      },
    }
  );
  assert.equal(helperRes.status, 0, `helper stderr:\n${helperRes.stderr}`);
  assert.match(
    helperRes.stdout.trim(),
    /cli\/servers\/stack_dev-built__id_default\/daemon\.state\.json\|.*daemon\.state\.json\.lock$/,
    `helper stdout:\n${helperRes.stdout}`
  );
});
