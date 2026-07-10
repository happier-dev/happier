import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  enumAgentSetting,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

export const ANTIGRAVITY_RUNTIME_MODE_VALUES = ['auto', 'cliPrint', 'sdk'] as const;
export type AntigravityRuntimeMode = (typeof ANTIGRAVITY_RUNTIME_MODE_VALUES)[number];

type TranslationRef = Readonly<{ key: string }>;

function translation(key: string): TranslationRef {
  return { key };
}

function runtimeModeOption(id: AntigravityRuntimeMode) {
  return {
    id,
    title: translation(`settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.${id}.title`),
    subtitle: translation(`settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.${id}.subtitle`),
  } as const;
}

export const ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'antigravity.agentSettings.v1',
  agentId: 'antigravity',
  fields: [
    enumAgentSetting({
      id: 'antigravityRuntimeMode',
      values: ANTIGRAVITY_RUNTIME_MODE_VALUES,
      default: 'auto',
      description: 'Preferred Antigravity runtime mode',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
      },
      ui: {
        kind: 'enum',
        title: translation('settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.title'),
        subtitle: translation('settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.subtitle'),
        enumOptions: ANTIGRAVITY_RUNTIME_MODE_VALUES.map(runtimeModeOption),
      },
    }),
  ],
  ui: {
    title: translation('settingsAgents.plugins.antigravity.title'),
    icon: { ionName: 'rocket-outline', color: { kind: 'theme', token: 'blue' } },
    subagentSettingsSections: [],
    sections: [
      {
        id: 'antigravityRuntime',
        title: translation('settingsAgents.plugins.antigravity.sections.runtime.title'),
        footer: translation('settingsAgents.plugins.antigravity.sections.runtime.footer'),
        fields: ['antigravityRuntimeMode'],
      },
    ],
  },
});

export const ANTIGRAVITY_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION,
);

export const ANTIGRAVITY_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION,
);
