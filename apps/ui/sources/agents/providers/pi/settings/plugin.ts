import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const PI_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'pi',
    title: 'Pi',
    icon: { ionName: 'code-slash-outline', color: '#22C55E' },
});
