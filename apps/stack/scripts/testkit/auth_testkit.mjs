import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildStackFixtureEnv } from './core/env_scope.mjs';
import { runNodeCapture as runNodeCaptureCore } from './core/run_node_capture.mjs';
import { resolveHstackBinPath, resolveStackRootFromMeta, resolveStackScriptPath } from './core/stack_root.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export function getStackRootFromMeta(metaUrl) {
  return resolveStackRootFromMeta(metaUrl);
}

export function hstackBinPath(rootDir) {
  return resolveHstackBinPath(rootDir);
}

export function authScriptPath(rootDir) {
  return resolveStackScriptPath(rootDir, 'auth.mjs');
}

export const runNodeCapture = runNodeCaptureCore;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export async function terminateChildProcess(child, { signal = 'SIGTERM', timeoutMs = 800 } = {}) {
  if (!child) return true;
  if (child.exitCode != null) return true;
  const waitForExit = new Promise((resolve) => {
    child.once('exit', () => resolve());
  });

  try {
    child.kill(signal);
  } catch {}
  await Promise.race([waitForExit, wait(timeoutMs)]);
  if (child.exitCode == null) {
    try {
      child.kill('SIGKILL');
    } catch {}
    await Promise.race([waitForExit, wait(timeoutMs)]);
  }
  return !isPidAlive(child.pid);
}

export async function createAuthStackFixture({
  t,
  prefix,
  stackName = 'main',
  stackEnvLines = [],
}) {
  const fixture = await createTempFixture(t, { prefix });
  const tmpDir = fixture.root;
  const storageDir = join(tmpDir, 'storage');
  await mkdir(join(storageDir, stackName), { recursive: true });
  const envPath = join(storageDir, stackName, 'env');
  await writeFile(envPath, [...stackEnvLines, ''].join('\n'), 'utf-8');

  return {
    tmpDir,
    storageDir,
    envPath,
    buildEnv(extra = {}) {
      return buildStackFixtureEnv({
        storageDir,
        stackName,
        envPath,
        extraEnv: extra,
      });
    },
    async cleanup() {
      await fixture.cleanup();
    },
  };
}
