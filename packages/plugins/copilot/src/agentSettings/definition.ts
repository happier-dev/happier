import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

export const COPILOT_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'copilot.agentSettings.v1',
  agentId: 'copilot',
  fields: [],
  ui: {
    title: { key: 'settingsAgents.plugins.copilot.title' },
    icon: { ionName: 'logo-github', color: { kind: 'theme', token: 'blue' } },
    subagentSettingsSections: [],
    sections: [],
  },
});

export const COPILOT_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  COPILOT_AGENT_SETTINGS_CONTRIBUTION,
);

export const COPILOT_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  COPILOT_AGENT_SETTINGS_CONTRIBUTION,
);
