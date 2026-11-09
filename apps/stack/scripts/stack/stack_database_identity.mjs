import { readFile } from 'node:fs/promises';

import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { assertCanonicalManagedStackName } from '../utils/stack/names.mjs';
import { resolveEffectiveDbProvider, resolveSharedDatabaseSource } from '../utils/server/effective_db_provider.mjs';
import { readSelectedSourceRuntimeRecord } from '../runtime/shared/source_bundle_record.mjs';
import { readRuntimeManifest } from '../runtime/shared/runtime_manifest.mjs';
import { resolveStackRuntimePaths } from '../runtime/shared/runtime_paths.mjs';
import { loadDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { resolveDevTargetSshConfigFile } from '../utils/dev_targets/mutagen_runtime.mjs';
import { buildRemoteStackDatabaseIdentityCommand } from '../utils/dev_targets/remote_commands.mjs';
import { runDevTargetControlProcess } from '../utils/dev_targets/sync_project.mjs';

function sourceStackName(value) {
  const name = String(value ?? '').trim();
  if (!name) return null;
  try { assertCanonicalManagedStackName(name, 'shared database source'); return name; }
  catch { return null; }
}

function databaseProvider(value) {
  if (typeof value !== 'string') return null;
  const resolved = resolveEffectiveDbProvider({ serverComponentName: 'happier-server-light',
    env: { HAPPIER_DB_PROVIDER: value } });
  return resolved.ok ? resolved.provider : null;
}

/** The diagnostic transport contains identity only, never environment values. */
export function projectStackDatabaseIdentity(value = {}) {
  const basis = ['configured', 'loaded-source-bundle', 'loaded-runtime-snapshot'].includes(value?.basis)
    ? value.basis : 'unavailable';
  return {
    provider: databaseProvider(value?.provider),
    sharedSource: value?.sharedSource === true,
    sourceStack: sourceStackName(value?.sourceStack),
    filesBackend: ['local', 's3'].includes(value?.filesBackend) ? value.filesBackend : null,
    basis,
    ...(basis.startsWith('loaded-') ? {
      sourceStackBasis: 'configured',
      filesBackendBasis: value?.filesBackendBasis === 'configured' ? 'configured' : 'unavailable',
    } : {}),
  };
}

function unavailable(env) {
  return projectStackDatabaseIdentity({ sharedSource: Boolean(String(env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ?? '').trim()),
    sourceStack: env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK });
}

async function configuredIdentity(env) {
  const identity = unavailable(env);
  try {
    let effectiveEnv = env;
    let provider;
    if (identity.sharedSource) {
      if (!identity.sourceStack || !env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE) return identity;
      effectiveEnv = parseEnvToObject(await readFile(env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE, 'utf8'));
      provider = resolveSharedDatabaseSource({ env: effectiveEnv }).provider;
    } else {
      const resolved = resolveEffectiveDbProvider({ serverComponentName: env.HAPPIER_STACK_SERVER_COMPONENT || 'happier-server-light', env });
      if (!resolved.ok) return identity;
      provider = resolved.provider;
    }
    const { resolveServerFilesBackend } = await import('../utils/server/apply_runtime_server_database_env.mjs');
    return projectStackDatabaseIdentity({ ...identity, provider,
      filesBackend: resolveServerFilesBackend({ env: effectiveEnv }), basis: 'configured' });
  } catch {
    // Resolver errors may include configuration input. Diagnostics expose no values from errors.
    return identity;
  }
}

export async function readLocalStackDatabaseIdentity({ env, stackBaseDir, serverRunning = false,
  sourceSnapshot = false, loadedSourceIdentity, loadedSnapshotId, loadedSnapshotManifest, snapshotBaseDir = stackBaseDir }) {
  const configured = await configuredIdentity(env);
  if (!serverRunning) return configured;
  let provider;
  let basis;
  try {
    if (loadedSourceIdentity) {
      const record = await readSelectedSourceRuntimeRecord({ stackBaseDir, component: 'server', required: false });
      if (record?.identity !== loadedSourceIdentity) return unavailable(env);
      provider = record.dbProvider;
      basis = 'loaded-source-bundle';
    } else if (loadedSnapshotId) {
      const manifest = loadedSnapshotManifest ?? await readRuntimeManifest({ manifestPath:
        resolveStackRuntimePaths({ stackBaseDir: snapshotBaseDir, snapshotId: loadedSnapshotId }).manifestPath });
      if (manifest?.snapshotId !== loadedSnapshotId) return unavailable(env);
      provider = manifest.source?.dbProvider;
      basis = 'loaded-runtime-snapshot';
    } else {
      return sourceSnapshot ? unavailable(env) : configured;
    }
    const identity = projectStackDatabaseIdentity({ ...configured, provider, basis,
      filesBackendBasis: configured.filesBackend ? 'configured' : 'unavailable' });
    return identity.provider ? identity : unavailable(env);
  } catch { return unavailable(env); }
}

/** Reach the existing server host; shared source paths are host-owned references. */
export async function readStackDatabaseIdentity({ stackName, env, runtimeState, localOnly = false,
  configuredOnly = false, runRemoteProcessImpl = runDevTargetControlProcess, ...local }) {
  const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
  if (localOnly) return await readLocalStackDatabaseIdentity({ env, stackBaseDir, ...local });
  const recordedTarget = runtimeState?.placement?.server;
  const remote = recordedTarget && !['local', 'external'].includes(recordedTarget);
  let observeLoadedRemote = false;
  if (!configuredOnly && remote) {
    const state = runtimeState?.remoteTargets?.[recordedTarget];
    if (state?.database !== undefined) return state.database ? projectStackDatabaseIdentity(state.database) : unavailable(env);
    if (runtimeState.stopRequest || state?.phase === 'stop' || state?.status === 'retirement-pending') return unavailable(env);
    observeLoadedRemote = !['stopped', 'not-running'].includes(state?.serviceStatus?.server ?? state?.status);
  }
  const loaded = await loadDevTargetsConfig({ stackName, env: { ...process.env, ...env } }).catch(() => null);
  const placement = loaded?.config.runtimePlacement?.server;
  const targetName = !configuredOnly && remote ? recordedTarget
    : placement?.mode === 'prefer-target' ? placement.target : null;
  if (!targetName) return await readLocalStackDatabaseIdentity({ env, stackBaseDir, ...local });
  const target = loaded?.config.targets.find(candidate => candidate.name === targetName);
  if (!target) return unavailable(env);
  try {
    const configFile = resolveDevTargetSshConfigFile(target, { stackBaseDir, env: { ...process.env, ...env } });
    const result = await runRemoteProcessImpl({ command: 'ssh', silent: true, env: { ...process.env, ...env },
      args: [...(configFile ? ['-F', configFile] : []), '-o', 'BatchMode=yes', target.ssh,
        buildRemoteStackDatabaseIdentityCommand(target, { stackName, configuredOnly: !observeLoadedRemote })] });
    return result.code === 0 ? projectStackDatabaseIdentity(JSON.parse(result.out)) : unavailable(env);
  } catch { return unavailable(env); }
}
