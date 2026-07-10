import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

export const KIRO_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'kiro.agentSettings.v1',
  agentId: 'kiro',
  fields: [],
  ui: {
    title: { key: 'settingsAgents.plugins.kiro.title' },
    icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'orange' } },
    subagentSettingsSections: [],
    sections: [],
  },
});

export const KIRO_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  KIRO_AGENT_SETTINGS_CONTRIBUTION,
);

export const KIRO_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  KIRO_AGENT_SETTINGS_CONTRIBUTION,
);
