import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

export const AUGGIE_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'auggie.agentSettings.v1',
  agentId: 'auggie',
  fields: [],
  ui: {
    title: { key: 'settingsAgents.plugins.auggie.title' },
    icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'green' } },
    subagentSettingsSections: [],
    sections: [],
  },
});

export const AUGGIE_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  AUGGIE_AGENT_SETTINGS_CONTRIBUTION,
);

export const AUGGIE_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  AUGGIE_AGENT_SETTINGS_CONTRIBUTION,
);
