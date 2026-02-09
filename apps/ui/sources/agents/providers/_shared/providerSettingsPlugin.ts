import type { ZodTypeAny } from 'zod';

import type { AgentId } from '@/agents/catalog/catalog';

export type ProviderSettingFieldKind = 'boolean' | 'enum' | 'number' | 'text' | 'json';

export type ProviderSettingEnumOption = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
}>;

export type ProviderSettingNumberSpec = Readonly<{
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    nullLabel?: string;
}>;

export type ProviderSettingFieldDef = Readonly<{
    key: string;
    kind: ProviderSettingFieldKind;
    title: string;
    subtitle?: string;
    enumOptions?: readonly ProviderSettingEnumOption[];
    numberSpec?: ProviderSettingNumberSpec;
}>;

export type ProviderSettingsSectionDef = Readonly<{
    id: string;
    title: string;
    footer?: string;
    fields: readonly ProviderSettingFieldDef[];
}>;

export type ProviderSettingsPlugin = Readonly<{
    providerId: AgentId;
    title: string;
    icon: Readonly<{ ionName: string; color: string }>;
    /**
     * Provider-owned settings shape (flat keys only).
     * Keys must be globally unique across all settings.
     */
    settingsShape: Readonly<Record<string, ZodTypeAny>>;
    /**
     * Provider-owned settings defaults (flat keys only).
     * Must provide defaults for every key in settingsShape.
     */
    settingsDefaults: Readonly<Record<string, unknown>>;
    /**
     * UI sections rendered by the generic provider-settings screen.
     */
    uiSections: readonly ProviderSettingsSectionDef[];
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

