import type { AgentId } from '@/agents/catalog';

import type { ProviderSettingsPlugin } from '../_shared/providerSettingsPlugin';
import { CLAUDE_PROVIDER_SETTINGS_PLUGIN } from '../claude/settings/plugin';

export function assertProviderSettingsPluginsValid(plugins: readonly ProviderSettingsPlugin[]): void {
    const errors: string[] = [];
    const providerIds = new Set<string>();
    const globalSettingKeys = new Map<string, string>();

    for (const plugin of plugins) {
        const providerId = String(plugin.providerId).trim().toLowerCase();
        if (!providerId) {
            errors.push('Provider settings plugin has an empty providerId');
            continue;
        }
        if (providerIds.has(providerId)) {
            errors.push(`Duplicate providerId "${providerId}" in provider settings plugins`);
        } else {
            providerIds.add(providerId);
        }

        const shapeKeys = new Set(Object.keys(plugin.settingsShape));
        const defaultsKeys = new Set(Object.keys(plugin.settingsDefaults));

        for (const key of shapeKeys) {
            const owner = globalSettingKeys.get(key);
            if (owner && owner !== providerId) {
                errors.push(`Duplicate settings key "${key}" across providers "${owner}" and "${providerId}"`);
            } else {
                globalSettingKeys.set(key, providerId);
            }
            if (!defaultsKeys.has(key)) {
                errors.push(`Provider "${providerId}" has missing defaults for settingsShape key "${key}"`);
            }
        }

        for (const key of defaultsKeys) {
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
        throw new Error(`Invalid provider settings plugin registry:\n- ${errors.join('\n- ')}`);
    }
}

export const PROVIDER_SETTINGS_PLUGINS: readonly ProviderSettingsPlugin[] = [
    CLAUDE_PROVIDER_SETTINGS_PLUGIN,
];

assertProviderSettingsPluginsValid(PROVIDER_SETTINGS_PLUGINS);

export function getProviderSettingsPlugin(providerId: AgentId): ProviderSettingsPlugin | null {
    const normalizedProviderId = String(providerId ?? '').trim().toLowerCase();
    if (!normalizedProviderId) return null;
    for (const plugin of PROVIDER_SETTINGS_PLUGINS) {
        const normalizedPluginProviderId = String(plugin.providerId ?? '').trim().toLowerCase();
        if (normalizedPluginProviderId === normalizedProviderId) return plugin;
    }
    return null;
}
