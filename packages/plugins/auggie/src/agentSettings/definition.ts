import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const AUGGIE_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.auggie.title', fallback: 'Auggie' },
  target: { kind: 'agent', agent: 'auggie' },
  scope: 'account',
  fields: [],
  presentation: {
    icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'green' } },
    subagentSections: [],
    sections: [],
  },
} satisfies PluginSettingsContribution;
