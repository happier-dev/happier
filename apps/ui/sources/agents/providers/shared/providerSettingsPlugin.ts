import type React from 'react';
import type { SettingDefinitionMap } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/registry/registryCore';
import type { TranslationKeyNoParams } from '@/text';

export type TranslationRef = Readonly<{ key: TranslationKeyNoParams }>;

export type TranslatableText = string | TranslationRef;

export type ProviderSettingsIconColorToken = keyof NonNullable<(typeof import('@/theme'))['lightTheme']['colors']['accent']>;
export type ProviderSettingsIconColor = string | Readonly<{ kind: 'theme'; token: ProviderSettingsIconColorToken }>;

export type ProviderSettingFieldKind = 'boolean' | 'enum' | 'multiEnum' | 'number' | 'text' | 'json';

export type ProviderSettingEnumOption = Readonly<{
    id: string;
    title: TranslatableText;
    subtitle?: TranslatableText;
}>;

export type ProviderSettingNumberSpec = Readonly<{
    min?: number;
    max?: number;
    step?: number;
    placeholder?: TranslatableText;
}>;

export type ProviderSettingFieldBinding =
    | Readonly<{
        kind: 'direct';
        settingKey?: string;
    }>
    | Readonly<{
        kind: 'perActiveServer';
        fallbackSettingKey: string;
        byServerIdSettingKey: string;
    }>;

export type ProviderSettingFieldDef = Readonly<{
    key: string;
    kind: ProviderSettingFieldKind;
    title: TranslatableText;
    subtitle?: TranslatableText;
    enumOptions?: readonly ProviderSettingEnumOption[];
    numberSpec?: ProviderSettingNumberSpec;
    binding?: ProviderSettingFieldBinding;
}>;

export type ProviderSettingsSectionDef = Readonly<{
    id: string;
    title: TranslatableText;
    footer?: TranslatableText;
    fields: readonly ProviderSettingFieldDef[];
}>;

export type ProviderSubagentSettingsItemDef = Readonly<{
    id: string;
    title: TranslatableText;
    subtitle?: TranslatableText;
    route: string;
    iconIonName?: string;
}>;

export type ProviderSubagentSettingsSectionDef = Readonly<{
    id: string;
    title: TranslatableText;
    footer?: TranslatableText;
    items: readonly ProviderSubagentSettingsItemDef[];
}>;

export type ProviderSettingsPlugin = Readonly<{
    providerId: AgentId;
    title: TranslatableText;
    icon: Readonly<{ ionName: string; color: ProviderSettingsIconColor }>;
    ExtraSectionsComponent?: React.ComponentType<Readonly<{ providerId: AgentId }>>;
    /**
     * Provider-owned setting definitions (flat keys only).
     * Keys must be globally unique across all settings.
     */
    settings: SettingDefinitionMap;
    /**
     * UI sections rendered by the generic provider-settings screen.
     */
    uiSections: readonly ProviderSettingsSectionDef[];
    /**
     * Provider-owned settings that should also be discoverable from the Subagents hub.
     * These are navigational entries only; the owning provider screen remains the source of truth.
     */
    subagentSettingsSections?: readonly ProviderSubagentSettingsSectionDef[];
    /**
     * Provider-specific outgoing message metadata enrichment.
     *
     * Must return a flat JSON-serializable object.
     * This is merged into the existing `MessageMeta` in `sync.sendMessage`.
     */
    buildOutgoingMessageMetaExtras: (args: {
        settings: Record<string, unknown>;
        session: unknown;
        agentId: AgentId;
    }) => Record<string, unknown>;
}>;
