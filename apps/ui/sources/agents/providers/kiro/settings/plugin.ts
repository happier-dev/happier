import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const KIRO_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'kiro',
    title: { key: 'settingsProviders.plugins.kiro.title' },
    icon: { ionName: 'flash-outline', color: '#0EA5E9' },
});
