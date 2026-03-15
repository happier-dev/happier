import { z } from 'zod';

import { buildOpenCodeProviderSettingsShape, OPENCODE_PROVIDER_SETTINGS_DEFAULTS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/_shared/providerSettingsPlugin';

const shape = buildOpenCodeProviderSettingsShape(z);
const defaults: Record<keyof typeof shape, unknown> = OPENCODE_PROVIDER_SETTINGS_DEFAULTS;

export const OPENCODE_PROVIDER_SETTINGS_PLUGIN = {
    providerId: 'opencode',
    title: 'OpenCode',
    icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
    settingsShape: shape,
    settingsDefaults: defaults,
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
    ],
    buildOutgoingMessageMetaExtras: () => ({}),
} as const satisfies ProviderSettingsPlugin;
