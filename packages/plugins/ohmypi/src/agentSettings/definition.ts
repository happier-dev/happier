import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const OH_MY_PI_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.ohmypi.title', fallback: 'Oh My Pi' },
  target: { kind: 'agent', agent: 'ohmypi' },
  scope: 'account',
  fields: [{
    id: 'ohMyPiAgentDir',
    title: {
      key: 'settingsAgents.plugins.ohmypi.fields.ohMyPiAgentDir.title',
      fallback: 'Agent directory',
    },
    description: {
      key: 'settingsAgents.plugins.ohmypi.fields.ohMyPiAgentDir.subtitle',
      fallback: 'Optional Oh My Pi data root. Leave empty to use ~/.omp/agent.',
    },
    schema: { type: 'string', maxLength: 10_000 },
    default: '',
    presentation: { control: 'text' },
  }],
  presentation: {
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'orange' } },
    subagentSections: [],
    sections: [{
      id: 'ohmypi-storage',
      title: { key: 'settingsAgents.plugins.ohmypi.sections.storage.title', fallback: 'Storage' },
      description: {
        key: 'settingsAgents.plugins.ohmypi.sections.storage.footer',
        fallback: 'This directory is used only for Oh My Pi sessions started or discovered by Happier.',
      },
      fields: ['ohMyPiAgentDir'],
    }],
  },
} satisfies PluginSettingsContribution;
