import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  enumAgentSetting,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

const KIMI_ACP_PYTHON_SELECTOR_VALUES = ['auto', 'poll'] as const;

type TranslationRef = Readonly<{ key: string }>;

function translation(key: string): TranslationRef {
  return { key };
}

function kimiPythonSelectorOption(id: (typeof KIMI_ACP_PYTHON_SELECTOR_VALUES)[number]) {
  return {
    id,
    title: translation(`settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.${id}.title`),
    subtitle: translation(`settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.${id}.subtitle`),
  } as const;
}

export const KIMI_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'kimi.agentSettings.v1',
  agentId: 'kimi',
  fields: [
    enumAgentSetting({
      id: 'kimiAcpPythonSelector',
      values: KIMI_ACP_PYTHON_SELECTOR_VALUES,
      default: 'auto',
      description: 'Kimi ACP Python stdio selector compatibility mode',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
      },
      ui: {
        kind: 'enum',
        title: translation('settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.title'),
        subtitle: translation('settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.subtitle'),
        enumOptions: KIMI_ACP_PYTHON_SELECTOR_VALUES.map(kimiPythonSelectorOption),
      },
    }),
  ],
  ui: {
    title: translation('settingsAgents.plugins.kimi.title'),
    icon: { ionName: 'leaf-outline', color: { kind: 'theme', token: 'green' } },
    subagentSettingsSections: [],
    sections: [
      {
        id: 'kimiCompatibility',
        title: translation('settingsAgents.plugins.kimi.sections.compatibility.title'),
        footer: translation('settingsAgents.plugins.kimi.sections.compatibility.footer'),
        fields: ['kimiAcpPythonSelector'],
      },
    ],
  },
});

export const KIMI_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  KIMI_AGENT_SETTINGS_CONTRIBUTION,
);

export const KIMI_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  KIMI_AGENT_SETTINGS_CONTRIBUTION,
);
