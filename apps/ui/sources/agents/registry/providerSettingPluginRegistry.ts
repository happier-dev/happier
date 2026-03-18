import type { AgentId } from '@/agents/catalog/catalog';
import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

import { providerSettingPlugins, providerSettingPluginArtifactsById } from './providerSettingArtifacts';

export function assertProviderSettingPluginsValid(plugins: readonly ProviderSettingsPlugin[]): void {
    const providerIds = new Set<string>();
    const globalSettingKeys = new Map<string, string>();
    const errors: string[] = [];

    for (const plugin of plugins) {
        const providerId = String(plugin.providerId).trim().toLowerCase();
        if (!providerId) {
            errors.push('Provider settings plugin has an empty providerId');
            continue;
        }
        if (providerIds.has(providerId)) {
            errors.push(`Duplicate providerId "${providerId}" in provider setting plugins`);
        } else {
            providerIds.add(providerId);
        }

        const shapeKeys = new Set(Object.keys(plugin.settingsShape));
        const defaultKeys = new Set(Object.keys(plugin.settingsDefaults));

        for (const key of shapeKeys) {
            const owner = globalSettingKeys.get(key);
            if (owner && owner !== providerId) {
                errors.push(`Duplicate settings key "${key}" across providers "${owner}" and "${providerId}"`);
            } else {
                globalSettingKeys.set(key, providerId);
            }

            if (!defaultKeys.has(key)) {
                errors.push(`Provider "${providerId}" has missing defaults for settingsShape key "${key}"`);
            }
        }

        for (const key of defaultKeys) {
            if (!shapeKeys.has(key)) {
                errors.push(`Provider "${providerId}" has settingsDefaults key "${key}" that is not in settingsShape`);
            }
        }

        for (const section of plugin.uiSections) {
            for (const field of section.fields) {
                if (!shapeKeys.has(field.key)) {
                    errors.push(`Provider "${providerId}" field "${field.key}" is missing from settingsShape`);
                    continue;
                }

                if (field.kind !== 'json') continue;
                const schema = plugin.settingsShape[field.key];
                const acceptsEmpty = schema.safeParse('').success;
                const acceptsValidJsonObject = schema.safeParse('{"ok":true}').success;
                const acceptsInvalidJson = schema.safeParse('{ not-valid-json }').success;
                if (!acceptsEmpty || !acceptsValidJsonObject || acceptsInvalidJson) {
                    errors.push(
                        `Provider "${providerId}" JSON field "${field.key}" must accept empty + valid JSON object strings and reject invalid JSON`,
                    );
                }
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(`Invalid provider setting plugin registry:\n- ${errors.join('\n- ')}`);
    }
}

export const PROVIDER_SETTING_PLUGINS: readonly ProviderSettingsPlugin[] = providerSettingPlugins;

assertProviderSettingPluginsValid(PROVIDER_SETTING_PLUGINS);

export function getProviderSettingPlugin(providerId: AgentId): ProviderSettingsPlugin | null {
    const normalizedProviderId = String(providerId ?? '').trim().toLowerCase();
    if (!normalizedProviderId) return null;
    return (providerSettingPluginArtifactsById as Record<string, ProviderSettingsPlugin | undefined>)[normalizedProviderId] ?? null;
}
