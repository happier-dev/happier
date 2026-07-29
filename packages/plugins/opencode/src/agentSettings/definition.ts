import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/manifest';

const OPENCODE_BACKEND_MODE_VALUES = ['server', 'acp'] as const;

const OPENCODE_BACKEND_MODE_PRESENTATION = {
  server: {
    title: 'Server (recommended)',
    description: 'Uses OpenCode server APIs for richer features and reliability.',
  },
  acp: {
    title: 'ACP (legacy)',
    description: 'Routes OpenCode through ACP; fewer features.',
  },
} satisfies Record<(typeof OPENCODE_BACKEND_MODE_VALUES)[number], { title: string; description: string }>;

export const OPENCODE_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.opencode.title', fallback: 'OpenCode' },
  target: { kind: 'agent', agent: 'opencode' },
  scope: 'synced',
  fields: [
    {
      id: 'opencodeBackendMode',
      title: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeBackendMode.title',
        fallback: 'OpenCode backend mode',
      },
      description: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeBackendMode.subtitle',
        fallback: 'Choose the integration backend.',
      },
      schema: {
        type: 'string',
        description: 'Preferred OpenCode backend mode',
        enum: [...OPENCODE_BACKEND_MODE_VALUES],
      },
      default: 'server',
      presentation: {
        control: 'select',
        options: OPENCODE_BACKEND_MODE_VALUES.map((value) => ({
          value,
          title: {
            key: `settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.${value}.title`,
            fallback: OPENCODE_BACKEND_MODE_PRESENTATION[value].title,
          },
          description: {
            key: `settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.${value}.subtitle`,
            fallback: OPENCODE_BACKEND_MODE_PRESENTATION[value].description,
          },
        })),
      },
    },
    {
      id: 'opencodeServerBaseUrl',
      title: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.title',
        fallback: 'Existing OpenCode server URL',
      },
      description: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.subtitle',
        fallback: 'Optional override for a user-managed OpenCode server.',
      },
      schema: {
        type: 'string',
        description: 'Optional override for a user-managed OpenCode server URL',
      },
      default: '',
      presentation: {
        control: 'text',
        binding: {
          kind: 'perActiveServer',
          fallbackSettingId: 'opencodeServerBaseUrl',
          byServerIdSettingId: 'opencodeServerBaseUrlByServerIdV1',
        },
      },
    },
    {
      id: 'opencodeServerBaseUrlByServerIdV1',
      title: 'Per-server OpenCode server URLs',
      schema: {
        type: 'object',
        description: 'Per-server overrides for user-managed OpenCode server URLs',
        additionalProperties: { type: 'string' },
      },
      default: {},
      presentation: { hidden: true },
    },
  ],
  presentation: {
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'blue' } },
    subagentSections: [],
    sections: [
      {
        id: 'opencode-backend-mode',
        title: {
          key: 'settingsAgents.plugins.opencode.sections.backendMode.title',
          fallback: 'Backend mode',
        },
        description: {
          key: 'settingsAgents.plugins.opencode.sections.backendMode.footer',
          fallback: 'Server mode unlocks questions and native forking. ACP mode is a legacy fallback.',
        },
        fields: ['opencodeBackendMode'],
      },
      {
        id: 'opencode-server',
        title: {
          key: 'settingsAgents.plugins.opencode.sections.server.title',
          fallback: 'Server connection',
        },
        description: {
          key: 'settingsAgents.plugins.opencode.sections.server.footer',
          fallback: 'Leave empty to use Happier-managed OpenCode server lifecycle. Set an absolute http(s) URL to connect to an existing OpenCode server instead.',
        },
        fields: ['opencodeServerBaseUrl'],
      },
    ],
  },
} satisfies PluginSettingsContribution;
