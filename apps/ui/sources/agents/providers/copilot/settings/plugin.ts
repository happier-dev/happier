import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const COPILOT_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'copilot',
    title: { key: 'settingsProviders.plugins.copilot.title' },
    icon: { ionName: 'logo-github', color: '#24292e' },
});
