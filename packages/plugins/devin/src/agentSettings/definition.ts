import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const DEVIN_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.devin.title', fallback: 'Devin' },
  target: { kind: 'agent', agent: 'devin' },
  scope: 'account',
  fields: [],
  presentation: {
    icon: { ionName: 'cpu', color: { kind: 'theme', token: 'blue' } },
    subagentSections: [],
    sections: [],
  },
} satisfies PluginSettingsContribution;
