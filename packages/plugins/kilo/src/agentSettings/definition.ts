import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

export const KILO_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'kilo.agentSettings.v1',
  agentId: 'kilo',
  fields: [],
  ui: {
    title: { key: 'settingsAgents.plugins.kilo.title' },
    icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'orange' } },
    subagentSettingsSections: [],
    sections: [],
  },
});

export const KILO_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  KILO_AGENT_SETTINGS_CONTRIBUTION,
);

export const KILO_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  KILO_AGENT_SETTINGS_CONTRIBUTION,
);
