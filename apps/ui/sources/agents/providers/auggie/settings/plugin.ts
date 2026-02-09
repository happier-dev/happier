import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const AUGGIE_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'auggie',
    title: 'Auggie',
    icon: { ionName: 'sparkles-outline', color: '#34C759' },
});
