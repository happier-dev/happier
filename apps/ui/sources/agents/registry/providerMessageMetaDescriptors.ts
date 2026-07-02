import {
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
} from '@happier-dev/agents';

import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';
import type { ProviderMessageMetaOverrideBuilder } from './generatedBundledPluginEntries.messageMetaOverrides';

type SessionConfigOptionOverrideSource = Readonly<{
    kind: 'sessionConfigOptionOverride';
    key: string;
    aliases?: readonly string[];
}>;

type ProviderMessageMetaOverrideDescriptor = Readonly<{
    id: string;
    targetKey: string;
    value: SessionConfigOptionOverrideSource;
    normalize?: 'trimLowercase';
}>;

type ProviderMessageMetaDescriptor = Readonly<{
    agentId: string;
    overrides: readonly ProviderMessageMetaOverrideDescriptor[];
}>;

export type PluginUiMessageDescriptor = Readonly<{
    kind: 'plugin.ui.v1';
    pluginId: string;
    agentId: string;
    version: number;
    message?: Readonly<{
        metaDescriptorIds?: readonly string[];
        metaOverrides?: readonly ProviderMessageMetaOverrideDescriptor[];
    }>;
}>;

export type ProviderMessageMetaDescriptorResult = Readonly<{
    buildOverrides: ProviderMessageMetaOverrideBuilder;
    diagnostics: readonly UiProjectionDiagnostic[];
}>;

function readSessionMetadata(session: unknown): Record<string, unknown> | null {
    if (!isRecord(session)) return null;
    return isRecord(session.metadata) ? session.metadata : null;
}

function readSessionConfigOptionOverrideValue(raw: unknown, key: string): unknown {
    if (!isRecord(raw) || raw.v !== 1) return undefined;
    const overrides = isRecord(raw.overrides) ? raw.overrides : null;
    const override = isRecord(overrides?.[key]) ? overrides[key] : null;
    return override?.value;
}

function normalizeValue(value: unknown, mode: ProviderMessageMetaOverrideDescriptor['normalize']): unknown {
    if (mode !== 'trimLowercase') return value;
    const normalized = readString(value)?.toLowerCase() ?? null;
    return normalized ?? undefined;
}

function defaultBuilder(params: Parameters<ProviderMessageMetaOverrideBuilder>[0]): ReturnType<ProviderMessageMetaOverrideBuilder> {
    return params.metaOverrides;
}

export function createProviderMessageMetaOverrideBuilderFromDescriptor(value: unknown): ProviderMessageMetaDescriptorResult {
    if (!isRecord(value) || value.kind !== 'plugin.ui.v1') {
        return {
            buildOverrides: defaultBuilder,
            diagnostics: [createUiProjectionDiagnostic(
                'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
                'kind',
                'Unsupported provider message-meta descriptor kind.',
            )],
        };
    }

    const pluginDescriptor = value as PluginUiMessageDescriptor;
    const diagnostics: UiProjectionDiagnostic[] = [];
    const metaOverrides = pluginDescriptor.message?.metaOverrides;
    const descriptors: ProviderMessageMetaDescriptor[] = Array.isArray(metaOverrides)
        ? [{
            agentId: pluginDescriptor.agentId,
            overrides: metaOverrides,
        }]
        : [];
    for (const [index, descriptorId] of readStringArray(pluginDescriptor.message?.metaDescriptorIds).entries()) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            `message.metaDescriptorIds.${index}`,
            `Unsupported message-meta descriptor id '${descriptorId}'.`,
        ));
    }
    const overrides = descriptors.flatMap((descriptor) => descriptor.overrides).filter((override, index) => {
        if (!readString(override.id) || !readString(override.targetKey)) {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_MALFORMED_DESCRIPTOR',
                `overrides.${index}`,
                'Message-meta override descriptors require id and targetKey.',
            ));
            return false;
        }
        if (override.value.kind !== 'sessionConfigOptionOverride') {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
                `overrides.${index}.value`,
                'Unsupported message-meta source descriptor.',
            ));
            return false;
        }
        return true;
    });

    return {
        diagnostics,
        buildOverrides: ({ session, metaOverrides }) => {
            const merged = isRecord(metaOverrides) ? { ...metaOverrides } : {};
            const metadata = readSessionMetadata(session);
            for (const override of overrides) {
                if (Object.prototype.hasOwnProperty.call(merged, override.targetKey)) continue;
                const aliases = [
                    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
                    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
                    ...readStringArray(override.value.aliases),
                ];
                const rawValue = readSessionConfigOptionOverrideValue(
                    readMetadataAliasValue(metadata, ...aliases),
                    override.value.key,
                );
                const normalized = normalizeValue(rawValue, override.normalize);
                if (normalized === undefined) continue;
                merged[override.targetKey] = normalized;
            }
            return Object.keys(merged).length > 0 ? merged : metaOverrides;
        },
    };
}
