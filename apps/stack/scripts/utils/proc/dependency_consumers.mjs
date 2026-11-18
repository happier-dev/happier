import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { readJsonIfExists } from '../fs/json.mjs';
import { getDefaultAutostartPaths, getRepoDir, getStacksStorageRoot, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { resolveDependencyInstallRoot } from './dependency_refresh.mjs';
import { resolveRemoteStackStorageDir } from '../dev_targets/stack_paths.mjs';
import { readEnvValueFromFile } from '../env/read.mjs';
import { getStackRuntimeProcessEntries, getStackRuntimeProcessInstanceFingerprint } from '../stack/runtime_processes.mjs';

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// This inventory supplies restart advice, and the live processes of those
// Stacks (a generation switch retains the replaced generation for them).
// Installers neither wait for starting stacks nor acquire process lifecycle
// authority over their readers.
// A Stack runs only while the runtime owner trusts its recorded process: start
// witness, boot and this Stack's launch binding (hasTrustedStackRuntimeLifecycle
// composes the same check). A recycled PID in a stale record pinned replaced
// generations indefinitely. An inconclusive observation keeps the process.
async function trustedStackPids(baseDir, envPath, candidates) {
  // Loaded on demand: runtime_state imports dependency_refresh, this module's importer.
  const { isStackRuntimeProcessTrusted } = await import('../stack/runtime_state.mjs');
  const context = { stackName: basename(baseDir), envPath, cliHomeDir: join(baseDir, 'cli') };
  const trusted = [];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await isStackRuntimeProcessTrusted(candidate.pid, { ...context, ...candidate }, { throwOnInconclusive: true })) trusted.push(candidate.pid);
    } catch (error) {
      if (error?.code !== 'ESTACKRUNTIMEPROCESSINCONCLUSIVE' && error?.code !== 'EPROCESSIDENTITYINCONCLUSIVE') throw error;
      trusted.push(candidate.pid);
    }
  }
  return trusted;
}

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
  const processes = new Set();
  const targetRoot = resolve(installDir);
  for (const baseDir of baseDirs) {
    const envPath = explicitEnvFile && resolve(dirname(explicitEnvFile)) === resolve(baseDir)
      ? explicitEnvFile : join(baseDir, 'env');
    const repoDir = await readEnvValueFromFile(envPath, 'HAPPIER_STACK_REPO_DIR');
    if (repoDir && resolve(resolveDependencyInstallRoot(getRepoDir(baseDir, { ...env, HAPPIER_STACK_REPO_DIR: repoDir }))) === targetRoot) {
      const state = await readJsonIfExists(join(baseDir, 'stack.runtime.json'));
      const ownerPid = Number(state?.ownerPid);
      const live = !state ? [] : await trustedStackPids(baseDir, envPath, [
        ...(Number.isInteger(ownerPid) && ownerPid > 1 ? [{ key: 'ownerPid', pid: ownerPid,
          processInstanceFingerprint: getStackRuntimeProcessInstanceFingerprint(state, 'ownerPid', ownerPid) }] : []),
        ...getStackRuntimeProcessEntries(state),
      ].map(entry => ({ ...entry, recordedStartedAt: state.startedAt ?? null })));
      if (live.length) stacksNeedingRestart.add(basename(baseDir));
      for (const pid of live) processes.add(pid);
    }
    for (const kind of ['expo-dev', 'mobile']) {
      for (const stateDir of await directories(join(baseDir, kind))) {
        const state = await readJsonIfExists(join(stateDir, 'expo.state.json'));
        const runnerDir = String(state?.uiDir ?? state?.projectDir ?? '').trim();
        if (!runnerDir || resolve(resolveDependencyInstallRoot(runnerDir)) !== targetRoot) continue;
        const pid = Number(state.pid);
        if (!Number.isInteger(pid) || pid <= 1) continue;
        // eslint-disable-next-line no-await-in-loop
        if (!(await trustedStackPids(baseDir, envPath, [{ key: kind, pid,
          processInstanceFingerprint: state.processInstanceFingerprint ?? null, recordedStartedAt: state.startedAt ?? null }])).length) continue;
        stacksNeedingRestart.add(basename(baseDir));
        processes.add(pid);
      }
    }
  }
  return { stacksNeedingRestart: [...stacksNeedingRestart].sort(), processes: [...processes].sort((a, b) => a - b) };
}
