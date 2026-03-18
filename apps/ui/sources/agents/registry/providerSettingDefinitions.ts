import type { z, ZodTypeAny } from 'zod';

import type { AgentId } from '@/agents/catalog/catalog';
import {
    buildClaudeRemoteOutgoingMessageMetaExtras,
    buildClaudeRemoteProviderSettingsShape,
    buildCodexProviderSettingsShape,
    buildOpenCodeProviderSettingsShape,
    CODEX_PROVIDER_SETTINGS_DEFAULTS,
    CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
    OPENCODE_PROVIDER_SETTINGS_DEFAULTS,
} from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

import { providerSettingsSectionsByProvider } from './settingsSections';
import { providerSettingTranslationKeyPrefixes } from './providerSettingTranslationKeys';

type ProviderSettingsShapeBuilder = (zod: typeof z) => Readonly<Record<string, ZodTypeAny>>;

export type ProviderSettingDefinition = Readonly<{
    providerId: AgentId;
    title: string;
    icon: Readonly<{ ionName: string; color: string }>;
    buildSettingsShape: ProviderSettingsShapeBuilder;
    settingsDefaults: Readonly<Record<string, unknown>>;
    buildOutgoingMessageMetaExtras: ProviderSettingsPlugin['buildOutgoingMessageMetaExtras'];
    uiSections: readonly ProviderSettingsPlugin['uiSections'][number][];
    routes: Readonly<{
        settings: string;
        auth: string;
        terminal: string;
        context: string;
    }>;
    localAuth: Readonly<{
        enabled: boolean;
    }>;
    translationKeyPrefix: string;
}>;

function createEmptySettingsShape(): Readonly<Record<string, ZodTypeAny>> {
    return {};
}

function createEmptyOutgoingMessageMetaExtras(): Record<string, unknown> {
    return {};
}

const providerSettingDefinitions = {
    claude: {
        providerId: 'claude',
        title: 'Claude (remote)',
        icon: { ionName: 'sparkles-outline', color: '#FF9500' },
        buildSettingsShape: buildClaudeRemoteProviderSettingsShape,
        settingsDefaults: CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
        buildOutgoingMessageMetaExtras: ({ settings }) => ({ ...buildClaudeRemoteOutgoingMessageMetaExtras(settings) }),
        uiSections: providerSettingsSectionsByProvider.claude,
        routes: {
            settings: '/(app)/settings/providers/claude',
            auth: '/(app)/settings/providers/claude/auth',
            terminal: '/(app)/settings/providers/claude/terminal',
            context: '/(app)/settings/providers/claude/context',
        },
        localAuth: { enabled: true },
        translationKeyPrefix: providerSettingTranslationKeyPrefixes.claude,
    },
    codex: {
        providerId: 'codex',
        title: 'Codex',
        icon: { ionName: 'terminal-outline', color: '#4F8EF7' },
        buildSettingsShape: buildCodexProviderSettingsShape,
        settingsDefaults: CODEX_PROVIDER_SETTINGS_DEFAULTS,
        buildOutgoingMessageMetaExtras: createEmptyOutgoingMessageMetaExtras,
        uiSections: providerSettingsSectionsByProvider.codex,
        routes: {
            settings: '/(app)/settings/providers/codex',
            auth: '/(app)/settings/providers/codex/auth',
            terminal: '/(app)/settings/providers/codex/terminal',
            context: '/(app)/settings/providers/codex/context',
        },
        localAuth: { enabled: true },
        translationKeyPrefix: providerSettingTranslationKeyPrefixes.codex,
    },
    opencode: {
        providerId: 'opencode',
        title: 'OpenCode',
        icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
        buildSettingsShape: buildOpenCodeProviderSettingsShape,
        settingsDefaults: OPENCODE_PROVIDER_SETTINGS_DEFAULTS,
        buildOutgoingMessageMetaExtras: createEmptyOutgoingMessageMetaExtras,
        uiSections: providerSettingsSectionsByProvider.opencode,
        routes: {
            settings: '/(app)/settings/providers/opencode',
            auth: '/(app)/settings/providers/opencode/auth',
            terminal: '/(app)/settings/providers/opencode/terminal',
            context: '/(app)/settings/providers/opencode/context',
        },
        localAuth: { enabled: true },
        translationKeyPrefix: providerSettingTranslationKeyPrefixes.opencode,
    },
    gemini: {
        providerId: 'gemini',
        title: 'Gemini',
        icon: { ionName: 'planet-outline', color: '#007AFF' },
        buildSettingsShape: createEmptySettingsShape,
        settingsDefaults: {},
        buildOutgoingMessageMetaExtras: createEmptyOutgoingMessageMetaExtras,
        uiSections: providerSettingsSectionsByProvider.gemini,
        routes: {
            settings: '/(app)/settings/providers/gemini',
            auth: '/(app)/settings/providers/gemini/auth',
            terminal: '/(app)/settings/providers/gemini/terminal',
            context: '/(app)/settings/providers/gemini/context',
        },
        localAuth: { enabled: false },
        translationKeyPrefix: providerSettingTranslationKeyPrefixes.gemini,
    },
    kiro: {
        providerId: 'kiro',
        title: 'Kiro',
        icon: { ionName: 'flash-outline', color: '#0EA5E9' },
        buildSettingsShape: createEmptySettingsShape,
        settingsDefaults: {},
        buildOutgoingMessageMetaExtras: createEmptyOutgoingMessageMetaExtras,
        uiSections: providerSettingsSectionsByProvider.kiro,
        routes: {
            settings: '/(app)/settings/providers/kiro',
            auth: '/(app)/settings/providers/kiro/auth',
            terminal: '/(app)/settings/providers/kiro/terminal',
            context: '/(app)/settings/providers/kiro/context',
        },
        localAuth: { enabled: false },
        translationKeyPrefix: providerSettingTranslationKeyPrefixes.kiro,
    },
} as const satisfies Readonly<Record<'claude' | 'codex' | 'opencode' | 'gemini' | 'kiro', ProviderSettingDefinition>>;

export const providerSettingDefinitionsById = providerSettingDefinitions;

export type ProviderSettingId = keyof typeof providerSettingDefinitionsById;

export const providerSettingDefinitionIds = Object.freeze(Object.keys(providerSettingDefinitionsById) as ProviderSettingId[]);

export function getProviderSettingDefinition(providerId: AgentId): ProviderSettingDefinition | null {
    const normalizedProviderId = String(providerId ?? '').trim().toLowerCase() as ProviderSettingId;
    if (!(normalizedProviderId in providerSettingDefinitionsById)) return null;
    return providerSettingDefinitionsById[normalizedProviderId];
}
