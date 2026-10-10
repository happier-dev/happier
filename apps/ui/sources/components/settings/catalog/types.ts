import type * as React from 'react';
import type { UnistylesThemes } from 'react-native-unistyles';
import type { FeatureId } from '@happier-dev/protocol';

import type { TranslationKey, TranslationKeyNoParams } from '@/text';

export const SETTINGS_PAGE_IDS = {
    settings: 'settings',
    groupProfileAndAccount: 'groupProfileAndAccount',
    groupGeneral: 'groupGeneral',
    groupAiAndAgents: 'groupAiAndAgents',
    groupSessionsBehavior: 'groupSessionsBehavior',
    groupFilesAndSourceControl: 'groupFilesAndSourceControl',
    groupSystem: 'groupSystem',

    account: 'account',
    teams: 'teams',
    homeAdministration: 'homeAdministration',
    accountSecurity: 'accountSecurity',
    apiTokens: 'apiTokens',
    secrets: 'secrets',
    usage: 'usage',
    machines: 'machines',
    machinePoolsNew: 'machinePoolsNew',
    machinesAdd: 'machinesAdd',
    machinesThisComputer: 'machinesThisComputer',
    remoteHosts: 'remoteHosts',

    appearance: 'appearance',
    keyboard: 'keyboard',
    pets: 'pets',
    language: 'language',
    features: 'features',

    agents: 'agents',
    providers: 'providers',
    subAgent: 'subAgent',
    profiles: 'profiles',
    roles: 'roles',
    delegation: 'delegation',
    connectedServices: 'connectedServices',
    connectedServicesAgentSignIn: 'connectedServicesAgentSignIn',
    mcp: 'mcp',
    plugins: 'plugins',
    prompts: 'prompts',
    promptsTemplates: 'promptsTemplates',
    promptsFolders: 'promptsFolders',
    promptsStacks: 'promptsStacks',
    promptsRegistries: 'promptsRegistries',
    promptsLibrary: 'promptsLibrary',
    promptsAssets: 'promptsAssets',
    voice: 'voice',
    voiceConversations: 'voiceConversations',
    voiceDictation: 'voiceDictation',
    voicePrivacy: 'voicePrivacy',
    voiceAdvanced: 'voiceAdvanced',
    memory: 'memory',
    search: 'search',

    session: 'session',
    externalSessions: 'externalSessions',
    actions: 'actions',
    embeds: 'embeds',
    transcript: 'transcript',
    permissions: 'permissions',
    toolRendering: 'toolRendering',
    handoff: 'handoff',
    automations: 'automations',
    runs: 'runs',

    sourceControl: 'sourceControl',
    attachments: 'attachments',

    servers: 'servers',
    serversAdd: 'serversAdd',
    systemStatus: 'systemStatus',
    updates: 'updates',
    notifications: 'notifications',
    notificationsPush: 'notificationsPush',
    desktop: 'desktop',
    diagnosis: 'diagnosis',
    reportIssue: 'reportIssue',
} as const;

export type SettingsPageId =
    | (typeof SETTINGS_PAGE_IDS)[keyof typeof SETTINGS_PAGE_IDS]
    | `pluginSettingsPage:${string}`
    | `pluginSettingsGroup:${string}`;

export type SettingsPageGate = Readonly<{
    featureId?: FeatureId;
    requiresProfiles?: boolean;
    requiresDevMode?: boolean;
    requiresTauriDesktop?: boolean;
}>;

export type SettingsPageIconFactory = (params: Readonly<{
    theme: UnistylesThemes[keyof UnistylesThemes];
}>) => React.ReactNode;

export type SettingsPageNode = Readonly<{
    id: SettingsPageId;
    /** Built-in localization key. Plugin rows never supply one. */
    titleKey?: TranslationKey;
    /** Host-resolved plugin display text; built-in rows resolve their key at runtime. */
    title?: string;
    subtitleKey?: TranslationKey;
    subtitle?: string;
    route?: string;
    /** Built-in pages: translated search words, one comma-separated list. */
    keywordsKey?: TranslationKeyNoParams;
    /** Host-resolved search words (plugin rows, which have no translation keys). */
    keywords?: readonly string[];
    icon?: SettingsPageIconFactory;
    gate?: SettingsPageGate;
    /** Exact qualified destination identity for the one generic plugin route. */
    pluginSettingsPage?: Readonly<{
        pluginId: string;
        pageId: string;
    }>;
    children?: readonly SettingsPageNode[];
}>;

export type ResolvedSettingsPageNode = Readonly<{
    id: SettingsPageId;
    titleKey?: TranslationKey;
    title?: string;
    subtitleKey?: TranslationKey;
    subtitle?: string;
    route?: string;
    keywords: readonly string[];
    icon?: SettingsPageIconFactory;
    pluginSettingsPage?: Readonly<{
        pluginId: string;
        pageId: string;
    }>;
    children?: readonly ResolvedSettingsPageNode[];
}>;

export type SettingsPageSearchResult = Readonly<{
    id: SettingsPageId;
    route: string;
    /** Present when the result is an individual setting on page `id` rather than the page itself. */
    setting?: Readonly<{
        anchor: string;
        title: string;
        /** Page title, then section title when the setting has one. */
        path: readonly string[];
    }>;
}>;
