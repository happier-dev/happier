import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

export const PI_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'pi.agentSettings.v1',
  agentId: 'pi',
  fields: [],
  ui: {
    title: { key: 'settingsAgents.plugins.pi.title' },
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'green' } },
    subagentSettingsSections: [],
    sections: [],
  },
});

export const PI_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  PI_AGENT_SETTINGS_CONTRIBUTION,
);

export const PI_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  PI_AGENT_SETTINGS_CONTRIBUTION,
);
