import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const KIMI_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'kimi',
    title: { key: 'settingsProviders.plugins.kimi.title' },
    icon: { ionName: 'leaf-outline', color: '#32D74B' },
});
