import type * as React from 'react';
import type { UnistylesThemes } from 'react-native-unistyles';

import type { TranslationKey } from '@/text';

export const SETTINGS_PAGE_IDS = {
    settings: 'settings',
    groupProfileAndAccount: 'groupProfileAndAccount',
    groupGeneral: 'groupGeneral',
    groupAiAndAgents: 'groupAiAndAgents',
    groupSessionsBehavior: 'groupSessionsBehavior',
    groupFilesAndSourceControl: 'groupFilesAndSourceControl',
    groupSystem: 'groupSystem',

    account: 'account',
    secrets: 'secrets',
    usage: 'usage',
    machines: 'machines',
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
    connectedServices: 'connectedServices',
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

    session: 'session',
    externalSessions: 'externalSessions',
    actions: 'actions',
    transcript: 'transcript',
    permissions: 'permissions',
    toolRendering: 'toolRendering',
    handoff: 'handoff',
    automations: 'automations',
    runs: 'runs',

    sourceControl: 'sourceControl',
    attachments: 'attachments',

    servers: 'servers',
    systemStatus: 'systemStatus',
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
    featureId?: string;
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
}>;
