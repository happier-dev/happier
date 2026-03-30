import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const PI_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'pi',
    title: { key: 'settingsProviders.plugins.pi.title' },
    icon: { ionName: 'code-slash-outline', color: '#22C55E' },
});
