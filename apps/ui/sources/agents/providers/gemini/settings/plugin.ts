import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const GEMINI_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'gemini',
    title: 'Gemini',
    icon: { ionName: 'planet-outline', color: '#007AFF' },
});
