import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const GROK_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'grok',
    title: { key: 'settingsProviders.plugins.grok.title' },
    icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'indigo' } },
});
