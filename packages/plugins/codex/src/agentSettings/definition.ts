import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  enumAgentSetting,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

const CODEX_BACKEND_MODE_VALUES = ['acp', 'appServer', 'mcp', 'mcp_resume'] as const;
const CODEX_BACKEND_MODE_UI_VALUES = ['appServer', 'acp'] as const;

type TranslationRef = Readonly<{ key: string }>;

function translation(key: string): TranslationRef {
  return { key };
}

function codexBackendModeOption(id: (typeof CODEX_BACKEND_MODE_UI_VALUES)[number]) {
  return {
    id,
    title: translation(`settingsAgents.plugins.codex.fields.codexBackendMode.options.${id}.title`),
    subtitle: translation(`settingsAgents.plugins.codex.fields.codexBackendMode.options.${id}.subtitle`),
  } as const;
}

export const CODEX_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'codex.agentSettings.v1',
  agentId: 'codex',
  fields: [
    enumAgentSetting({
      id: 'codexBackendMode',
      values: CODEX_BACKEND_MODE_VALUES,
      default: 'appServer',
      description: 'Preferred Codex backend mode',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
      },
      ui: {
        kind: 'enum',
        title: translation('settingsAgents.plugins.codex.fields.codexBackendMode.title'),
        subtitle: translation('settingsAgents.plugins.codex.fields.codexBackendMode.subtitle'),
        enumOptions: CODEX_BACKEND_MODE_UI_VALUES.map(codexBackendModeOption),
      },
    }),
  ],
  ui: {
    title: translation('settingsAgents.plugins.codex.title'),
    icon: { ionName: 'terminal-outline', color: { kind: 'theme', token: 'blue' } },
    subagentSettingsSections: [],
    sections: [
      {
        id: 'codexMode',
        title: translation('settingsAgents.plugins.codex.sections.backendMode.title'),
        footer: translation('settingsAgents.plugins.codex.sections.backendMode.footer'),
        fields: ['codexBackendMode'],
      },
    ],
  },
});

export const CODEX_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  CODEX_AGENT_SETTINGS_CONTRIBUTION,
);

export const CODEX_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  CODEX_AGENT_SETTINGS_CONTRIBUTION,
);
