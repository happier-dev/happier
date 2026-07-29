import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStackScriptWithStackEnv } from './run_script_with_stack_env.mjs';

test('start-like JSON wrapper probes preserve daemon membership and fingerprint bytes', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hstack-wrapper-json-read-only-'));
  const storageDir = join(fixtureRoot, 'stacks');
  const stackName = 'json-read-only';
  const stackDir = join(storageDir, stackName);
  const rootDir = join(fixtureRoot, 'repo');
  const runtimeStatePath = join(stackDir, 'stack.runtime.json');
  const previousStorageDir = process.env.HAPPIER_STACK_STORAGE_DIR;
  t.after(async () => {
    if (previousStorageDir == null) delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = previousStorageDir;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  await mkdir(join(rootDir, 'scripts'), { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n', 'utf8');
  await writeFile(join(rootDir, 'scripts', 'dev.mjs'), 'console.log(JSON.stringify({ mode: "dev", dryRun: true }));\n', 'utf8');
  await writeFile(join(rootDir, 'scripts', 'run.mjs'), 'console.log(JSON.stringify({ mode: "start", dryRun: true }));\n', 'utf8');

  const runtimeBytes = JSON.stringify({
    version: 1,
    stackName,
    ownerPid: null,
    startedAt: '2026-07-21T08:00:00.000Z',
    processes: { daemonPid: 999_999_991, daemonPids: [999_999_991] },
    daemon: { distClosureFingerprint: 'fingerprint-must-survive-json-probe' },
  }, null, 2) + '\n';
  await writeFile(runtimeStatePath, runtimeBytes, 'utf8');

  for (const scriptPath of ['dev.mjs', 'run.mjs']) {
    // eslint-disable-next-line no-await-in-loop
    await runStackScriptWithStackEnv({ rootDir, stackName, scriptPath, args: ['--json'] });
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await readFile(runtimeStatePath, 'utf8'), runtimeBytes, `${scriptPath} JSON probe rewrote runtime state`);
  }
});
