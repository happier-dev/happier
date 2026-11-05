import type * as React from 'react';
import type { UnistylesThemes } from 'react-native-unistyles';
import type { FeatureId } from '@happier-dev/protocol';

import type { TranslationKey, TranslationKeyNoParams } from '@/text';

export const SETTINGS_PAGE_IDS = {
    settings: 'settings',
    groupProfileAndAccount: 'groupProfileAndAccount',
    groupGeneral: 'groupGeneral',
    groupAiAndAgents: 'groupAiAndAgents',
    groupToolsAndModels: 'groupToolsAndModels',
    groupSessionsBehavior: 'groupSessionsBehavior',
    groupFilesAndSourceControl: 'groupFilesAndSourceControl',
    groupSystem: 'groupSystem',
    groupPlugins: 'groupPlugins',

    account: 'account',
    teams: 'teams',
    homeAdministration: 'homeAdministration',
    accountSecurity: 'accountSecurity',
    accountPublicProfile: 'accountPublicProfile',
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
    skills: 'skills',
    mcp: 'mcp',
    plugins: 'plugins',
    prompts: 'prompts',
    promptsTemplates: 'promptsTemplates',
    promptsFolders: 'promptsFolders',
    promptsStacks: 'promptsStacks',
    promptsLibrary: 'promptsLibrary',
    voice: 'voice',
    voiceConversations: 'voiceConversations',
    voiceDictation: 'voiceDictation',
    voicePrivacy: 'voicePrivacy',
    voiceAdvanced: 'voiceAdvanced',
    voiceHistory: 'voiceHistory',
    memory: 'memory',
    search: 'search',

    session: 'session',
    coordination: 'coordination',
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
    /**
     * Reached from inside its parent's page (a collection's own add or setup row): found by settings search and
     * owns its route, but the rail does not list it under its parent.
     */
    searchOnly?: boolean;
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
    searchOnly?: boolean;
    children?: readonly ResolvedSettingsPageNode[];
}>;

export type SettingsPageSearchResult = Readonly<{
    id: SettingsPageId;
    route: string;
    /** The matching description or explicit keyword, when the title/location does not explain the hit. */
    matchText?: string;
    /** Present when the result is an individual setting on page `id` rather than the page itself. */
    setting?: Readonly<{
        anchor: string;
        title: string;
        /** Page title, then section title when the setting has one. */
        path: readonly string[];
    }>;
}>;
