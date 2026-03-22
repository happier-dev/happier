import { z } from 'zod';
import type { AgentId } from '@/agents/catalog/catalog';

import type { ProviderSettingsPlugin } from '../shared/providerSettingsPlugin';
import { buildProviderSettingArtifactEntries } from './buildProviderSettingArtifactEntries';
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

function isTranslationRef(value: unknown): value is Readonly<{ key: string }> {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof (value as { key?: unknown }).key === 'string'
        && (value as { key: string }).key.trim().length > 0,
    );
}

function isAllowedLiteralNumberPlaceholder(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return true;
    return /^[\d\s.,:+\-/%()[\]{}]*$/u.test(trimmed);
}

export function assertProviderSettingsPluginsValid(plugins: readonly ProviderSettingsPlugin[]): void {
    const errors: string[] = [];
    const providerIds = new Set<string>();
    const globalSettingKeys = new Map<string, string>();
    const artifactEntries = buildProviderSettingArtifactEntries(plugins);

    for (const { plugin, artifacts } of artifactEntries) {
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

        if (!isTranslationRef(plugin.title)) {
            errors.push(`Provider "${providerId}" title must use a translation key`);
        }

        const shape = artifacts.shape;
        const shapeKeys = new Set(Object.keys(shape));

        for (const key of shapeKeys) {
            const owner = globalSettingKeys.get(key);
            if (owner && owner !== providerId) {
                errors.push(`Duplicate settings key "${key}" across providers "${owner}" and "${providerId}"`);
            } else {
                globalSettingKeys.set(key, providerId);
            }
        }

        for (const section of plugin.uiSections) {
            if (!isTranslationRef(section.title)) {
                errors.push(`Provider "${providerId}" section "${section.id}" title must use a translation key`);
            }
            if (section.footer && !isTranslationRef(section.footer)) {
                errors.push(`Provider "${providerId}" section "${section.id}" footer must use a translation key`);
            }

            for (const field of section.fields) {
                if (!shapeKeys.has(field.key)) {
                    errors.push(`Provider "${providerId}" field "${field.key}" is missing from settings`);
                    continue;
                }

                if (!isTranslationRef(field.title)) {
                    errors.push(`Provider "${providerId}" field "${field.key}" title must use a translation key`);
                }
                if (field.subtitle && !isTranslationRef(field.subtitle)) {
                    errors.push(`Provider "${providerId}" field "${field.key}" subtitle must use a translation key`);
                }
                const numberPlaceholder = field.numberSpec?.placeholder;
                if (typeof numberPlaceholder === 'string' && !isAllowedLiteralNumberPlaceholder(numberPlaceholder)) {
                    errors.push(`Provider "${providerId}" field "${field.key}" placeholder must use a translation key`);
                }
                for (const option of field.enumOptions ?? []) {
                    if (!isTranslationRef(option.title)) {
                        errors.push(`Provider "${providerId}" field "${field.key}" option "${option.id}" title must use a translation key`);
                    }
                    if (option.subtitle && !isTranslationRef(option.subtitle)) {
                        errors.push(`Provider "${providerId}" field "${field.key}" option "${option.id}" subtitle must use a translation key`);
                    }
                }

                if (field.kind !== 'json') continue;
                const schema = shape[field.key] as z.ZodTypeAny;
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

        for (const section of plugin.subagentSettingsSections ?? []) {
            if (!isTranslationRef(section.title)) {
                errors.push(`Provider "${providerId}" subagent section "${section.id}" title must use a translation key`);
            }
            if (section.footer && !isTranslationRef(section.footer)) {
                errors.push(`Provider "${providerId}" subagent section "${section.id}" footer must use a translation key`);
            }
            for (const item of section.items) {
                if (!isTranslationRef(item.title)) {
                    errors.push(`Provider "${providerId}" subagent item "${item.id}" title must use a translation key`);
                }
                if (item.subtitle && !isTranslationRef(item.subtitle)) {
                    errors.push(`Provider "${providerId}" subagent item "${item.id}" subtitle must use a translation key`);
                }
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(`Invalid provider settings plugin registry:\n- ${errors.join('\n- ')}`);
    }
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
