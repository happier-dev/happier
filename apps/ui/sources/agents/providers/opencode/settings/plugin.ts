import { createNoopProviderSettingsPlugin } from '@/agents/providers/_shared/createNoopProviderSettingsPlugin';

export const OPENCODE_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'opencode',
    title: 'OpenCode',
    icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
});
