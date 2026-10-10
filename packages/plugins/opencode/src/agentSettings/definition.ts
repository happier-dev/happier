import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

import { OPENCODE_SERVER_PASSWORD_SETTING_ID } from '../agent/runtime/server/attachSpec.js';

const OPENCODE_BACKEND_MODE_VALUES = ['server', 'acp'] as const;
const OPENCODE_CLI_GENERATION_VALUES = ['auto', 'stable', 'v2'] as const;

const OPENCODE_CLI_GENERATION_PRESENTATION = {
  auto: {
    title: 'Auto (recommended)',
    description: 'Prefer stable OpenCode, then use V2 when stable is unavailable.',
  },
  stable: {
    title: 'Stable',
    description: 'Always launch the opencode command.',
  },
  v2: {
    title: 'V2',
    description: 'Prefer the opencode2 preview command, then the released opencode command.',
  },
} satisfies Record<(typeof OPENCODE_CLI_GENERATION_VALUES)[number], { title: string; description: string }>;

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

export const OPENCODE_AGENT_SETTINGS_CONTRIBUTION: PluginSettingsContribution = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.opencode.title', fallback: 'OpenCode' },
  target: { kind: 'agent', agent: 'opencode' },
  scope: 'account',
  fields: [
    {
      id: 'opencodeCliGeneration',
      title: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeCliGeneration.title',
        fallback: 'OpenCode version',
      },
      description: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeCliGeneration.subtitle',
        fallback: 'Choose which installed OpenCode command Happier launches.',
      },
      schema: {
        type: 'string',
        description: 'Preferred OpenCode CLI generation',
        enum: [...OPENCODE_CLI_GENERATION_VALUES],
      },
      default: 'auto',
      presentation: {
        control: 'select',
        options: OPENCODE_CLI_GENERATION_VALUES.map((value) => ({
          value,
          title: {
            key: `settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.${value}.title`,
            fallback: OPENCODE_CLI_GENERATION_PRESENTATION[value].title,
          },
          description: {
            key: `settingsAgents.plugins.opencode.fields.opencodeCliGeneration.options.${value}.subtitle`,
            fallback: OPENCODE_CLI_GENERATION_PRESENTATION[value].description,
          },
        })),
      },
    },
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
        fallback: 'Optional override for a server you run yourself. HTTPS may use any host; HTTP is limited to localhost.',
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
      // The endpoint remains Account-scoped presentation metadata. The
      // generic daemon secret owner derives its exact canonical origin at the
      // write/read boundary; it never persists a server id, URL, or secret
      // reference in the Account Settings record.
      id: OPENCODE_SERVER_PASSWORD_SETTING_ID,
      title: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeServerPassword.title',
        fallback: 'Existing OpenCode server password',
      },
      description: {
        key: 'settingsAgents.plugins.opencode.fields.opencodeServerPassword.subtitle',
        fallback: 'Set this only if your OpenCode server runs with OPENCODE_SERVER_PASSWORD. Stored encrypted on this machine and never synced.',
      },
      schema: {
        type: 'string',
        description: 'OPENCODE_SERVER_PASSWORD of a user-managed OpenCode server',
      },
      secret: {
        custody: 'daemon',
        managedServiceOrigin: { endpointSettingId: 'opencodeServerBaseUrl' },
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
    icon: { ionName: 'code', color: { kind: 'theme', token: 'blue' } },
    subagentSections: [],
    sections: [
      {
        id: 'opencode-cli-generation',
        title: {
          key: 'settingsAgents.plugins.opencode.sections.cliGeneration.title',
          fallback: 'OpenCode version',
        },
        description: {
          key: 'settingsAgents.plugins.opencode.sections.cliGeneration.footer',
          fallback: 'Auto prefers stable OpenCode. V2 selects the V2 API even when the released command is named opencode. Happier MCP tools work in ACP mode; the V2 server API does not expose dynamic registration.',
        },
        fields: ['opencodeCliGeneration'],
      },
      {
        id: 'opencode-backend-mode',
        title: {
          key: 'settingsAgents.plugins.opencode.sections.backendMode.title',
          fallback: 'Backend mode',
        },
        description: {
          key: 'settingsAgents.plugins.opencode.sections.backendMode.footer',
          fallback: 'Server mode unlocks questions. Native forking is offered only when the connected server supports it; ACP mode is a legacy fallback.',
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
          fallback: 'Leave empty to use Happier-managed OpenCode server lifecycle. Set an absolute HTTPS URL for any server you run yourself, or HTTP only for localhost. Put the password in the field below, never in the URL.',
        },
        fields: ['opencodeServerBaseUrl', OPENCODE_SERVER_PASSWORD_SETTING_ID],
      },
    ],
  },
};
