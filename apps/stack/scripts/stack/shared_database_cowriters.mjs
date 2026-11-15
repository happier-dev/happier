import { hostname } from 'node:os';
import { join } from 'node:path';

import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { listAllStackNames } from '../utils/stack/stacks.mjs';
import { hasTrustedStackRuntimeLifecycle, isStackRuntimeProcessTrusted, readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
import { resolveRuntimeRemoteServiceObservation } from '../utils/tui/runtime_placement_summary.mjs';
import { readRuntimeManifest, readRuntimePointer } from '../runtime/shared/runtime_manifest.mjs';
import { resolveStackRuntimePaths } from '../runtime/shared/runtime_paths.mjs';
import { projectLoadedRuntimeSnapshotId, readLoadedSourceRuntimeIdentities } from '../runtime/shared/loaded_runtime_identity.mjs';
import { projectStackDatabaseIdentity } from './stack_database_identity.mjs';

function sourceStackFromEnv(env) {
  return projectStackDatabaseIdentity({ sourceStack: env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK }).sourceStack;
}

async function readSnapshotSourceTime({ baseDir, loadedSnapshotId, snapshotBaseDir = baseDir }) {
  try {
    if (loadedSnapshotId) {
      const manifest = await readRuntimeManifest({ manifestPath:
        resolveStackRuntimePaths({ stackBaseDir: snapshotBaseDir, snapshotId: loadedSnapshotId }).manifestPath });
      if (manifest?.snapshotId !== loadedSnapshotId || !Number.isFinite(Date.parse(manifest.createdAt))) return null;
      return new Date(manifest.createdAt).toISOString();
    }
  } catch { /* Missing local metadata cannot establish source age. */ }
  return null;
}

async function readRecordedServer(stackName) {
  const { baseDir, envPath } = resolveStackEnvPath(stackName);
  const state = await readStackRuntimeStateFile(join(baseDir, 'stack.runtime.json'));
  const remote = resolveRuntimeRemoteServiceObservation(state, 'server');
  const remoteState = state?.remoteTargets?.[remote.target];
  const processKey = state?.serverProxy?.mode === 'proxy' ? 'serverBackendPid' : 'serverPid';
  const trust = { stackName, envPath, cliHomeDir: join(baseDir, 'cli') };
  // A remote "running" record holds only while the lifecycle that recorded it is still trusted
  // (the same rule as resolveTrustedStackRuntimeServerPort); records left by exited lifecycles are ghosts.
  const running = remote.target
    ? remote.running && await hasTrustedStackRuntimeLifecycle(state, trust, { throwOnInconclusive: false })
    : await isStackRuntimeProcessTrusted(state?.processes?.[processKey], { ...trust, key: processKey },
      { throwOnInconclusive: false });
  if (!running) return null;
  const sourceSnapshot = Boolean(state?.sourceRuntimeIdentities) || remoteState?.runtimeMode === 'source-snapshot';
  const sourceIdentities = await readLoadedSourceRuntimeIdentities({ stackBaseDir: baseDir, runtimeState: state, sourceSnapshot,
    runtimeLifecycleLive: running, serverRunning: running });
  const loadedSourceIdentity = sourceIdentities?.server?.loaded ?? null;
  const loadedSnapshotId = projectLoadedRuntimeSnapshotId({ runtimeState: state, sourceSnapshot, runtimeLifecycleLive: running });
  let snapshotBaseDir = baseDir;
  if (loadedSnapshotId) {
    const pointer = await readRuntimePointer({ currentPath: resolveStackRuntimePaths({ stackBaseDir: baseDir }).currentPath });
    const producer = projectStackDatabaseIdentity({ sourceStack: pointer?.producerStackName }).sourceStack;
    if (producer) snapshotBaseDir = resolveStackEnvPath(producer).baseDir;
  }
  return { loadedSourceIdentity, loadedSnapshotId,
    sourceTime: loadedSourceIdentity ? sourceIdentities?.server?.sourceTime ?? null
      : await readSnapshotSourceTime({ baseDir, loadedSnapshotId, snapshotBaseDir }),
    startedAt: remoteState?.startedAt ?? state?.startedAt ?? null,
    host: remote.target ?? hostname() };
}

function compareSourceTime(current, peer) {
  if ((current.loadedSourceIdentity && current.loadedSourceIdentity === peer.loadedSourceIdentity)
    || (current.loadedSnapshotId && current.loadedSnapshotId === peer.loadedSnapshotId)) return false;
  if (!current.sourceTime || !peer.sourceTime) return null;
  return Date.parse(peer.sourceTime) < Date.parse(current.sourceTime);
}

/** Inventory is a local observation, never a recursive info/transport probe. */
export async function readSharedDatabaseCoWriters({ stackName, database, loadedSourceIdentity,
  loadedSnapshotId, sourceTime, snapshotBaseDir }) {
  if (database.sharedSource && !database.sourceStack) return undefined;
  const sourceStack = database.sourceStack ?? stackName;
  const names = await listAllStackNames();
  const inventory = await Promise.all(names.filter(name => name !== stackName).map(async name => {
    const env = parseEnvToObject(await readTextOrEmpty(resolveStackEnvPath(name).envPath));
    return { stackName: name, sourceStack: sourceStackFromEnv(env) };
  }));
  const related = inventory.filter(row => row.sourceStack === sourceStack
    || (row.stackName === sourceStack && !row.sourceStack));
  if (!database.sharedSource && !related.some(row => row.sourceStack === stackName)) return undefined;
  const current = { loadedSourceIdentity, loadedSnapshotId,
    sourceTime: loadedSourceIdentity ? sourceTime ?? null : await readSnapshotSourceTime({
      baseDir: resolveStackEnvPath(stackName).baseDir, loadedSnapshotId, snapshotBaseDir }) };
  const coWriters = (await Promise.all(related.map(async row => {
    const server = await readRecordedServer(row.stackName);
    return server ? { stackName: row.stackName, role: row.stackName === sourceStack ? 'source' : 'consumer',
      ...server, staleCoWriter: compareSourceTime(current, server) } : null;
  }))).filter(Boolean);
  return { sourceStack, role: database.sharedSource ? 'consumer' : 'source', basis: 'local-stack-state', coWriters };
}

export function formatSharedDatabaseCoWriterLines(sharedDatabase) {
  if (!sharedDatabase) return [];
  return [`- shared database: ${sharedDatabase.sourceStack} (${sharedDatabase.role}; local stack state)`,
    ...(sharedDatabase.coWriters.length ? sharedDatabase.coWriters.map(row =>
      `  ${row.stackName} (${row.role}) host=${row.host} loaded=${row.loadedSourceIdentity ?? row.loadedSnapshotId ?? 'unknown'}`
      + ` started=${row.startedAt ?? 'unknown'} sourceTime=${row.sourceTime ?? 'unknown'} staleCoWriter=${row.staleCoWriter ?? 'unknown'}`)
      : ['  no other running server co-writers recorded'])];
}
