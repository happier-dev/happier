import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { readJsonIfExists } from '../fs/json.mjs';
import { getDefaultAutostartPaths, getStacksStorageRoot, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { resolveDependencyInstallRoot } from '../proc/dependency_refresh.mjs';
import { isPidAlive } from '../proc/pids.mjs';
import { resolveRemoteStackStorageDir } from '../dev_targets/stack_paths.mjs';

export const EXPO_DEPENDENCY_BARRIER_VERSION = 1;

function restartRequired(message) {
  const error = new Error(`${message} Stop the owning Stack once on this target, verify its recorded Expo process has exited, then start again. If ownership cannot be verified, inspect the recorded Expo state and process identity before stopping it.`);
  error.code = 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED';
  return error;
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// Expo's existing PID state is the consumer inventory. Include both the
// canonical storage root and the explicit worker env-file base; no second PID
// registry or port-based termination is involved.
export async function stopExpoDependencyConsumers({ installDir, env = process.env }) {
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
  const consumers = [];
  const seen = new Set();
  const targetRoot = resolve(installDir);
  for (const baseDir of baseDirs) {
    for (const kind of ['expo-dev', 'mobile']) {
      for (const stateDir of await directories(join(baseDir, kind))) {
        const state = await readJsonIfExists(join(stateDir, 'expo.state.json'));
        const runnerDir = String(state?.uiDir ?? state?.projectDir ?? '').trim();
        if (!runnerDir || resolve(resolveDependencyInstallRoot(runnerDir)) !== targetRoot) continue;
        const pid = Number(state.pid);
        if (!Number.isInteger(pid) || pid <= 1 || !isPidAlive(pid) || seen.has(pid)) continue;
        const recordedFingerprint = String(state.processInstanceFingerprint ?? '').trim();
        if (!recordedFingerprint) {
          throw restartRequired(`Expo pid=${pid} has no verified dependency-safe restart owner.`);
        }
        // Stage-zero bootstrap can load without any workspace dist. A live
        // guarded runtime is the only path that needs its compiled OS adapter.
        const { readProcessInstanceFingerprintSync } = await import('@happier-dev/cli-common/processInstance');
        const fingerprint = readProcessInstanceFingerprintSync(pid, { expectedFingerprint: recordedFingerprint || null });
        if (recordedFingerprint && fingerprint && recordedFingerprint !== fingerprint) continue;
        // Old supervisors have already loaded an unguarded restart closure.
        // Never stop one and assume changing files retrofits that live owner.
        if (state.dependencyInstallBarrierVersion !== EXPO_DEPENDENCY_BARRIER_VERSION
          || !recordedFingerprint || !fingerprint) {
          throw restartRequired(`Expo pid=${pid} has no verified dependency-safe restart owner.`);
        }
        seen.add(pid);
        consumers.push({ pid, state, baseDir, fingerprint });
      }
    }
  }
  // Validate every consumer before stopping any; a legacy sibling must reject
  // the whole mutation while every current reader still has its admitted tree.
  for (const { pid, state, baseDir, fingerprint } of consumers) {
    const { killProcessGroupOwnedByStack } = await import('../proc/ownership.mjs');
    const stopped = await killProcessGroupOwnedByStack(pid, {
      stackName: state.stackName || basename(baseDir),
      envPath: state.envPath || join(baseDir, 'env'),
      cliHomeDir: state.cliHomeDir || '',
      label: 'Expo dependency consumer', json: true,
      processInstanceFingerprint: fingerprint,
    });
    if (!stopped.killed) {
      throw restartRequired(`Cannot stop verified Expo pid=${pid}: ${stopped.reason}.`);
    }
  }
}
