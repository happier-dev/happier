import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const KIMI_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'kimi',
    title: 'Kimi',
    icon: { ionName: 'leaf-outline', color: '#32D74B' },
});
