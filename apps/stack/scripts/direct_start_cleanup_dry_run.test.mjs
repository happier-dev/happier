import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(dirname(scriptsDir)));

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scriptsDir, script), '--json'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

test('direct dev and run JSON dry-runs do not recover or mutate a stale cleanup marker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-direct-json-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackName = 'json-cleanup-dry-run';
  const baseDir = join(root, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const marker = {
    version: 1,
    stackName,
    ownerPid: 999_999,
    startedAt: '2026-07-17T08:00:00.000Z',
    processes: {},
    stopRequest: {
      signal: 'SIGTERM',
      requestedBy: 'interrupted cleanup',
      reason: 'dry-run must not mutate',
      preserveDaemon: false,
      requestedAt: '2026-07-17T08:01:00.000Z',
    },
  };
  await mkdir(baseDir, { recursive: true });
  await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\nHAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n`, 'utf8');

  for (const script of ['dev.mjs', 'run.mjs']) {
    await writeFile(runtimeStatePath, `${JSON.stringify(marker)}\n`, 'utf8');
    const result = await runNode(script, {
      ...process.env,
      CI: '1',
      HAPPIER_STACK_STORAGE_DIR: root,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
      HAPPIER_STACK_REPO_DIR: repoRoot,
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
    });
    assert.equal(result.code, 0, `${script} stderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), marker);
    await assert.rejects(() => access(join(baseDir, 'stack.cleanup-executor.lock')), (error) => error?.code === 'ENOENT');
  }
});
