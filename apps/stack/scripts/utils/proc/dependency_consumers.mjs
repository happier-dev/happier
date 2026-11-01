import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { readJsonIfExists } from '../fs/json.mjs';
import { getDefaultAutostartPaths, getRepoDir, getStacksStorageRoot, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { resolveDependencyInstallRoot } from './dependency_refresh.mjs';
import { isPidAlive } from './pids.mjs';
import { resolveRemoteStackStorageDir } from '../dev_targets/stack_paths.mjs';
import { readEnvValueFromFile } from '../env/read.mjs';
import { hasLiveStackRuntimeProcesses } from '../stack/runtime_processes.mjs';

// Retained as passive metadata for the existing Expo lifecycle publisher.
export const EXPO_DEPENDENCY_BARRIER_VERSION = 1;

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// This inventory supplies restart advice only. Installers neither wait for
// starting stacks nor acquire process lifecycle authority over their readers.
export async function prepareDependencyConsumersForRefresh({ installDir, env = process.env }) {
  const baseDirs = new Set(await directories(getStacksStorageRoot(env)));
  // Both remote bootstrap dispatchers provide cache=<targetHome>/cache even
  // when no running Stack env is inherited. Consume that same target context
  // through the managed Stack path owner, not the controller's default home.
  const targetCacheDir = String(env.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').trim();
  if (targetCacheDir) {
    for (const baseDir of await directories(resolveRemoteStackStorageDir(dirname(targetCacheDir)))) {
      baseDirs.add(baseDir);
    }
  }
  baseDirs.add(getDefaultAutostartPaths(env).baseDir);
  const explicitEnvFile = resolveExplicitStackEnvFilePath(env);
  if (explicitEnvFile) baseDirs.add(dirname(explicitEnvFile));
  const stacksNeedingRestart = new Set();
  const targetRoot = resolve(installDir);
  for (const baseDir of baseDirs) {
    const envPath = explicitEnvFile && resolve(dirname(explicitEnvFile)) === resolve(baseDir)
      ? explicitEnvFile : join(baseDir, 'env');
    const repoDir = await readEnvValueFromFile(envPath, 'HAPPIER_STACK_REPO_DIR');
    if (repoDir && resolve(resolveDependencyInstallRoot(getRepoDir(baseDir, { ...env, HAPPIER_STACK_REPO_DIR: repoDir }))) === targetRoot) {
      const state = await readJsonIfExists(join(baseDir, 'stack.runtime.json'));
      if (isPidAlive(Number(state?.ownerPid)) || (state && hasLiveStackRuntimeProcesses(state))) {
        stacksNeedingRestart.add(basename(baseDir));
      }
    }
    for (const kind of ['expo-dev', 'mobile']) {
      for (const stateDir of await directories(join(baseDir, kind))) {
        const state = await readJsonIfExists(join(stateDir, 'expo.state.json'));
        const runnerDir = String(state?.uiDir ?? state?.projectDir ?? '').trim();
        if (!runnerDir || resolve(resolveDependencyInstallRoot(runnerDir)) !== targetRoot) continue;
        const pid = Number(state.pid);
        if (!Number.isInteger(pid) || pid <= 1 || !isPidAlive(pid)) continue;
        stacksNeedingRestart.add(basename(baseDir));
      }
    }
  }
  return { stacksNeedingRestart: [...stacksNeedingRestart].sort() };
}
