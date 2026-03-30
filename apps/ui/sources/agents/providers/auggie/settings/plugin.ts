import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const AUGGIE_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'auggie',
    title: { key: 'settingsProviders.plugins.auggie.title' },
    icon: { ionName: 'sparkles-outline', color: '#34C759' },
});
