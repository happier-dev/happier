export const OPENCODE_PROVIDER_SETTINGS_DESCRIPTOR = {
    kind: 'providerSettings.v1',
    descriptorId: 'opencode.providerSettings.v1',
    providerId: 'opencode',
    title: { key: 'settingsProviders.plugins.opencode.title' },
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'blue' } },
    settings: {
        opencodeBackendMode: {
            schema: { kind: 'enum', values: ['server', 'acp'] },
            default: 'server',
            description: 'Preferred OpenCode backend mode',
            storageScope: 'account',
        },
        opencodeServerBaseUrl: {
            schema: { kind: 'string' },
            default: '',
            description: 'Optional override for a user-managed OpenCode server URL',
            storageScope: 'account',
        },
        opencodeServerBaseUrlByServerIdV1: {
            schema: { kind: 'stringRecord' },
            default: {},
            description: 'Per-server overrides for user-managed OpenCode server URLs',
            storageScope: 'account',
        },
    },
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
} as const;
