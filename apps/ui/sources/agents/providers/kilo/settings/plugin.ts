import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const KILO_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'kilo',
    title: { key: 'settingsProviders.plugins.kilo.title' },
    icon: { ionName: 'flash-outline', color: '#FF9500' },
});
