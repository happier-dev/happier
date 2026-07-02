import { z } from 'zod';
import {
    CODEX_PROVIDER_FIELDS,
    KIMI_PROVIDER_FIELDS,
} from '@happier-dev/agents';
import type { SettingDefinitionMap } from '@happier-dev/protocol';

import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';
import type {
    ProviderSettingEnumOption,
    ProviderSettingFieldBinding,
    ProviderSettingFieldDef,
    ProviderSettingNumberSpec,
    ProviderSettingsIconColor,
    ProviderSettingsIconColorToken,
    ProviderSettingsPlugin,
    ProviderSettingsSectionDef,
    ProviderSubagentSettingsSectionDef,
    TranslatableText,
    TranslationRef,
} from '@/agents/providers/shared/providerSettingsPlugin';
import { readString } from '@/agents/registry/uiDescriptorDiagnostics';

type GeneratedProviderSettingsDescriptor = Readonly<{
    agentId: string;
    descriptor: Readonly<Record<string, unknown>>;
}>;
type JsonRecord = Readonly<Record<string, unknown>>;

function translation(key: string): TranslationRef {
    return { key: key as TranslationRef['key'] };
}

function option(baseKey: string, id: string): ProviderSettingEnumOption {
    return {
        id,
        title: translation(`${baseKey}.options.${id}.title`),
        subtitle: translation(`${baseKey}.options.${id}.subtitle`),
    };
}

function enumField(providerId: string, key: string, optionIds: readonly string[]): ProviderSettingFieldDef {
    const baseKey = `settingsProviders.plugins.${providerId}.fields.${key}`;
    return {
        key,
        kind: 'enum',
        title: translation(`${baseKey}.title`),
        subtitle: translation(`${baseKey}.subtitle`),
        enumOptions: optionIds.map((id) => option(baseKey, id)),
    };
}

const CODEX_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'codex',
    title: translation('settingsProviders.plugins.codex.title'),
    icon: { ionName: 'terminal-outline', color: { kind: 'theme', token: 'blue' } },
    settings: CODEX_PROVIDER_FIELDS,
    uiSections: [
        {
            id: 'codexMode',
            title: translation('settingsProviders.plugins.codex.sections.backendMode.title'),
            footer: translation('settingsProviders.plugins.codex.sections.backendMode.footer'),
            fields: [
                enumField('codex', 'codexBackendMode', ['appServer', 'acp']),
            ],
        },
    ],
};

const KIMI_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'kimi',
    title: translation('settingsProviders.plugins.kimi.title'),
    icon: { ionName: 'leaf-outline', color: { kind: 'theme', token: 'green' } },
    settings: KIMI_PROVIDER_FIELDS,
    uiSections: [
        {
            id: 'kimiCompatibility',
            title: translation('settingsProviders.plugins.kimi.sections.compatibility.title'),
            footer: translation('settingsProviders.plugins.kimi.sections.compatibility.footer'),
            fields: [
                enumField('kimi', 'kimiAcpPythonSelector', ['auto', 'poll']),
            ],
        },
    ],
};

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readText(value: unknown): TranslatableText | null {
    if (typeof value === 'string') return value;
    if (!isRecord(value)) return null;
    const key = readString(value.key);
    return key ? { key: key as TranslationRef['key'] } : null;
}

function readIconColor(value: unknown): ProviderSettingsIconColor | null {
    if (typeof value === 'string') return value;
    if (!isRecord(value) || value.kind !== 'theme') return null;
    const token = readString(value.token);
    return token ? { kind: 'theme', token: token as ProviderSettingsIconColorToken } : null;
}

function readIcon(value: unknown): ProviderSettingsPlugin['icon'] | null {
    if (!isRecord(value)) return null;
    const ionName = readString(value.ionName);
    const color = readIconColor(value.color);
    return ionName && color ? { ionName, color } : null;
}

function createStringRecordSchema(): z.ZodType<Record<string, string>> {
    return z.preprocess((raw) => {
        const record = isRecord(raw) ? raw : {};
        return Object.fromEntries(
            Object.entries(record).flatMap(([key, value]) => {
                const normalizedKey = key.trim();
                if (!normalizedKey || typeof value !== 'string') return [];
                return [[normalizedKey, value]];
            }),
        );
    }, z.record(z.string().min(1), z.string()).default({}));
}

function createJsonObjectStringSchema(maxLength: number | undefined): z.ZodType<string> {
    return z.string().refine((raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return true;
        if (maxLength != null && trimmed.length > maxLength) return false;
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
        } catch {
            return false;
        }
    });
}

function createSchemaFromDescriptor(value: unknown): z.ZodTypeAny | null {
    if (!isRecord(value)) return null;
    const kind = readString(value.kind);
    if (kind === 'boolean') return z.boolean();
    if (kind === 'string') return z.string();
    if (kind === 'jsonObjectString') {
        return createJsonObjectStringSchema(typeof value.maxLength === 'number' ? value.maxLength : undefined);
    }
    if (kind === 'stringRecord') return createStringRecordSchema();
    if (kind === 'number') {
        let schema: z.ZodNumber = z.number();
        if (value.int === true) schema = schema.int();
        if (typeof value.min === 'number') schema = schema.min(value.min);
        if (typeof value.max === 'number') schema = schema.max(value.max);
        return value.nullable === true ? schema.nullable() : schema;
    }
    if (kind === 'array') {
        const element = createSchemaFromDescriptor(value.element);
        if (!element) return null;
        let schema: z.ZodArray<z.ZodTypeAny> = z.array(element);
        if (typeof value.min === 'number') schema = schema.min(value.min);
        if (typeof value.max === 'number') schema = schema.max(value.max);
        return schema;
    }
    if (kind !== 'enum' || !Array.isArray(value.values)) return null;

    const values = value.values.flatMap((entry) => {
        const normalized = readString(entry);
        return normalized ? [normalized] : [];
    });
    const [first, ...rest] = values;
    return first ? z.enum([first, ...rest]) : null;
}

function readSettingDefinition(value: unknown): SettingDefinitionMap[string] | null {
    if (!isRecord(value)) return null;
    const schema = createSchemaFromDescriptor(value.schema);
    const description = readString(value.description);
    const storageScope = readString(value.storageScope);
    if (!schema || !description || (storageScope !== 'account' && storageScope !== 'local')) return null;
    return {
        schema,
        default: value.default,
        description,
        storageScope,
    };
}

function readSettings(value: unknown): SettingDefinitionMap | null {
    if (!isRecord(value)) return null;
    const settings: Record<string, SettingDefinitionMap[string]> = {};
    for (const [key, definition] of Object.entries(value)) {
        const normalizedKey = key.trim();
        if (!normalizedKey) return null;
        const parsed = readSettingDefinition(definition);
        if (!parsed) return null;
        settings[normalizedKey] = parsed;
    }
    return settings;
}

function readEnumOptions(value: unknown): readonly ProviderSettingEnumOption[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    const options = value.flatMap((entry): ProviderSettingEnumOption[] => {
        if (!isRecord(entry)) return [];
        const id = readString(entry.id);
        const title = readText(entry.title);
        if (!id || !title) return [];
        const subtitle = readText(entry.subtitle);
        return [{
            id,
            title,
            ...(subtitle ? { subtitle } : {}),
        }];
    });
    return options.length === value.length ? options : undefined;
}

function readNumberSpec(value: unknown): ProviderSettingNumberSpec | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return undefined;
    const placeholder = readText(value.placeholder);
    return {
        ...(typeof value.min === 'number' ? { min: value.min } : {}),
        ...(typeof value.max === 'number' ? { max: value.max } : {}),
        ...(typeof value.step === 'number' ? { step: value.step } : {}),
        ...(placeholder ? { placeholder } : {}),
    };
}

function readBinding(value: unknown): ProviderSettingFieldBinding | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return undefined;
    const kind = readString(value.kind);
    if (kind === 'direct') {
        const settingKey = readString(value.settingKey);
        return { kind, ...(settingKey ? { settingKey } : {}) };
    }
    if (kind !== 'perActiveServer') return undefined;
    const fallbackSettingKey = readString(value.fallbackSettingKey);
    const byServerIdSettingKey = readString(value.byServerIdSettingKey);
    return fallbackSettingKey && byServerIdSettingKey
        ? { kind, fallbackSettingKey, byServerIdSettingKey }
        : undefined;
}

function readField(value: unknown): ProviderSettingFieldDef | null {
    if (!isRecord(value)) return null;
    const key = readString(value.key);
    const kind = readString(value.kind);
    const title = readText(value.title);
    if (!key || !title) return null;
    if (kind !== 'boolean' && kind !== 'enum' && kind !== 'multiEnum' && kind !== 'number' && kind !== 'text' && kind !== 'json') {
        return null;
    }
    const subtitle = readText(value.subtitle);
    const enumOptions = readEnumOptions(value.enumOptions);
    const numberSpec = readNumberSpec(value.numberSpec);
    const binding = readBinding(value.binding);
    return {
        key,
        kind,
        title,
        ...(subtitle ? { subtitle } : {}),
        ...(enumOptions ? { enumOptions } : {}),
        ...(numberSpec ? { numberSpec } : {}),
        ...(binding ? { binding } : {}),
    };
}

function readUiSections(value: unknown): readonly ProviderSettingsSectionDef[] | null {
    if (!Array.isArray(value)) return null;
    const sections = value.flatMap((entry): ProviderSettingsSectionDef[] => {
        if (!isRecord(entry) || !Array.isArray(entry.fields)) return [];
        const id = readString(entry.id);
        const title = readText(entry.title);
        if (!id || !title) return [];
        const fields = entry.fields.flatMap((field) => {
            const parsed = readField(field);
            return parsed ? [parsed] : [];
        });
        if (fields.length !== entry.fields.length) return [];
        const footer = readText(entry.footer);
        return [{
            id,
            title,
            ...(footer ? { footer } : {}),
            fields,
        }];
    });
    return sections.length === value.length ? sections : null;
}

function readSubagentSettingsSections(value: unknown): readonly ProviderSubagentSettingsSectionDef[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    const sections = value.flatMap((entry): ProviderSubagentSettingsSectionDef[] => {
        if (!isRecord(entry) || !Array.isArray(entry.items)) return [];
        const id = readString(entry.id);
        const title = readText(entry.title);
        if (!id || !title) return [];
        const items = entry.items.flatMap((item) => {
            if (!isRecord(item)) return [];
            const itemId = readString(item.id);
            const itemTitle = readText(item.title);
            const route = readString(item.route);
            if (!itemId || !itemTitle || !route) return [];
            const subtitle = readText(item.subtitle);
            const iconIonName = readString(item.iconIonName);
            return [{
                id: itemId,
                title: itemTitle,
                route,
                ...(subtitle ? { subtitle } : {}),
                ...(iconIonName ? { iconIonName } : {}),
            }];
        });
        if (items.length !== entry.items.length) return [];
        const footer = readText(entry.footer);
        return [{
            id,
            title,
            ...(footer ? { footer } : {}),
            items,
        }];
    });
    return sections.length === value.length ? sections : undefined;
}

function createGenericProviderSettingsPluginFromDescriptor(
    descriptor: Readonly<Record<string, unknown>>,
): ProviderSettingsPlugin | null {
    if (descriptor.kind !== 'providerSettings.v1') return null;
    const providerId = readString(descriptor.providerId);
    const title = readText(descriptor.title);
    const icon = readIcon(descriptor.icon);
    const settings = readSettings(descriptor.settings);
    const uiSections = readUiSections(descriptor.uiSections);
    if (!providerId || !title || !icon || !settings || !uiSections) return null;
    const subagentSettingsSections = readSubagentSettingsSections(descriptor.subagentSettingsSections);
    return {
        providerId,
        title,
        icon,
        settings,
        uiSections,
        ...(subagentSettingsSections ? { subagentSettingsSections } : {}),
    };
}

const DESCRIPTOR_PLUGIN_BY_ID: Readonly<Record<string, ProviderSettingsPlugin>> = Object.freeze({
    'auggie.providerSettings.v1': createNoopProviderSettingsPlugin({
        providerId: 'auggie',
        title: translation('settingsProviders.plugins.auggie.title'),
        icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'green' } },
    }),
    'copilot.providerSettings.v1': createNoopProviderSettingsPlugin({
        providerId: 'copilot',
        title: translation('settingsProviders.plugins.copilot.title'),
        icon: { ionName: 'logo-github', color: { kind: 'theme', token: 'blue' } },
    }),
    'kilo.providerSettings.v1': createNoopProviderSettingsPlugin({
        providerId: 'kilo',
        title: translation('settingsProviders.plugins.kilo.title'),
        icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'orange' } },
    }),
    'kimi.providerSettings.v1': KIMI_PROVIDER_SETTINGS_PLUGIN,
    'pi.providerSettings.v1': createNoopProviderSettingsPlugin({
        providerId: 'pi',
        title: translation('settingsProviders.plugins.pi.title'),
        icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'green' } },
    }),
});

export const HOST_PROVIDER_SETTINGS_PLUGINS: readonly ProviderSettingsPlugin[] = Object.freeze([
    CODEX_PROVIDER_SETTINGS_PLUGIN,
    createNoopProviderSettingsPlugin({
        providerId: 'gemini',
        title: translation('settingsProviders.plugins.gemini.title'),
        icon: { ionName: 'planet-outline', color: { kind: 'theme', token: 'blue' } },
    }),
    createNoopProviderSettingsPlugin({
        providerId: 'qwen',
        title: translation('settingsProviders.plugins.qwen.title'),
        icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'blue' } },
    }),
    createNoopProviderSettingsPlugin({
        providerId: 'kiro',
        title: translation('settingsProviders.plugins.kiro.title'),
        icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'purple' } },
    }),
]);

export function createProviderSettingsPluginFromDescriptor(
    entry: GeneratedProviderSettingsDescriptor,
): ProviderSettingsPlugin | null {
    const genericPlugin = createGenericProviderSettingsPluginFromDescriptor(entry.descriptor);
    if (genericPlugin) return genericPlugin;

    const descriptorId = readString(entry.descriptor.descriptorId);
    if (!descriptorId) return null;
    return DESCRIPTOR_PLUGIN_BY_ID[descriptorId] ?? null;
}
