import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/manifest';

export const COPILOT_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.copilot.title', fallback: 'Copilot' },
  target: { kind: 'agent', agent: 'copilot' },
  scope: 'synced',
  fields: [],
  presentation: {
    icon: { ionName: 'logo-github', color: { kind: 'theme', token: 'blue' } },
    subagentSections: [],
    sections: [],
  },
} satisfies PluginSettingsContribution;
