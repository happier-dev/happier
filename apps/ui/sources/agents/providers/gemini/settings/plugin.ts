import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const GEMINI_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'gemini',
    title: { key: 'settingsProviders.plugins.gemini.title' },
    icon: { ionName: 'planet-outline', color: '#007AFF' },
});
