import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const CODEBUDDY_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'codebuddy',
    title: { key: 'settingsProviders.plugins.codebuddy.title' },
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'green' } },
});
