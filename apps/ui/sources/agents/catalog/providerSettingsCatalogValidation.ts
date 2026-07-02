import { z } from 'zod';

import type { ProviderSettingFieldKind, ProviderSettingsDescriptor, ProviderSettingsIconColor, ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';
import { buildProviderSettingArtifactEntries } from '@/agents/providers/registry/buildProviderSettingArtifactEntries';

const SUPPORTED_PROVIDER_SETTING_FIELD_KINDS = new Set<ProviderSettingFieldKind>([
    'boolean',
    'enum',
    'multiEnum',
    'number',
    'text',
    'json',
]);

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

function isThemeTokenIconColor(value: ProviderSettingsIconColor): boolean {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && value.kind === 'theme'
        && typeof value.token === 'string'
        && value.token.trim().length > 0,
    );
}

export function assertProviderSettingsDescriptorsValid(descriptors: readonly ProviderSettingsDescriptor[]): void {
    const errors: string[] = [];
    const providerIds = new Set<string>();
    const globalSettingKeys = new Map<string, string>();
    const artifactEntries = buildProviderSettingArtifactEntries(descriptors);

    for (const { descriptor, artifacts } of artifactEntries) {
        const providerId = String(descriptor.providerId).trim().toLowerCase();
        if (!providerId) {
            errors.push('Provider settings descriptor has an empty providerId');
            continue;
        }
        if (providerIds.has(providerId)) {
            errors.push(`Duplicate providerId "${providerId}" in provider settings descriptors`);
        } else {
            providerIds.add(providerId);
        }

        if (!isTranslationRef(descriptor.title)) {
            errors.push(`Provider "${providerId}" title must use a translation key`);
        }
        if (!isThemeTokenIconColor(descriptor.icon.color)) {
            errors.push(`Provider "${providerId}" icon color must use a theme token`);
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

        for (const section of descriptor.uiSections) {
            if (!isTranslationRef(section.title)) {
                errors.push(`Provider "${providerId}" section "${section.id}" title must use a translation key`);
            }
            if (section.footer && !isTranslationRef(section.footer)) {
                errors.push(`Provider "${providerId}" section "${section.id}" footer must use a translation key`);
            }

            for (const field of section.fields) {
                if (!SUPPORTED_PROVIDER_SETTING_FIELD_KINDS.has(field.kind)) {
                    errors.push(`Provider "${providerId}" field "${field.key}" uses unsupported control kind "${String(field.kind)}"`);
                    continue;
                }
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

        for (const section of descriptor.subagentSettingsSections ?? []) {
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

export function assertProviderSettingsPluginsValid(plugins: readonly ProviderSettingsPlugin[]): void {
    assertProviderSettingsDescriptorsValid(plugins.map((plugin) => {
        const { providerId, title, icon, settings, uiSections, subagentSettingsSections } = plugin;
        return {
            providerId,
            title,
            icon,
            settings,
            uiSections,
            subagentSettingsSections,
        };
    }));
}
