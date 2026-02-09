import type { AgentId } from '@/agents/catalog/catalog';

import type { ProviderSettingsPlugin } from './providerSettingsPlugin';

export function createNoopProviderSettingsPlugin(params: Readonly<{
    providerId: AgentId;
    title: string;
    icon: Readonly<{ ionName: string; color: string }>;
}>): ProviderSettingsPlugin {
    return {
        providerId: params.providerId,
        title: params.title,
        icon: params.icon,
        settingsShape: {},
        settingsDefaults: {},
        uiSections: [],
        buildOutgoingMessageMetaExtras: () => ({}),
    };
}
