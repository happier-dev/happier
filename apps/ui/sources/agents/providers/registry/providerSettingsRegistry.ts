import type { AgentId } from '@/agents/registry/registryCore';

import type { ProviderSettingsBehavior, ProviderSettingsDescriptor, ProviderSettingsPlugin } from '../shared/providerSettingsPlugin';
import { AUGGIE_PROVIDER_SETTINGS_PLUGIN } from '../auggie/settings/plugin';
import { CLAUDE_PROVIDER_SETTINGS_PLUGIN } from '../claude/settings/plugin';
import { CODEX_PROVIDER_SETTINGS_PLUGIN } from '../codex/settings/plugin';
import { GEMINI_PROVIDER_SETTINGS_PLUGIN } from '../gemini/settings/plugin';
import { KILO_PROVIDER_SETTINGS_PLUGIN } from '../kilo/settings/plugin';
import { KIMI_PROVIDER_SETTINGS_PLUGIN } from '../kimi/settings/plugin';
import { KIRO_PROVIDER_SETTINGS_PLUGIN } from '../kiro/settings/plugin';
import { CUSTOM_ACP_PROVIDER_SETTINGS_PLUGIN } from '../customAcp/settings/plugin';
import { OPENCODE_PROVIDER_SETTINGS_PLUGIN } from '../opencode/settings/plugin';
import { PI_PROVIDER_SETTINGS_PLUGIN } from '../pi/settings/plugin';
import { QWEN_PROVIDER_SETTINGS_PLUGIN } from '../qwen/settings/plugin';
import { COPILOT_PROVIDER_SETTINGS_PLUGIN } from '../copilot/settings/plugin';
import { assertProviderSettingsDescriptorsValid } from './providerSettingsRegistryValidation';
export { assertProviderSettingsDescriptorsValid, assertProviderSettingsPluginsValid } from './providerSettingsRegistryValidation';

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
    const { providerId, ExtraSectionsComponent, buildOutgoingMessageMetaExtras } = plugin;
    return {
        providerId,
        ExtraSectionsComponent,
        buildOutgoingMessageMetaExtras,
    };
}

function normalizeProviderId(providerId: AgentId): string {
    return String(providerId ?? '').trim().toLowerCase();
}

function buildProviderSettingsPluginRegistry(plugins: readonly ProviderSettingsPlugin[]): Readonly<Record<string, ProviderSettingsPlugin>> {
    const registry: Record<string, ProviderSettingsPlugin> = {};
    for (const plugin of plugins) {
        registry[normalizeProviderId(plugin.providerId)] = plugin;
    }
    return Object.freeze(registry);
}

function buildProviderSettingsEntryRegistry<TEntry extends { providerId: AgentId }>(
    entries: readonly TEntry[],
): Readonly<Record<string, TEntry>> {
    const registry: Record<string, TEntry> = {};
    for (const entry of entries) {
        registry[normalizeProviderId(entry.providerId)] = entry;
    }
    return Object.freeze(registry);
}

export const PROVIDER_SETTINGS_PLUGINS = [
    CLAUDE_PROVIDER_SETTINGS_PLUGIN,
    CODEX_PROVIDER_SETTINGS_PLUGIN,
    OPENCODE_PROVIDER_SETTINGS_PLUGIN,
    GEMINI_PROVIDER_SETTINGS_PLUGIN,
    AUGGIE_PROVIDER_SETTINGS_PLUGIN,
    QWEN_PROVIDER_SETTINGS_PLUGIN,
    KIMI_PROVIDER_SETTINGS_PLUGIN,
    KILO_PROVIDER_SETTINGS_PLUGIN,
    KIRO_PROVIDER_SETTINGS_PLUGIN,
    CUSTOM_ACP_PROVIDER_SETTINGS_PLUGIN,
    PI_PROVIDER_SETTINGS_PLUGIN,
    COPILOT_PROVIDER_SETTINGS_PLUGIN,
] as const satisfies readonly ProviderSettingsPlugin[];

const PROVIDER_SETTINGS_PLUGIN_BY_ID = buildProviderSettingsPluginRegistry(PROVIDER_SETTINGS_PLUGINS);

export const PROVIDER_SETTINGS_DESCRIPTORS = PROVIDER_SETTINGS_PLUGINS.map(pickProviderSettingsDescriptor) as readonly ProviderSettingsDescriptor[];
export const PROVIDER_SETTINGS_BEHAVIORS = PROVIDER_SETTINGS_PLUGINS.map(pickProviderSettingsBehavior) as readonly ProviderSettingsBehavior[];
const PROVIDER_SETTINGS_DESCRIPTOR_BY_ID = buildProviderSettingsEntryRegistry(PROVIDER_SETTINGS_DESCRIPTORS);
const PROVIDER_SETTINGS_BEHAVIOR_BY_ID = buildProviderSettingsEntryRegistry(PROVIDER_SETTINGS_BEHAVIORS);

assertProviderSettingsDescriptorsValid(PROVIDER_SETTINGS_DESCRIPTORS);

export function getProviderSettingsDescriptor(providerId: AgentId): ProviderSettingsDescriptor | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) return null;
    return PROVIDER_SETTINGS_DESCRIPTOR_BY_ID[normalizedProviderId] ?? null;
}

export function getProviderSettingsBehavior(providerId: AgentId): ProviderSettingsBehavior | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) return null;
    return PROVIDER_SETTINGS_BEHAVIOR_BY_ID[normalizedProviderId] ?? null;
}

export function getProviderSettingsRuntime(providerId: AgentId): ProviderSettingsBehavior | null {
    return getProviderSettingsBehavior(providerId);
}

export function getProviderSettingsPlugin(providerId: AgentId): ProviderSettingsPlugin | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) return null;
    return PROVIDER_SETTINGS_PLUGIN_BY_ID[normalizedProviderId] ?? null;
}
