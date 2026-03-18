import * as zod from 'zod';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

import { providerSettingDefinitionsById, type ProviderSettingDefinition } from './providerSettingDefinitions';

export function createProviderSettingsPlugin(definition: ProviderSettingDefinition): ProviderSettingsPlugin {
    return {
        providerId: definition.providerId,
        title: definition.title,
        icon: definition.icon,
        settingsShape: definition.buildSettingsShape(zod),
        settingsDefaults: definition.settingsDefaults,
        uiSections: definition.uiSections,
        buildOutgoingMessageMetaExtras: definition.buildOutgoingMessageMetaExtras,
    };
}

export const providerSettingPluginArtifactsById = {
    claude: createProviderSettingsPlugin(providerSettingDefinitionsById.claude),
    codex: createProviderSettingsPlugin(providerSettingDefinitionsById.codex),
    opencode: createProviderSettingsPlugin(providerSettingDefinitionsById.opencode),
    gemini: createProviderSettingsPlugin(providerSettingDefinitionsById.gemini),
    kiro: createProviderSettingsPlugin(providerSettingDefinitionsById.kiro),
} as const;

export const providerSettingPlugins = Object.freeze(Object.values(providerSettingPluginArtifactsById));

export function getProviderSettingPluginArtifact(providerId: keyof typeof providerSettingPluginArtifactsById): ProviderSettingsPlugin {
    return providerSettingPluginArtifactsById[providerId];
}
