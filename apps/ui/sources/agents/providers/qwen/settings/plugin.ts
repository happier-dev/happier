import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const QWEN_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'qwen',
    title: 'Qwen Code',
    icon: { ionName: 'code-slash-outline', color: '#007AFF' },
});
