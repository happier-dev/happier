import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const KILO_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.kilo.title', fallback: 'Kilo' },
  target: { kind: 'agent', agent: 'kilo' },
  scope: 'account',
  fields: [],
  presentation: {
    icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'orange' } },
    subagentSections: [],
    sections: [],
  },
} satisfies PluginSettingsContribution;
