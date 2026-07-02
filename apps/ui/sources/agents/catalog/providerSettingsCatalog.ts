import type { ProviderSettingsBehavior, ProviderSettingsDescriptor, ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';
import { BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS } from '@/agents/registry/generatedBundledPluginEntries.providerSettings';
import {
    createProviderSettingsPluginFromDescriptor,
    HOST_PROVIDER_SETTINGS_PLUGINS,
} from './providerSettingsDescriptorAdapters';
import { assertProviderSettingsDescriptorsValid, assertProviderSettingsPluginsValid } from './providerSettingsCatalogValidation';

export { assertProviderSettingsDescriptorsValid, assertProviderSettingsPluginsValid } from './providerSettingsCatalogValidation';

function pickProviderSettingsDescriptor(plugin: ProviderSettingsPlugin): ProviderSettingsDescriptor {
    const { providerId, title, icon, settings, uiSections, subagentSettingsSections } = plugin;
    return {
        providerId,
        title,
        icon,
        settings,
        uiSections,
        subagentSettingsSections,
    };
}

function pickProviderSettingsBehavior(plugin: ProviderSettingsPlugin): ProviderSettingsBehavior {
    const { providerId, ExtraSectionsComponent } = plugin;
    return {
        providerId,
        ExtraSectionsComponent,
    };
}

function normalizeProviderId(providerId: string | null | undefined): string {
    return String(providerId ?? '').trim().toLowerCase();
}

function buildProviderSettingsPluginRegistry(plugins: readonly ProviderSettingsPlugin[]): Readonly<Record<string, ProviderSettingsPlugin>> {
    const registry: Record<string, ProviderSettingsPlugin> = {};
    for (const plugin of plugins) {
        registry[normalizeProviderId(plugin.providerId)] = plugin;
    }
    return Object.freeze(registry);
}

function buildProviderSettingsEntryRegistry<TEntry extends { providerId: string }>(
    entries: readonly TEntry[],
): Readonly<Record<string, TEntry>> {
    const registry: Record<string, TEntry> = {};
    for (const entry of entries) {
        registry[normalizeProviderId(entry.providerId)] = entry;
    }
    return Object.freeze(registry);
}

const GENERATED_PROVIDER_SETTINGS_PLUGINS = BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS
    .map(createProviderSettingsPluginFromDescriptor)
    .filter((plugin): plugin is ProviderSettingsPlugin => plugin !== null);

export const PROVIDER_SETTINGS_PLUGINS = [
    ...GENERATED_PROVIDER_SETTINGS_PLUGINS,
    ...HOST_PROVIDER_SETTINGS_PLUGINS,
] as const satisfies readonly ProviderSettingsPlugin[];

const PROVIDER_SETTINGS_PLUGIN_BY_ID = buildProviderSettingsPluginRegistry(PROVIDER_SETTINGS_PLUGINS);

export const PROVIDER_SETTINGS_DESCRIPTORS = PROVIDER_SETTINGS_PLUGINS.map(pickProviderSettingsDescriptor) as readonly ProviderSettingsDescriptor[];
export const PROVIDER_SETTINGS_BEHAVIORS = PROVIDER_SETTINGS_PLUGINS.map(pickProviderSettingsBehavior) as readonly ProviderSettingsBehavior[];
const PROVIDER_SETTINGS_DESCRIPTOR_BY_ID = buildProviderSettingsEntryRegistry(PROVIDER_SETTINGS_DESCRIPTORS);
const PROVIDER_SETTINGS_BEHAVIOR_BY_ID = buildProviderSettingsEntryRegistry(PROVIDER_SETTINGS_BEHAVIORS);

assertProviderSettingsPluginsValid(PROVIDER_SETTINGS_PLUGINS);
assertProviderSettingsDescriptorsValid(PROVIDER_SETTINGS_DESCRIPTORS);

export type ProviderSettingsRegistryEntry = Readonly<{
    providerId: string;
    plugin: ProviderSettingsPlugin | null;
    descriptor: ProviderSettingsDescriptor | null;
    behavior: ProviderSettingsBehavior | null;
    registered: boolean;
}>;

export function getProviderSettingsDescriptor(providerId: string | null | undefined): ProviderSettingsDescriptor | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) return null;
    return PROVIDER_SETTINGS_DESCRIPTOR_BY_ID[normalizedProviderId] ?? null;
}

export function getProviderSettingsBehavior(providerId: string | null | undefined): ProviderSettingsBehavior | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) return null;
    return PROVIDER_SETTINGS_BEHAVIOR_BY_ID[normalizedProviderId] ?? null;
}

export function getProviderSettingsPlugin(providerId: string | null | undefined): ProviderSettingsPlugin | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) return null;
    return PROVIDER_SETTINGS_PLUGIN_BY_ID[normalizedProviderId] ?? null;
}

export function resolveProviderSettingsRegistryEntry(providerId: string | null | undefined): ProviderSettingsRegistryEntry {
    const resolvedProviderId = String(providerId ?? '').trim();
    const normalizedProviderId = normalizeProviderId(resolvedProviderId);
    if (!normalizedProviderId) {
        return {
            providerId: '',
            plugin: null,
            descriptor: null,
            behavior: null,
            registered: false,
        };
    }

    const plugin = getProviderSettingsPlugin(normalizedProviderId);
    return {
        providerId: resolvedProviderId,
        plugin,
        descriptor: plugin ? pickProviderSettingsDescriptor(plugin) : null,
        behavior: plugin ? pickProviderSettingsBehavior(plugin) : null,
        registered: plugin !== null,
    };
}
