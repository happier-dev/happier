import type React from 'react';

import type { ProviderSettingsIconColor, ProviderSettingsPlugin, TranslatableText } from './providerSettingsPlugin';

export function createNoopProviderSettingsPlugin<TProviderId extends string>(params: Readonly<{
    providerId: TProviderId;
    title: TranslatableText;
    icon: Readonly<{ ionName: string; color: ProviderSettingsIconColor }>;
    ExtraSectionsComponent?: React.ComponentType<Readonly<{ providerId: TProviderId }>>;
}>): ProviderSettingsPlugin {
    return {
        providerId: params.providerId,
        title: params.title,
        icon: params.icon,
        // Pass through provider-owned extra sections without importing React at module init time.
        // The provider settings screen already renders this with the correct providerId.
        ExtraSectionsComponent: params.ExtraSectionsComponent as unknown as ProviderSettingsPlugin['ExtraSectionsComponent'],
        settings: {},
        uiSections: [],
    };
}
