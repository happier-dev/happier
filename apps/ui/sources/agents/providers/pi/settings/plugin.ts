import { PI_PROVIDER_FIELDS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export const PI_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'pi',
    title: { key: 'settingsProviders.plugins.pi.title' },
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'green' } },
    settings: PI_PROVIDER_FIELDS,
    uiSections: [
        {
            id: 'piNativeTerminal',
            title: { key: 'settings.terminal' },
            fields: [
                {
                    key: 'piNativeTerminalEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.pi.nativeTerminal.title' },
                    subtitle: { key: 'settingsProviders.plugins.pi.nativeTerminal.subtitle' },
                },
            ],
        },
    ],
    buildOutgoingMessageMetaExtras: () => ({}),
};
