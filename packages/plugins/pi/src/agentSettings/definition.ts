import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const PI_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.pi.title', fallback: 'Pi' },
  target: { kind: 'agent', agent: 'pi' },
  scope: 'account',
  fields: [{
    id: 'piAgentDir',
    title: { key: 'settingsAgents.plugins.pi.fields.piAgentDir.title', fallback: 'Agent directory' },
    description: {
      key: 'settingsAgents.plugins.pi.fields.piAgentDir.subtitle',
      fallback: 'Optional Pi data root. Leave empty to use ~/.pi/agent.',
    },
    schema: { type: 'string', maxLength: 10_000 },
    default: '',
    presentation: { control: 'text' },
  }],
  presentation: {
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'green' } },
    subagentSections: [],
    sections: [{
      id: 'pi-storage',
      title: { key: 'settingsAgents.plugins.pi.sections.storage.title', fallback: 'Storage' },
      description: {
        key: 'settingsAgents.plugins.pi.sections.storage.footer',
        fallback: 'This directory is used only for Pi sessions started or discovered by Happier.',
      },
      fields: ['piAgentDir'],
    }],
  },
} satisfies PluginSettingsContribution;
