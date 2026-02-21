import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const COPILOT_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'copilot',
    title: 'Copilot',
    icon: { ionName: 'logo-github', color: '#24292e' },
});
