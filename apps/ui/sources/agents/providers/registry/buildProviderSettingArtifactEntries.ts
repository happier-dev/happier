import { buildSettingArtifacts, type SettingArtifacts } from '@happier-dev/protocol';

import type { ProviderSettingsPlugin } from '../shared/providerSettingsPlugin';

export type ProviderSettingArtifactEntry<TPlugin extends ProviderSettingsPlugin = ProviderSettingsPlugin> = Readonly<{
    plugin: TPlugin;
    artifacts: SettingArtifacts<TPlugin['settings']>;
}>;

export function buildProviderSettingArtifactEntries<const TPlugins extends readonly ProviderSettingsPlugin[]>(
    plugins: TPlugins,
): { readonly [TIndex in keyof TPlugins]: ProviderSettingArtifactEntry<TPlugins[TIndex]> } {
    return plugins.map((plugin) => ({
        plugin,
        artifacts: buildSettingArtifacts(plugin.settings),
    })) as { readonly [TIndex in keyof TPlugins]: ProviderSettingArtifactEntry<TPlugins[TIndex]> };
}
