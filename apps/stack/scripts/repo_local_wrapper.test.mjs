import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runNodeCapture as runNode } from './testkit/core/run_node_capture.mjs';
import { resolveStablePortStart } from './utils/expo/metro_ports.mjs';
import { resolveManagedLimaProfile } from './utils/managed_lima/profiles.mjs';
import { resolveRepoStackIdentity } from './utils/stack/repo_stack_identity.mjs';

async function listenOnPort(port) {
  const srv = createServer((socket) => {
    // Tests use this only as a port reservation primitive. If something external
    // (e.g. a browser tab) connects, immediately close the socket so server.close()
    // cannot hang waiting for long-lived connections to drain.
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port }, () => resolve());
  });
  return srv;
}

async function reserveStableStartPort({ stackName, baseCandidates, range }) {
  for (const base of baseCandidates) {
    const startPort = resolveStablePortStart({
      env: {
        HAPPIER_STACK_SERVER_PORT_BASE: String(base),
        HAPPIER_STACK_SERVER_PORT_RANGE: String(range),
      },
      stackName,
      baseKey: 'HAPPIER_STACK_SERVER_PORT_BASE',
      rangeKey: 'HAPPIER_STACK_SERVER_PORT_RANGE',
      defaultBase: base,
      defaultRange: range,
    });
    try {
      const server = await listenOnPort(startPort);
      return { base, range, startPort, server };
    } catch {
      // Port in use; try another base.
    }
  }
  throw new Error(`failed to reserve a stable start port (bases=${baseCandidates.join(', ')}, range=${range})`);
}

test('repo-local wrapper dry-run prints hstack invocation with repo-local env', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev', '--dry-run'],
    {
      cwd: repoRoot,
      env: { ...process.env, HAPPIER_STACK_CLI_ROOT_DIR: '/some/other/install', HAPPIER_STACK_RUNTIME_MODE: '' },
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.cwd, repoRoot);
  assert.equal(data.cmd, process.execPath);
  assert.ok(Array.isArray(data.args), 'expected args array');
  assert.equal(
    data.args[0],
    join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs'),
    'expected wrapper to invoke repo-local hstack bin'
  );
  assert.equal(data.args[1], 'dev');

  assert.equal(data.env.HAPPIER_STACK_CLI_ROOT_DISABLE, '1');
  assert.equal(data.env.HAPPIER_STACK_REPO_DIR, repoRoot);
  assert.ok(String(data.env.HAPPIER_STACK_STACK ?? '').trim() !== '', 'expected stackless wrapper to scope to a non-main stack name');
  assert.ok(String(data.env.HAPPIER_STACK_ENV_FILE ?? '').trim() !== '', 'expected wrapper to set a stack env file path for stack-scoped commands');
  assert.ok(String(data.env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim() !== '', 'expected wrapper to set a stack-scoped CLI home dir');
  assert.ok(String(data.env.HAPPIER_ACTIVE_SERVER_ID ?? '').trim() !== '', 'expected wrapper to set a stack-scoped active server id');
  assert.ok(String(data.env.HAPPIER_STACK_LOG_TEE_DIR ?? '').trim() !== '', 'expected wrapper to set a stack-scoped log tee dir');
  assert.equal(data.env.HAPPIER_STACK_LOG_TEE_TIMESTAMPS, '1');
  assert.ok(String(data.env.HAPPIER_STACK_INVOKED_CWD ?? '').trim() !== '');
  assert.equal(data.env.HAPPIER_STACK_RUNTIME_MODE, 'source', 'expected repo-local wrapper to default to source runtime mode');
});

test('active Mac repo-local mirror uses the mapped Stack identity before delegating to the guest owner', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'hstack-repo-local-active-sync-service-'));
  try {
    const mirrorRepoRoot = join(fixtureRoot, 'mirror', '0.3');
    const homeDir = join(fixtureRoot, 'home');
    const storageDir = join(fixtureRoot, 'storage');
    const binDir = join(fixtureRoot, 'bin');
    const logPath = join(fixtureRoot, 'limactl.log');
    const guestWorkspaceDir = '/home/example/.happier-stack/workspace';
    const guestRepoDir = `${guestWorkspaceDir}/0.3`;
    const stackName = 'repo-dev-a1cc5e0671';
    const managedProfile = resolveManagedLimaProfile('heavy');
    const legacyForwarding = [
      {
        guestIPMustBeZero: false,
        guestIP: '127.0.0.1',
        guestPortRange: [52005, 54004],
        hostIP: '0.0.0.0',
        hostPortRange: [52005, 54004],
        proto: 'any',
      },
      {
        guestIPMustBeZero: false,
        guestIP: '127.0.0.1',
        guestPortRange: [18081, 20080],
        hostIP: '0.0.0.0',
        hostPortRange: [18081, 20080],
        proto: 'any',
      },
      {
        guestIPMustBeZero: false,
        guestIP: '0.0.0.0',
        guestPortRange: [1, 65535],
        hostIP: '127.0.0.1',
        hostPortRange: [1, 65535],
        proto: 'any',
        ignore: true,
      },
    ];
    const retainedInstance = {
      name: 'primary',
      status: 'Running',
      vmType: managedProfile.vmType,
      arch: managedProfile.arch,
      cpus: managedProfile.cpus,
      memory: managedProfile.memoryGiB * 1024 ** 3,
      disk: managedProfile.diskGiB * 1024 ** 3,
      config: {
        mounts: [],
        containerd: { user: false, system: false },
        ssh: { forwardAgent: false },
        vmOpts: {
          vz: {
            diskImageFormat: managedProfile.diskImageFormat,
            rosetta: { enabled: managedProfile.rosetta, binfmt: managedProfile.rosetta },
          },
        },
        portForwards: legacyForwarding,
      },
    };
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(mirrorRepoRoot, { recursive: true });
    const mirrorRepoDir = realpathSync(mirrorRepoRoot);
    symlinkSync(join(repoRoot, 'apps'), join(mirrorRepoDir, 'apps'), 'dir');
    writeFileSync(join(homeDir, 'execution-host.json'), `${JSON.stringify({
      version: 2,
      mode: 'managed-lima',
      activation: 'active',
      instance: 'primary',
      limaHome: join(fixtureRoot, 'lima'),
      profile: 'heavy',
      pressureProfile: 'none',
      guestWorkspaceDir,
      mirrorWorkspaceDir: dirname(mirrorRepoDir),
      controllerEntrypoint: join(fixtureRoot, 'execution-host-bridge.mjs'),
      workspaces: [{
        id: '0.3',
        stackName,
        hostSourceDir: join(fixtureRoot, 'source'),
        hostMirrorDir: mirrorRepoDir,
        guestDir: guestRepoDir,
      }],
    })}\n`, 'utf8');
    writeFileSync(join(binDir, 'limactl'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$HAPPIER_TEST_LIMA_LOG"',
      'if [ "$1" = "--version" ]; then echo "limactl version 2.2.0"; exit 0; fi',
      `if [ "$1" = "list" ]; then printf '%s\\n' ${JSON.stringify(JSON.stringify(retainedInstance))}; exit 0; fi`,
      'if [ "$1" = "shell" ]; then exit 0; fi',
      'exit 1',
      '',
    ].join('\n'), 'utf8');
    chmodSync(join(binDir, 'limactl'), 0o755);

    const commandEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_REPO_LOCAL_AUTO_INSTALL: '0',
      HAPPIER_TEST_LIMA_LOG: logPath,
    };
    const preview = await runNode(
      ['--preserve-symlinks-main', join(mirrorRepoDir, 'apps', 'stack', 'scripts', 'repo_local.mjs'), 'dev-targets', 'sync-service', 'status', '--dry-run'],
      { cwd: mirrorRepoDir, env: commandEnv },
    );
    assert.equal(preview.code, 0, `stdout:\n${preview.stdout}\nstderr:\n${preview.stderr}`);
    const previewData = JSON.parse(preview.stdout);
    assert.equal(previewData.env.HAPPIER_STACK_STACK, stackName);
    assert.equal(previewData.env.HAPPIER_STACK_ENV_FILE, join(storageDir, stackName, 'env'));
    assert.equal(existsSync(storageDir), false, 'dry-run must not create a shadow Stack directory');

    const result = await runNode(
      ['--preserve-symlinks-main', join(mirrorRepoDir, 'apps', 'stack', 'scripts', 'repo_local.mjs'), 'dev-targets', 'sync-service', 'status', '--json'],
      {
        cwd: mirrorRepoDir,
        env: commandEnv,
      },
    );

    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(readdirSync(storageDir), [stackName]);
    assert.match(readFileSync(join(storageDir, stackName, 'env'), 'utf8'), new RegExp(`^HAPPIER_STACK_STACK=${stackName}$`, 'm'));
    const calls = readFileSync(logPath, 'utf8');
    assert.match(
      calls,
      new RegExp(`shell --workdir ${guestRepoDir.replaceAll('/', '\\/')} primary -- env HAPPIER_STACK_EXECUTION_HOST_REENTRY=1 HAPPIER_STACK_INVOKED_CWD=${guestRepoDir.replaceAll('/', '\\/')} HAPPIER_STACK_STACK=${stackName} node ${guestRepoDir.replaceAll('/', '\\/')}\\/apps\\/stack\\/scripts\\/repo_local\\.mjs dev-targets sync-service status --json`),
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('candidate and unmapped active execution-host profiles retain the normal repo-local identity', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'hstack-repo-local-identity-fallback-'));
  try {
    const mirrorRepoRoot = join(fixtureRoot, 'mirror', '0.3');
    const homeDir = join(fixtureRoot, 'home');
    const storageDir = join(fixtureRoot, 'storage');
    mkdirSync(mirrorRepoRoot, { recursive: true });
    const mirrorRepoDir = realpathSync(mirrorRepoRoot);
    symlinkSync(join(repoRoot, 'apps'), join(mirrorRepoDir, 'apps'), 'dir');
    const expected = resolveRepoStackIdentity({
      repoRoot: mirrorRepoDir,
      stacksStorageRoot: storageDir,
      createIfMissing: false,
    });
    const profileFor = (activation, hostMirrorDir) => ({
      version: 2,
      mode: 'managed-lima',
      activation,
      instance: 'primary',
      limaHome: join(fixtureRoot, 'lima'),
      profile: 'heavy',
      pressureProfile: 'none',
      guestWorkspaceDir: '/home/example/.happier-stack/workspace',
      mirrorWorkspaceDir: dirname(mirrorRepoDir),
      controllerEntrypoint: join(fixtureRoot, 'execution-host-bridge.mjs'),
      workspaces: [{
        id: '0.3',
        stackName: 'repo-dev-a1cc5e0671',
        hostSourceDir: join(fixtureRoot, 'source'),
        hostMirrorDir,
        guestDir: '/home/example/.happier-stack/workspace/0.3',
      }],
    });

    for (const [activation, hostMirrorDir] of [
      ['candidate', mirrorRepoDir],
      ['active', join(dirname(mirrorRepoDir), 'unmapped')],
    ]) {
      mkdirSync(homeDir, { recursive: true });
      writeFileSync(join(homeDir, 'execution-host.json'), `${JSON.stringify(profileFor(activation, hostMirrorDir))}\n`, 'utf8');
      const result = await runNode(
        ['--preserve-symlinks-main', join(mirrorRepoDir, 'apps', 'stack', 'scripts', 'repo_local.mjs'), 'dev-targets', 'status', '--dry-run'],
        {
          cwd: mirrorRepoDir,
          env: {
            ...process.env,
            HAPPIER_STACK_HOME_DIR: homeDir,
            HAPPIER_STACK_STORAGE_DIR: storageDir,
          },
        },
      );
      assert.equal(result.code, 0, `activation=${activation}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).env.HAPPIER_STACK_STACK, expected.stackName);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper replaces an inherited runtime-state path with its checkout-owned path', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const stacksRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-runtime-path-'));

  try {
    const inheritedRuntimePath = join(stacksRoot, 'another-stack', 'stack.runtime.json');
    const res = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
          HAPPIER_STACK_STACK: 'another-stack',
          HAPPIER_STACK_ENV_FILE: join(stacksRoot, 'another-stack', 'env'),
          HAPPIER_STACK_RUNTIME_MODE: 'require',
          HAPPIER_STACK_RUNTIME_STATE_PATH: inheritedRuntimePath,
        },
      },
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const data = JSON.parse(res.stdout);
    const repoLocalBaseDir = dirname(data.env.HAPPIER_STACK_ENV_FILE);

    assert.equal(data.env.HAPPIER_STACK_RUNTIME_STATE_PATH, join(repoLocalBaseDir, 'stack.runtime.json'));
    assert.notEqual(data.env.HAPPIER_STACK_RUNTIME_STATE_PATH, inheritedRuntimePath);
    assert.equal(data.env.HAPPIER_STACK_RUNTIME_MODE, 'source');
  } finally {
    rmSync(stacksRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper defaults `tui` to mobile-capable `tui dev` when no forwarded args are provided', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'tui');
  assert.equal(data.args[2], 'dev');
  assert.equal(data.args[3], '--mobile');
  assert.equal(data.env.HAPPIER_STACK_CLI_BUILD_MODE, 'always');
});

test('repo-local wrapper preserves explicit `tui` forwarded args', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', 'stack', 'dev', 'exp1', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'tui');
  assert.equal(data.args[2], 'stack');
  assert.equal(data.args[3], 'dev');
  assert.equal(data.args[4], 'exp1');
});

test('repo-local wrapper preserves flag-only tui args', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', '--json', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'tui');
  assert.equal(data.args[2], '--json');
});

test('repo-local wrapper preserves explicit tui tauri flags', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', '--tauri', '--mobile', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'tui');
  assert.equal(data.args[2], '--tauri');
  assert.equal(data.args[3], '--mobile');
  assert.equal(data.env.HAPPIER_STACK_CLI_BUILD_MODE, 'always');
});

test('repo-local wrapper forwards --help when a subcommand is provided', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'auth', '--help', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'auth');
  assert.equal(data.args[2], '--help');
});

test('repo-local wrapper maps `stop` to stack stop for the repo-local stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'stop', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'stack');
  assert.equal(data.args[2], 'stop');
  assert.ok(String(data.args[3] ?? '').trim() !== '');
});

test('repo-local wrapper maps `daemon` to the repo-local stack instead of the main-stack alias', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'daemon', 'status', '--json', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    },
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.args[1], 'stack');
  assert.equal(data.args[2], 'daemon');
  assert.equal(data.args[3], data.env.HAPPIER_STACK_STACK);
  assert.deepEqual(data.args.slice(4), ['status', '--json']);
});

test('repo-local wrapper maps `mobile:install` to stack mobile:install for the repo-local stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'mobile:install', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'stack');
  assert.equal(data.args[2], 'mobile:install');
  assert.ok(String(data.args[3] ?? '').trim().startsWith('repo-'), `expected repo-local stack name, got: ${data.args[3]}`);

  // Convenience: default name should be user-friendly (the repo-local stack name can be noisy).
  assert.ok(
    data.args.some((a) => String(a).startsWith('--name=')),
    `expected wrapper to set a default --name=... for mobile:install:\n${JSON.stringify(data.args, null, 2)}`
  );
});

test('repo-local wrapper uses a development-friendly default name for `mobile:install --app-env=development`', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'mobile:install', '--app-env=development', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.ok(
    data.args.includes('--name=Happier Dev (Local)'),
    `expected development install to default to a development-friendly app name:\n${JSON.stringify(data.args, null, 2)}`
  );
});

test('repo-local wrapper auto-installs deps when node_modules are missing', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const preflightRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-preflight-'));
  try {
    writeFileSync(join(preflightRoot, 'package.json'), JSON.stringify({ name: 'tmp', private: true }));

    const binDir = join(preflightRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const logPath = join(preflightRoot, 'yarn.log');
    const yarnBin = join(binDir, 'yarn');
    writeFileSync(
      yarnBin,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, mkdirSync } from 'node:fs';",
        "import { dirname, join } from 'node:path';",
        'const logPath = process.env.YARN_LOG;',
        "appendFileSync(logPath, process.argv.slice(2).join(' ') + '\\n');",
        "if (process.argv.includes('install')) {",
        "  const nodeModules = join(process.cwd(), 'node_modules');",
        "  mkdirSync(nodeModules, { recursive: true });",
        '}',
        'process.exit(0);',
      ].join('\n') + '\n',
    );
    chmodSync(yarnBin, 0o755);

    const res = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          YARN_LOG: logPath,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ROOT: preflightRoot,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
        },
      }
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const log = readFileSync(logPath, 'utf-8');
    assert.match(log, /\binstall\b/);
  } finally {
    rmSync(preflightRoot, { recursive: true, force: true });
  }
});

test('repo-local runtime snapshot selection bypasses repository identity and dependency bootstrap', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-select-bypass-'));
  try {
    const loaderPath = join(fixtureRoot, 'select-bypass-loader.mjs');
    writeFileSync(
      loaderPath,
      [
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === './utils/stack/repo_stack_identity.mjs') {",
        "    return { url: 'data:text/javascript,export function resolveRepoStackIdentity(){throw new Error(\\\"repo identity bootstrap observed\\\")}export function resolveStacksStorageRoot(){throw new Error(\\\"repo identity bootstrap observed\\\")}', shortCircuit: true };",
        '  }',
        "  if (specifier === './utils/proc/pm.mjs') {",
        "    return { url: 'data:text/javascript,export async function ensureDepsInstalled(){throw new Error(\\\"dependency bootstrap must not run\\\")}', shortCircuit: true };",
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    for (const args of [
      ['stack', 'runtime', 'qa-consumer', 'select'],
      ['stack', 'runtime', 'qa-consumer', 'select', '--help'],
    ]) {
      const res = await runNode([join(packageRoot, 'scripts', 'repo_local.mjs'), ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_HOME_DIR: join(fixtureRoot, 'home'),
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ROOT: fixtureRoot,
          NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
        },
      });

      assert.equal(res.code, 0, `selection bootstrap bypass failed for ${args.join(' ')}\nstderr:\n${res.stderr}`);
    }

    const activation = await runNode([join(packageRoot, 'scripts', 'repo_local.mjs'), 'stack', 'runtime', 'qa-consumer', 'activate'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_STACK_HOME_DIR: join(fixtureRoot, 'home'),
        HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
        HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ROOT: fixtureRoot,
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });
    assert.notEqual(activation.code, 0, 'runtime activation must retain repository bootstrap');
    assert.match(activation.stderr, /repo identity bootstrap observed/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper leaves existing dependency freshness admission to the stack owner', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const preflightRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-existing-deps-'));
  try {
    writeFileSync(join(preflightRoot, 'package.json'), JSON.stringify({ name: 'tmp', private: true }));
    mkdirSync(join(preflightRoot, 'node_modules'), { recursive: true });
    const binDir = join(preflightRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const logPath = join(preflightRoot, 'yarn.log');
    writeFileSync(logPath, '');
    const yarnBin = join(binDir, 'yarn');
    writeFileSync(
      yarnBin,
      '#!/usr/bin/env node\n' +
        "import { appendFileSync } from 'node:fs';\n" +
        "appendFileSync(process.env.YARN_LOG, process.argv.slice(2).join(' ') + '\\n');\n",
    );
    chmodSync(yarnBin, 0o755);

    const res = await runNode([join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        YARN_LOG: logPath,
        HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ROOT: preflightRoot,
        HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
      },
    });

    assert.equal(res.code, 0, res.stderr || res.stdout);
    assert.equal(readFileSync(logPath, 'utf-8'), '');
  } finally {
    rmSync(preflightRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper skips Skia all-platform package postinstall during mobile dependency preflight', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const preflightRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-skia-preflight-'));
  try {
    writeFileSync(join(preflightRoot, 'package.json'), JSON.stringify({ name: 'tmp', private: true }));

    const binDir = join(preflightRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const logPath = join(preflightRoot, 'yarn.log');
    const yarnBin = join(binDir, 'yarn');
    writeFileSync(
      yarnBin,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, mkdirSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const logPath = process.env.YARN_LOG;',
        "appendFileSync(logPath, `${process.argv.slice(2).join(' ')} :: SKIP_SKIA_DOWNLOAD=${process.env.SKIP_SKIA_DOWNLOAD || ''} :: HAPPIER_INSTALL_SCOPE=${process.env.HAPPIER_INSTALL_SCOPE || ''}\\n`);",
        "if (process.argv.includes('install')) {",
        "  const nodeModules = join(process.cwd(), 'node_modules');",
        "  mkdirSync(nodeModules, { recursive: true });",
        '}',
        'process.exit(0);',
      ].join('\n') + '\n',
    );
    chmodSync(yarnBin, 0o755);

    const res = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'mobile-dev-client'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          YARN_LOG: logPath,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ROOT: preflightRoot,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
        },
      }
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const log = readFileSync(logPath, 'utf-8');
    assert.match(log, /\binstall\b/);
    assert.match(log, /SKIP_SKIA_DOWNLOAD=1/);
    assert.match(log, /HAPPIER_INSTALL_SCOPE=ui/);
  } finally {
    rmSync(preflightRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper preserves user-defined env keys while managing stack-owned keys', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const stacksRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-stacks-'));
  try {
    // First: compute the repo-local stack env file path without mutating the real repo checkout.
    // (We use --dry-run so the wrapper doesn't create/update any local state.)
    const dry = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev', '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
        },
      }
    );
    assert.equal(dry.code, 0, `expected exit 0, got ${dry.code}\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    const dryData = JSON.parse(dry.stdout);
    const envPath = String(dryData?.env?.HAPPIER_STACK_ENV_FILE ?? '').trim();
    assert.ok(envPath, 'expected dry-run to include HAPPIER_STACK_ENV_FILE');

    // Seed env file with a user-defined key and pinned ports.
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(
      envPath,
      ['CUSTOM_KEY=1', 'HAPPIER_STACK_SERVER_PORT=9999', 'HAPPIER_STACK_EXPO_DEV_PORT=19999', ''].join('\n')
    );

    // Next: run a command that exercises the wrapper's env-file sync logic but does not spawn hstack.
    const res = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'stop'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
        },
      }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const updated = readFileSync(envPath, 'utf-8');
    assert.match(updated, /\bCUSTOM_KEY=1\b/, `expected user key to be preserved:\n${updated}`);
    assert.match(updated, /\bHAPPIER_STACK_SERVER_PORT=9999\b/, `expected pinned port to be preserved:\n${updated}`);
    assert.match(updated, /\bHAPPIER_STACK_EXPO_DEV_PORT=19999\b/, `expected pinned expo port to be preserved:\n${updated}`);
  } finally {
    rmSync(stacksRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper prunes pinned server port when it falls outside the configured stackless port range', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const stacksRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-stacks-'));
  try {
    const dry = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev', '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
        },
      }
    );
    assert.equal(dry.code, 0, `expected exit 0, got ${dry.code}\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    const dryData = JSON.parse(dry.stdout);
    const envPath = String(dryData?.env?.HAPPIER_STACK_ENV_FILE ?? '').trim();
    assert.ok(envPath, 'expected dry-run to include HAPPIER_STACK_ENV_FILE');

    // Seed env with a stale pinned port in the legacy range. Stackless is expected to use the
    // high stable range (default base/range managed by the wrapper).
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(
      envPath,
      [
        'CUSTOM_KEY=1',
        'HAPPIER_STACK_SERVER_PORT_BASE=52005',
        'HAPPIER_STACK_SERVER_PORT_RANGE=2000',
        'HAPPIER_STACK_SERVER_PORT=3009',
        '',
      ].join('\n')
    );

    const res = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'stop'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
        },
      }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const updated = readFileSync(envPath, 'utf-8');
    assert.match(updated, /\bCUSTOM_KEY=1\b/, `expected user key to be preserved:\n${updated}`);
    assert.match(updated, /\bHAPPIER_STACK_SERVER_PORT_BASE=52005\b/, `expected base to be preserved:\n${updated}`);
    assert.match(updated, /\bHAPPIER_STACK_SERVER_PORT_RANGE=2000\b/, `expected range to be preserved:\n${updated}`);
    assert.doesNotMatch(updated, /\bHAPPIER_STACK_SERVER_PORT=3009\b/, `expected stale pinned port to be pruned:\n${updated}`);
  } finally {
    rmSync(stacksRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper persists a stable pinned server port when none is present (service/tailscale pre-start)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const stacksRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-stacks-'));
  try {
    const dry = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev', '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
        },
      }
    );
    assert.equal(dry.code, 0, `expected exit 0, got ${dry.code}\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    const dryData = JSON.parse(dry.stdout);
    const envPath = String(dryData?.env?.HAPPIER_STACK_ENV_FILE ?? '').trim();
    assert.ok(envPath, 'expected dry-run to include HAPPIER_STACK_ENV_FILE');
    const stackName = String(dryData?.env?.HAPPIER_STACK_STACK ?? '').trim();
    assert.ok(stackName, 'expected dry-run to include HAPPIER_STACK_STACK');

    // Ensure env exists but does not contain a server port pin yet.
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, ['CUSTOM_KEY=1', ''].join('\n'));

    // Reserve the first stable port to force the wrapper to pick the next free one and persist it.
    const reserved = await reserveStableStartPort({
      stackName,
      baseCandidates: [52005, 54005, 56005, 58005],
      range: 2000,
    });
    try {
      const res = await runNode(
        [join(packageRoot, 'scripts', 'repo_local.mjs'), 'service', 'status'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            HAPPIER_STACK_STORAGE_DIR: stacksRoot,
            HAPPIER_STACK_SERVER_PORT_BASE: String(reserved.base),
            HAPPIER_STACK_SERVER_PORT_RANGE: String(reserved.range),
            HAPPIER_STACK_REPO_LOCAL_AUTO_INSTALL: '0',
            HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
          },
        }
      );
      assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    } finally {
      await new Promise((resolve) => reserved.server.close(() => resolve()));
    }

    const updated = readFileSync(envPath, 'utf-8');
    assert.match(updated, /\bCUSTOM_KEY=1\b/, `expected user key to be preserved:\n${updated}`);
    const m = updated.match(/^HAPPIER_STACK_SERVER_PORT=(\d+)$/m);
    assert.ok(m, `expected wrapper to persist HAPPIER_STACK_SERVER_PORT:\n${updated}`);
    const pinned = Number(m?.[1] ?? '');
    assert.ok(Number.isFinite(pinned) && pinned > 0, `expected pinned port to be numeric, got: ${m?.[1]}`);
    assert.ok(
      pinned >= reserved.base && pinned < reserved.base + reserved.range,
      `expected pinned port within range [${reserved.base}, ${reserved.base + reserved.range}): ${pinned}`
    );
    assert.notEqual(pinned, reserved.startPort, `expected wrapper to avoid occupied start port ${reserved.startPort}, got: ${pinned}`);
  } finally {
    rmSync(stacksRoot, { recursive: true, force: true });
  }
});
