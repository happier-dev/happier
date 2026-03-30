import * as React from 'react';

import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

const LazyCustomAcpProviderSettingsSections = React.lazy(async () => {
    const module = await import('./CustomAcpProviderSettingsSections');
    return { default: module.CustomAcpProviderSettingsSections };
});

const CustomAcpProviderSettingsSections = React.memo(function CustomAcpProviderSettingsSections(props: Readonly<{
    providerId: 'customAcp';
}>) {
    return React.createElement(
        React.Suspense,
        { fallback: null },
        React.createElement(LazyCustomAcpProviderSettingsSections, props),
    );
});

export const CUSTOM_ACP_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'customAcp',
    title: { key: 'settingsProviders.plugins.customAcp.title' },
    icon: { ionName: 'git-network-outline', color: '#0EA5E9' },
    ExtraSectionsComponent: CustomAcpProviderSettingsSections,
});
