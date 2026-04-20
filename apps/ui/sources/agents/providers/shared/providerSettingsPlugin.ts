import type React from 'react';
import type { SettingDefinitionMap } from '@happier-dev/protocol';

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

export type ProviderSettingsDescriptor = Readonly<{
    providerId: string;
    title: TranslatableText;
    icon: Readonly<{ ionName: string; color: ProviderSettingsIconColor }>;
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
}>;

export type ProviderSettingsBehavior = Readonly<{
    providerId: string;
    ExtraSectionsComponent?: React.ComponentType<Readonly<{ providerId: string }>>;
}>;

export type ProviderSettingsPlugin = ProviderSettingsDescriptor & ProviderSettingsBehavior;
