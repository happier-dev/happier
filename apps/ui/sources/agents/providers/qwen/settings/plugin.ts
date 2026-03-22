import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const QWEN_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'qwen',
    title: { key: 'settingsProviders.plugins.qwen.title' },
    icon: { ionName: 'code-slash-outline', color: '#007AFF' },
});
