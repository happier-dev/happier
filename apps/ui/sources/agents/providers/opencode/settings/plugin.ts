import { OPENCODE_PROVIDER_FIELDS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export const OPENCODE_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'opencode',
    title: { key: 'settingsProviders.plugins.opencode.title' },
    icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
    settings: OPENCODE_PROVIDER_FIELDS,
    uiSections: [
        {
            id: 'opencodeBackendMode',
            title: { key: 'settingsProviders.plugins.opencode.sections.backendMode.title' },
            footer: { key: 'settingsProviders.plugins.opencode.sections.backendMode.footer' },
            fields: [
                {
                    key: 'opencodeBackendMode',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.title' },
                    subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.subtitle' },
                    enumOptions: [
                        {
                            id: 'server',
                            title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.server.title' },
                            subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.server.subtitle' },
                        },
                        {
                            id: 'acp',
                            title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.acp.title' },
                            subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.acp.subtitle' },
                        },
                    ],
                },
            ],
        },
        {
            id: 'opencodeServer',
            title: { key: 'settingsProviders.plugins.opencode.sections.server.title' },
            footer: { key: 'settingsProviders.plugins.opencode.sections.server.footer' },
            fields: [
                {
                    key: 'opencodeServerBaseUrl',
                    kind: 'text',
                    title: { key: 'settingsProviders.plugins.opencode.fields.opencodeServerBaseUrl.title' },
                    subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeServerBaseUrl.subtitle' },
                    binding: {
                        kind: 'perActiveServer',
                        fallbackSettingKey: 'opencodeServerBaseUrl',
                        byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
                    },
                },
            ],
        },
    ],
    buildOutgoingMessageMetaExtras: () => ({}),
};
