import type { AgentId } from '@/agents/catalog/catalog';
import * as React from 'react';

import type { ProviderSettingsPlugin, TranslatableText } from './providerSettingsPlugin';

export function createNoopProviderSettingsPlugin<TProviderId extends AgentId>(params: Readonly<{
    providerId: TProviderId;
    title: TranslatableText;
    icon: Readonly<{ ionName: string; color: string }>;
    ExtraSectionsComponent?: React.ComponentType<Readonly<{ providerId: TProviderId }>>;
}>): ProviderSettingsPlugin {
    const ExtraSectionsComponent = params.ExtraSectionsComponent
        ? ((_: Readonly<{ providerId: AgentId }>) =>
            React.createElement(params.ExtraSectionsComponent!, { providerId: params.providerId }))
        : undefined;

    return {
        providerId: params.providerId,
        title: params.title,
        icon: params.icon,
        ExtraSectionsComponent,
        settings: {},
        uiSections: [],
        buildOutgoingMessageMetaExtras: () => ({}),
    };
}
