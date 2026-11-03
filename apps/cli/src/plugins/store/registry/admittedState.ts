import type { PluginStorePaths } from '../paths';
import type { PluginStateFileV1 } from '../state';
import type { PluginRegistryCommitRecord } from './commitRecord';
import type { PluginInstallationStateRevision } from './generationStore';
import { readAdmittedPluginRegistryCommitRecord, readAdmittedPluginRegistryCommitRecordSync } from './commitRecordFile';
import { readAdmittedInstallationStateRevision, readAdmittedInstallationStateRevisionSync } from './installationStateRevisionFile';
import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';

/** Installed replacements own their Machine desired bit while present. */
export function resolveBundledPluginMachineEnablement(params: Readonly<{
  state: PluginStateFileV1;
  bundledPluginEnabledById?: Readonly<Record<string, boolean>>;
}>): Readonly<Record<string, boolean>> {
  const enabledById = { ...params.bundledPluginEnabledById };
  for (const { pluginId } of BUNDLED_FIRST_PARTY_PLUGIN_METADATA) {
    const installed = params.state.plugins[pluginId];
    if (installed) enabledById[pluginId] = installed.state.enabled;
  }
  return Object.freeze(enabledById);
}

function projectAdmittedState(commit: PluginRegistryCommitRecord, revision: PluginInstallationStateRevision) {
  const catalog = revision.runtimeCatalog;
  if (!catalog) throw new Error('Current plugin registry revision has no canonical runtime catalog');
  return { commit, revision, catalog };
}

/** Read-only declarations: never use this result for activation or invocation. */
export async function readAdmittedPluginRegistryState(paths: PluginStorePaths): Promise<Readonly<{
  commit: PluginRegistryCommitRecord;
  revision: PluginInstallationStateRevision;
  catalog: PluginStateFileV1;
}> | null> {
  const commit = await readAdmittedPluginRegistryCommitRecord(paths);
  if (!commit) return null;
  const revision = await readAdmittedInstallationStateRevision({ paths, reference: commit.installationState, commit });
  return projectAdmittedState(commit, revision);
}

/** First-paint readers run before asynchronous runtime admission is available. */
export function readAdmittedPluginRegistryStateSync(paths: PluginStorePaths): Awaited<ReturnType<typeof readAdmittedPluginRegistryState>> {
  const commit = readAdmittedPluginRegistryCommitRecordSync(paths);
  return commit ? projectAdmittedState(commit, readAdmittedInstallationStateRevisionSync({ paths, commit })) : null;
}
