import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

const CODEX_BACKEND_MODE_VALUES = ['acp', 'appServer', 'mcp', 'mcp_resume'] as const;
const CODEX_BACKEND_MODE_UI_VALUES = ['appServer', 'acp'] as const;

const CODEX_BACKEND_MODE_PRESENTATION = {
  appServer: {
    title: 'App Server',
    description: 'Recommended official Codex app-server mode',
  },
  acp: {
    title: 'ACP',
    description: 'Route Codex through ACP (codex-acp)',
  },
} satisfies Record<(typeof CODEX_BACKEND_MODE_UI_VALUES)[number], { title: string; description: string }>;

export const CODEX_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.codex.title', fallback: 'Codex' },
  target: { kind: 'agent', agent: 'codex' },
  scope: 'account',
  fields: [
    {
      id: 'codexBackendMode',
      title: {
        key: 'settingsAgents.plugins.codex.fields.codexBackendMode.title',
        fallback: 'Codex routing mode',
      },
      description: {
        key: 'settingsAgents.plugins.codex.fields.codexBackendMode.subtitle',
        fallback: 'Select App Server, ACP, or MCP.',
      },
      schema: {
        type: 'string',
        description: 'Preferred Codex backend mode',
        enum: [...CODEX_BACKEND_MODE_VALUES],
      },
      default: 'appServer',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
      },
      presentation: {
        control: 'select',
        options: CODEX_BACKEND_MODE_UI_VALUES.map((value) => ({
          value,
          title: {
            key: `settingsAgents.plugins.codex.fields.codexBackendMode.options.${value}.title`,
            fallback: CODEX_BACKEND_MODE_PRESENTATION[value].title,
          },
          description: {
            key: `settingsAgents.plugins.codex.fields.codexBackendMode.options.${value}.subtitle`,
            fallback: CODEX_BACKEND_MODE_PRESENTATION[value].description,
          },
        })),
      },
    },
  ],
  presentation: {
    icon: { ionName: 'terminal-outline', color: { kind: 'theme', token: 'blue' } },
    subagentSections: [],
    sections: [
      {
        id: 'codex-mode',
        title: {
          key: 'settingsAgents.plugins.codex.sections.backendMode.title',
          fallback: 'Routing mode',
        },
        description: {
          key: 'settingsAgents.plugins.codex.sections.backendMode.footer',
          fallback: 'Choose how Codex is routed. App Server is the recommended default. Local/remote switching and resume work with App Server; ACP remains available as a legacy fallback.',
        },
        fields: ['codexBackendMode'],
      },
    ],
  },
} satisfies PluginSettingsContribution;
