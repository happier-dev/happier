import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/manifest';

export const KIRO_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.kiro.title', fallback: 'Kiro' },
  target: { kind: 'agent', agent: 'kiro' },
  scope: 'synced',
  fields: [],
  presentation: {
    icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'orange' } },
    subagentSections: [],
    sections: [],
  },
} satisfies PluginSettingsContribution;
