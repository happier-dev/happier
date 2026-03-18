import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { createRuntimeSnapshotStartFixture, runtimeSnapshotEnv, stackRootDirFromMeta } from './testkit/runtime_snapshot_start_testkit.mjs';

function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr });
    });
  });
}

test('swiftbar plugin renders named stack status when a runtime snapshot is active', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotStartFixture(t);

  const env = runtimeSnapshotEnv({
    fixture,
    rootDir,
    extraEnv: {
      HOME: fixture.root,
      HAPPIER_STACK_CANONICAL_HOME_DIR: join(fixture.root, '.happier-stack'),
      HAPPIER_STACK_HOME_DIR: join(fixture.root, '.happier-stack'),
      HAPPIER_STACK_SWIFTBAR_PRIMARY_STACK: fixture.stackName,
      HAPPIER_STACK_MENUBAR_MODE: 'selfhost',
    },
  });
  const res = await run('bash', [join(rootDir, 'extras', 'swiftbar', 'hstack.5s.sh')], {
    cwd: rootDir,
    env,
  });

  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, new RegExp(`Stack: ${fixture.stackName}`));
  assert.match(res.stdout, /Open UI \(local\) \| href=http:\/\/localhost:4102\//);
});
