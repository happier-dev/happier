import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';

function runGit(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function overrideProcessReleaseNameForTest(nextName) {
  const descriptor = Object.getOwnPropertyDescriptor(process.release, 'name');
  assert.ok(descriptor?.configurable, 'process.release.name must be configurable for test');
  Object.defineProperty(process.release, 'name', {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    writable: descriptor.writable ?? false,
    value: nextName,
  });
  return () => {
    Object.defineProperty(process.release, 'name', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      writable: descriptor.writable ?? false,
      value: descriptor.value,
    });
  };
}

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });

  // Dist entrypoint exists, but package.json intentionally has no build script.
  // startLocalDaemonWithAuth should launch the daemon via dist (not via bin/happier.mjs).
  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }), 'utf-8');
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  await writeFile(join(cliDir, 'dist', 'index.mjs'), distScript.trimStart(), 'utf-8');
  await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

  // If the implementation accidentally invokes bin/happier.mjs instead of dist/index.mjs, fail loudly.
  await writeFile(join(cliDir, 'bin', 'happier.mjs'), 'process.exit(42);\n', 'utf-8');
  return join(cliDir, 'bin', 'happier.mjs');
}

async function writeRuntimeSnapshotHappyCli({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const implPath = join(cliDir, 'runtime-cli.mjs');
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }), 'utf-8');
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;
  await writeFile(implPath, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, `#!/bin/sh\nexec "${process.execPath}" "${implPath}" "$@"\n`, 'utf-8');
  await chmod(cliBin, 0o755);
  return cliBin;
}

async function writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  const packageDistDir = join(cliDir, 'package-dist');
  await mkdir(packageDistDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start-sync' || sub === 'start') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }), 'utf-8');
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(join(packageDistDir, 'index.mjs'), distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, 'exit 42\n', 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliNodeEntrypoint: join(packageDistDir, 'index.mjs'),
  };
}

async function writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');
  const cliCommand = join(cliDir, 'happier.mjs');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'start-sync' || sub === 'start') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }), 'utf-8');
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(cliCommand, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, 'exit 42\n', 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliCommand,
  };
}

async function writePathResolvedRuntimeCommand({ binDir, stopMode = 'kill-state' } = {}) {
  await mkdir(binDir, { recursive: true });
  const commandPath = join(binDir, 'happier-runtime-cmd');
  const script = `#!/bin/sh
HOME_DIR="${'$'}{HAPPIER_HOME_DIR:-${'$'}{HAPPIER_STACK_CLI_HOME_DIR:-}}"
if [ -z "$HOME_DIR" ]; then
  exit 2
fi
STATE="$HOME_DIR/daemon.state.json"
case "$1" in
  daemon)
    case "$2" in
      start)
        "${process.execPath}" -e "setInterval(() => {}, 1000)" daemon start >/dev/null 2>&1 &
        child=$!
        printf '{"pid":%s,"httpPort":0,"startTime":"test"}\n' "$child" > "$STATE"
        exit 0
        ;;
      stop)
        if [ "${stopMode}" = "kill-state" ] && [ -f "$STATE" ]; then
          pid=$("${process.execPath}" -e "const fs=require('node:fs');const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(raw.pid ?? ''));" "$STATE")
          if [ -n "$pid" ]; then
            kill "$pid" >/dev/null 2>&1 || true
          fi
          rm -f "$STATE"
        fi
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
`;
  await writeFile(commandPath, script, 'utf-8');
  await chmod(commandPath, 0o755);
  return { cliCommand: 'happier-runtime-cmd', commandPath };
}

async function readDaemonPid(statePath) {
  return Number(JSON.parse(await readFile(statePath, 'utf-8')).pid);
}

test('startLocalDaemonWithAuth does not require a second CLI build when dist/index.mjs already exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-guard-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...process.env,
      HAPPIER_STACK_CLI_BUILD: '1',
    };

    // If startLocalDaemonWithAuth tries to rebuild, this will fail because package.json has no build script.
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4101',
      publicServerUrl: 'http://localhost:4101',
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      internalServerUrl: 'http://127.0.0.1:4101',
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects incomplete dist when index imports missing chunks', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-incomplete-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });

    // Simulate a partially built dist where entrypoint exists but references a missing chunk.
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
      "import './doctor-missing-chunk.mjs';\nexport {};\n",
      'utf-8',
    );

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...process.env,
      HAPPIER_STACK_CLI_BUILD: '0',
    };

    await assert.rejects(
      () =>
        startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl: 'http://127.0.0.1:4101',
          publicServerUrl: 'http://localhost:4101',
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
      /dist entrypoint is missing or incomplete|missing_module/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth accepts a runtime snapshot cli executable without requiring dist/index.mjs', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-cli-'));
  try {
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const cliBin = await writeRuntimeSnapshotHappyCli({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4101',
      publicServerUrl: 'http://localhost:4101',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_BUILD: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      internalServerUrl: 'http://127.0.0.1:4101',
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth prefers a runtime snapshot node entrypoint over the bundled binary when available', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-node-entrypoint-'));
  try {
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4101',
      publicServerUrl: 'http://localhost:4101',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_BUILD: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliNodeEntrypoint,
      internalServerUrl: 'http://127.0.0.1:4101',
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth still prefers a runtime snapshot node entrypoint when the host runtime is bun', async () => {
  const restoreProcessReleaseName = overrideProcessReleaseNameForTest('bun');
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-bun-node-entrypoint-'));
  try {
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4101',
      publicServerUrl: 'http://localhost:4101',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_BUILD: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliNodeEntrypoint,
      internalServerUrl: 'http://127.0.0.1:4101',
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    restoreProcessReleaseName();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth runs runtime snapshot JS commands through node when no separate node entrypoint exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-js-command-'));
  try {
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliCommand } = await writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4101',
      publicServerUrl: 'http://localhost:4101',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_BUILD: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliCommand,
      internalServerUrl: 'http://127.0.0.1:4101',
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects missing runtime snapshot command paths before spawning', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-missing-command-'));
  try {
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliNodeEntrypoint: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'package-dist', 'index.mjs'),
        cliCommand: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4101',
        publicServerUrl: 'http://localhost:4101',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          HAPPIER_STACK_CLI_BUILD: '0',
        },
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      /runtime snapshot.*missing|runtime launch path.*missing|missing runtime/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth restarts PATH-resolved runtime commands instead of treating the command name as a dist path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-path-runtime-command-'));
  try {
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = {
      ...process.env,
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4101',
      publicServerUrl: 'http://localhost:4101',
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4101',
      publicServerUrl: 'http://localhost:4101',
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.ok(Number.isFinite(firstPid) && firstPid > 0);
    assert.ok(Number.isFinite(secondPid) && secondPid > 0);
    assert.notEqual(secondPid, firstPid);

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl: 'http://127.0.0.1:4101',
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth kills the daemon from daemon.state.json when daemon stop is a no-op', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-fallback-'));
  try {
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir, stopMode: 'noop' });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = {
      ...process.env,
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4102',
      publicServerUrl: 'http://localhost:4102',
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4102',
      publicServerUrl: 'http://localhost:4102',
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.notEqual(secondPid, firstPid);
    assert.doesNotThrow(() => process.kill(secondPid, 0));
    assert.throws(() => process.kill(firstPid, 0));

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl: 'http://127.0.0.1:4102',
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
