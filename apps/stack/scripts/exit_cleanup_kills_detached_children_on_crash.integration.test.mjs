import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const cleanEnv = {};
    for (const [k, v] of Object.entries(env ?? {})) {
      if (v == null) continue;
      cleanEnv[k] = String(v);
    }
    const proc = spawn(process.execPath, args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return !isAlive(pid);
}

test('installExitCleanup kills detached child process groups on uncaughtException', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX-only process-group signaling semantics');
    return;
  }

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-exit-cleanup-'));

  try {
    const exitCleanupUrl = pathToFileURL(join(rootDir, 'scripts', 'utils', 'proc', 'exit_cleanup.mjs')).toString();
    const procUrl = pathToFileURL(join(rootDir, 'scripts', 'utils', 'proc', 'proc.mjs')).toString();

    const parentPath = join(tmp, 'parent.mjs');
    await writeFile(
      parentPath,
      [
        `import { spawnProc } from ${JSON.stringify(procUrl)};`,
        `import { installExitCleanup } from ${JSON.stringify(exitCleanupUrl)};`,
        `const children = [];`,
        `const child = spawnProc('child', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env);`,
        `children.push(child);`,
        `installExitCleanup({ label: 'test', children });`,
        `console.log(String(child.pid));`,
        `setTimeout(() => { throw new Error('boom'); }, 50);`,
        `setInterval(() => {}, 1000);`,
        '',
      ].join('\n'),
      'utf-8'
    );

    const res = await runNode([parentPath], { cwd: tmp, env: process.env });
    assert.equal(
      res.signal,
      null,
      `expected process to exit with status, got signal ${res.signal}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const pid = Number(res.stdout.trim().split('\n')[0]);
    assert.ok(Number.isFinite(pid) && pid > 1, `expected pid in stdout, got: ${res.stdout}`);

    const exited = await waitForPidExit(pid, { timeoutMs: 5_000, intervalMs: 50 });
    assert.ok(exited, `expected detached child pid ${pid} to be stopped`);
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
