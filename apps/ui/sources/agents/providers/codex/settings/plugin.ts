import { CODEX_PROVIDER_FIELDS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export const CODEX_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'codex',
    title: { key: 'settingsProviders.plugins.codex.title' },
    icon: { ionName: 'terminal-outline', color: { kind: 'theme', token: 'blue' } },
    settings: CODEX_PROVIDER_FIELDS,
    uiSections: [
        {
            id: 'codexMode',
            title: { key: 'settingsProviders.plugins.codex.sections.backendMode.title' },
            footer: { key: 'settingsProviders.plugins.codex.sections.backendMode.footer' },
            fields: [
                {
                    key: 'codexBackendMode',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.title' },
                    subtitle: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.subtitle' },
                    enumOptions: [
                        {
                            id: 'appServer',
                            title: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.options.appServer.title' },
                            subtitle: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.options.appServer.subtitle' },
                        },
                        {
                            id: 'acp',
                            title: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.options.acp.title' },
                            subtitle: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.options.acp.subtitle' },
                        },
                        {
                            id: 'mcp',
                            title: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.options.mcp.title' },
                            subtitle: { key: 'settingsProviders.plugins.codex.fields.codexBackendMode.options.mcp.subtitle' },
                        },
                    ],
                },
            ],
        },
    ],
    buildOutgoingMessageMetaExtras: () => ({}),
};
