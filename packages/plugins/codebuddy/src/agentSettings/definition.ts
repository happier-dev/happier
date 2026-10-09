import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const CODEBUDDY_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.codebuddy.title', fallback: 'CodeBuddy' },
  target: { kind: 'agent', agent: 'codebuddy' },
  scope: 'account',
  fields: [],
  presentation: {
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'green' } },
    subagentSections: [],
    sections: [],
  },
} satisfies PluginSettingsContribution;
