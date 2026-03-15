import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runCapture(cmd, args, { cwd, env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

test('sandbox mode honors HAPPIER_STACK_SANDBOX_WORKSPACE_DIR override', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const bin = join(rootDir, 'bin', 'hstack.mjs');

  const sandboxDir = await mkdtemp(join(tmpdir(), 'hstack-sandbox-ws-'));
  const workspaceDir = await mkdtemp(join(tmpdir(), 'hstack-ws-cache-'));
  t.after(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    HAPPIER_STACK_SANDBOX_WORKSPACE_DIR: workspaceDir,
  };

  const res = await runCapture(process.execPath, [bin, '--sandbox-dir', sandboxDir, 'where', '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(resolve(data.workspaceDir), resolve(workspaceDir));
  assert.equal(resolve(data.checkouts.main), resolve(join(workspaceDir, 'main')));
  assert.equal(resolve(data.pmCacheBaseDir), resolve(join(workspaceDir, '.hstack-cache', 'pm')));
  assert.equal(resolve(data.expoSharedTmpDirBaseDir), resolve(join(workspaceDir, '.hstack-cache', 'expo')));
  assert.equal(resolve(data.expoSharedTmpDirKey), resolve(workspaceDir));
});
