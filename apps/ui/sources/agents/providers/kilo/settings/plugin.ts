import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const KILO_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'kilo',
    title: 'Kilo',
    icon: { ionName: 'flash-outline', color: '#FF9500' },
});
