import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  enumAgentSetting,
  agentSettingsContributionToUiDescriptor,
  stringAgentSetting,
  stringRecordAgentSetting,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

const OPENCODE_BACKEND_MODE_VALUES = ['server', 'acp'] as const;

type TranslationRef = Readonly<{ key: string }>;

function translation(key: string): TranslationRef {
  return { key };
}

function opencodeBackendModeOption(id: (typeof OPENCODE_BACKEND_MODE_VALUES)[number]) {
  return {
    id,
    title: translation(`settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.${id}.title`),
    subtitle: translation(`settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.${id}.subtitle`),
  } as const;
}

export const OPENCODE_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'opencode.agentSettings.v1',
  agentId: 'opencode',
  fields: [
    enumAgentSetting({
      id: 'opencodeBackendMode',
      values: OPENCODE_BACKEND_MODE_VALUES,
      default: 'server',
      description: 'Preferred OpenCode backend mode',
      ui: {
        kind: 'enum',
        title: translation('settingsAgents.plugins.opencode.fields.opencodeBackendMode.title'),
        subtitle: translation('settingsAgents.plugins.opencode.fields.opencodeBackendMode.subtitle'),
        enumOptions: OPENCODE_BACKEND_MODE_VALUES.map(opencodeBackendModeOption),
      },
    }),
    stringAgentSetting({
      id: 'opencodeServerBaseUrl',
      default: '',
      description: 'Optional override for a user-managed OpenCode server URL',
      ui: {
        kind: 'text',
        title: translation('settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.title'),
        subtitle: translation('settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.subtitle'),
        binding: {
          kind: 'perActiveServer',
          fallbackSettingKey: 'opencodeServerBaseUrl',
          byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
        },
      },
    }),
    stringRecordAgentSetting({
      id: 'opencodeServerBaseUrlByServerIdV1',
      default: {},
      description: 'Per-server overrides for user-managed OpenCode server URLs',
    }),
  ],
  ui: {
    title: translation('settingsAgents.plugins.opencode.title'),
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'blue' } },
    subagentSettingsSections: [],
    sections: [
      {
        id: 'opencodeBackendMode',
        title: translation('settingsAgents.plugins.opencode.sections.backendMode.title'),
        footer: translation('settingsAgents.plugins.opencode.sections.backendMode.footer'),
        fields: ['opencodeBackendMode'],
      },
      {
        id: 'opencodeServer',
        title: translation('settingsAgents.plugins.opencode.sections.server.title'),
        footer: translation('settingsAgents.plugins.opencode.sections.server.footer'),
        fields: ['opencodeServerBaseUrl'],
      },
    ],
  },
});

export const OPENCODE_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  OPENCODE_AGENT_SETTINGS_CONTRIBUTION,
);

export const OPENCODE_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  OPENCODE_AGENT_SETTINGS_CONTRIBUTION,
);
