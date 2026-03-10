import { OPENCODE_PROVIDER_FIELDS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/_shared/providerSettingsPlugin';

export const OPENCODE_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'opencode',
    title: 'OpenCode',
    icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
    settings: OPENCODE_PROVIDER_FIELDS,
    uiSections: [
        {
            id: 'opencodeBackendMode',
            title: 'Backend mode',
            footer: 'Server mode unlocks questions and native forking. ACP mode is a legacy fallback.',
            fields: [
                {
                    key: 'opencodeBackendMode',
                    kind: 'enum',
                    title: 'OpenCode backend mode',
                    subtitle: 'Choose the integration backend.',
                    enumOptions: [
                        {
                            id: 'server',
                            title: 'Server (recommended)',
                            subtitle: 'Uses OpenCode server APIs for richer features and reliability.',
                        },
                        {
                            id: 'acp',
                            title: 'ACP (legacy)',
                            subtitle: 'Routes OpenCode through ACP; fewer features.',
                        },
                    ],
                },
            ],
        },
        {
            id: 'opencodeServer',
            title: 'Server connection',
            footer: 'Leave empty to use Happier-managed OpenCode server lifecycle. Set an absolute http(s) URL to connect to an existing OpenCode server instead.',
            fields: [
                {
                    key: 'opencodeServerBaseUrl',
                    kind: 'text',
                    title: 'Existing OpenCode server URL',
                    subtitle: 'Optional override for a user-managed OpenCode server.',
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
