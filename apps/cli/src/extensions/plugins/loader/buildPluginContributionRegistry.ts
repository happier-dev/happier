import type {
  BackendDefinitionV1,
  HookRegistrationV1,
  ProviderDefinitionV1,
} from '@happier-dev/protocol';

import type { LoadedPlugin } from './loadInstalledPlugins';

export type PluginOwnedContribution<T> = Readonly<{
  pluginId: string;
  pluginRootPath: string;
  manifestPath: string;
  manifestDigest: string;
  daemonEntryPath: string | null;
  definition: T;
}>;

export type PluginContributionRegistry = Readonly<{
  providers: readonly PluginOwnedContribution<ProviderDefinitionV1>[];
  backends: readonly PluginOwnedContribution<BackendDefinitionV1>[];
  hooks: readonly PluginOwnedContribution<HookRegistrationV1>[];
}>;

export function buildPluginContributionRegistry(params: Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
}>): PluginContributionRegistry {
  const providers: PluginOwnedContribution<ProviderDefinitionV1>[] = [];
  const backends: PluginOwnedContribution<BackendDefinitionV1>[] = [];
  const hooks: PluginOwnedContribution<HookRegistrationV1>[] = [];

  for (const plugin of params.loadedPlugins) {
    for (const definition of plugin.manifest.contributions.providers) {
      providers.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        definition,
      });
    }

    for (const definition of plugin.manifest.contributions.backends) {
      backends.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        definition,
      });
    }

    for (const definition of plugin.manifest.contributions.hooks) {
      hooks.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        manifestDigest: plugin.manifestDigest,
        daemonEntryPath: plugin.daemonEntryPath,
        definition,
      });
    }
  }

  return Object.freeze({
    providers: Object.freeze(providers),
    backends: Object.freeze(backends),
    hooks: Object.freeze(hooks),
  });
}
