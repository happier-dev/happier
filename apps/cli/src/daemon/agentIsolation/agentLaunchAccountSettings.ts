import { join } from 'node:path';
import { logger } from '@/utils/logger';
import { resolveAuthoritativePackagedRuntimeCustody } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS, BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createBundledActivationSourceResolver, resolvePackagedBundledActivationPaths } from '@/plugins/runtime/bundledActivationSource';
import { classifyPluginModuleFailure, readPluginModuleFailureCause } from '@/plugins/runtime/moduleFailure';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { projectAgentAccountSettingsCatalogEntry } from '@/plugins/projection/registry/agentAccountSettingsCatalogEntry';
import { AGENT_LAUNCH_NATIVE_HOME_RELATIVE_PATH, type AgentLaunchPayload } from './agentLaunchFrame';
import packageJson from '../../../package.json' with { type: 'json' };

/** Private same-build bundled code only; no Account credentials, store, or module locator crosses the frame. */
export async function applyAgentLaunchAccountSettings(payload: AgentLaunchPayload, signal?: AbortSignal): Promise<void> {
  const input = payload.accountSettingsApplication;
  if (!input) return;
  signal?.throwIfAborted();
  const unavailable = () => logger.warn('[PLUGIN RUNTIME] Optional member Account settings are unavailable for this bundled Agent; application skipped');
  if (input.cliVersion !== packageJson.version) { unavailable(); return; }
  const admitted = loadCurrentBundledPluginLocatorResult({ pluginIds: [input.pluginId] });
  const declaration = admitted.loadedPlugins.find(plugin => plugin.pluginId === input.pluginId);
  if (!declaration || declaration.sourceSpec.kind !== 'bundled'
    || declaration.manifest.version !== input.pluginVersion
    || !declaration.manifest.contributes.agents.some(agent => agent.id === input.localAgentId && agent.accountSettings)) {
    unavailable(); return;
  }
  const packaged = resolveAuthoritativePackagedRuntimeCustody();
  const paths = packaged ? resolvePackagedBundledActivationPaths({ runtimeRoot: packaged.root,
    activationTargets: [declaration], metadata: BUNDLED_FIRST_PARTY_PLUGIN_METADATA,
    locators: BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS }) : null;
  const resolveSource = createBundledActivationSourceResolver({
    bundledPackageNames: [declaration.sourceSpec.locator], bundledDeclarations: [declaration], signal,
    ...(paths ? { immutableArtifactPackageNames: [...paths.entryPathsByPackageName.keys()],
      immutableArtifactEntryPathsByPackageName: paths.entryPathsByPackageName,
      immutableArtifactRootPathsByPackageName: paths.rootPathsByPackageName } : {}),
    ...(packaged ? { packagedRuntime: packaged.packagedRuntime, packagedRuntimeRoot: packaged.root } : {}),
  });
  const source = resolveSource(declaration);
  if (!source) { unavailable(); return; }
  const moduleNamespace = await (async () => {
    try {
      await source.prepare?.();
      signal?.throwIfAborted();
      return await source.load();
    } catch (error) {
      signal?.throwIfAborted();
      const cause = classifyPluginModuleFailure(error);
      if (!['ENOENT', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'PLUGIN_DAEMON_ENTRY_MISSING'].includes(cause.code)) throw error;
      logger.warn('[PLUGIN RUNTIME] Optional member Account settings module is unavailable; application skipped',
        { phase: cause.phase, code: cause.code });
      return null;
    }
  })();
  if (!moduleNamespace) return;
  signal?.throwIfAborted();
  const activation = await activateContributionModule({ pluginId: input.pluginId,
    manifestAuthority: 'bundled_first_party', occurrenceId: 'member-launch', manifest: declaration.manifest,
    moduleNamespace, resolveRelativeModule: source.resolveRelativeModule,
    isOccurrenceCurrent: () => !signal?.aborted });
  try {
    signal?.throwIfAborted();
    const registration = activation.registrations.find(entry => entry.family === 'agents' && entry.localId === input.localAgentId);
    if (activation.status !== 'active') {
      const cause = activation.diagnostics.map(entry => readPluginModuleFailureCause(entry.details)).find(Boolean);
      logger.warn('[PLUGIN RUNTIME] Optional member Account settings activation is unavailable; application skipped',
        cause ? { phase: cause.phase, code: cause.code } : { status: activation.status });
      return;
    }
    if (registration?.family !== 'agents' || !registration.value.accountSettings) { unavailable(); return; }
    const catalog = projectAgentAccountSettingsCatalogEntry({ pluginId: input.pluginId, localAgentId: input.localAgentId,
      accountSettings: registration.value.accountSettings, declarations: declaration.manifest.contributes.settings,
      isCurrent: () => !signal?.aborted, resolvePluginSettings: async () => null });
    // The provider owns its opaque report and any configuration-failure warning.
    // This retained member home is never claimed by the host Machine's sweep.
    await catalog.applyAccountSettings!([{ id: 'native', directory: join(payload.runtimeHome, AGENT_LAUNCH_NATIVE_HOME_RELATIVE_PATH) }],
      { pluginSettings: { account: input.account } });
    signal?.throwIfAborted();
  } finally { await activation.dispose(); }
}
