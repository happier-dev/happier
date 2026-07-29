import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/manifest';

export const PI_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.pi.title', fallback: 'Pi' },
  target: { kind: 'agent', agent: 'pi' },
  scope: 'synced',
  fields: [],
  presentation: {
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'green' } },
    subagentSections: [],
    sections: [],
  },
} satisfies PluginSettingsContribution;
