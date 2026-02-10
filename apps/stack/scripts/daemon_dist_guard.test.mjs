import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';

function runGit(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });

  // Dist entrypoint exists, but package.json intentionally has no build script.
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export {};\n', 'utf-8');
  await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

  const script = `
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
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }) + '\\n', 'utf-8');
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

  await writeFile(join(cliDir, 'bin', 'happier.mjs'), script.trimStart(), 'utf-8');
  return join(cliDir, 'bin', 'happier.mjs');
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
