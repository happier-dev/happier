import type { AgentId } from '@/agents/catalog/catalog';

import type { ProviderSettingsPlugin } from '../_shared/providerSettingsPlugin';
import { AUGGIE_PROVIDER_SETTINGS_PLUGIN } from '../auggie/settings/plugin';
import { CLAUDE_PROVIDER_SETTINGS_PLUGIN } from '../claude/settings/plugin';
import { CODEX_PROVIDER_SETTINGS_PLUGIN } from '../codex/settings/plugin';
import { GEMINI_PROVIDER_SETTINGS_PLUGIN } from '../gemini/settings/plugin';
import { KILO_PROVIDER_SETTINGS_PLUGIN } from '../kilo/settings/plugin';
import { KIMI_PROVIDER_SETTINGS_PLUGIN } from '../kimi/settings/plugin';
import { OPENCODE_PROVIDER_SETTINGS_PLUGIN } from '../opencode/settings/plugin';
import { PI_PROVIDER_SETTINGS_PLUGIN } from '../pi/settings/plugin';
import { QWEN_PROVIDER_SETTINGS_PLUGIN } from '../qwen/settings/plugin';
import { COPILOT_PROVIDER_SETTINGS_PLUGIN } from '../copilot/settings/plugin';

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
    CODEX_PROVIDER_SETTINGS_PLUGIN,
    OPENCODE_PROVIDER_SETTINGS_PLUGIN,
    GEMINI_PROVIDER_SETTINGS_PLUGIN,
    AUGGIE_PROVIDER_SETTINGS_PLUGIN,
    QWEN_PROVIDER_SETTINGS_PLUGIN,
    KIMI_PROVIDER_SETTINGS_PLUGIN,
    KILO_PROVIDER_SETTINGS_PLUGIN,
    PI_PROVIDER_SETTINGS_PLUGIN,
    COPILOT_PROVIDER_SETTINGS_PLUGIN,
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
