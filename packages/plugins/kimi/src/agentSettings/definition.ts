import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

const KIMI_ACP_PYTHON_SELECTOR_VALUES = ['auto', 'poll'] as const;

const KIMI_ACP_PYTHON_SELECTOR_PRESENTATION = {
  auto: {
    title: 'Automatic',
    description: "Use Kimi's default Python selector.",
  },
  poll: {
    title: 'Compatibility mode',
    description: 'Use poll() instead of epoll() for Kimi ACP stdio.',
  },
} satisfies Record<(typeof KIMI_ACP_PYTHON_SELECTOR_VALUES)[number], { title: string; description: string }>;

export const KIMI_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.kimi.title', fallback: 'Kimi' },
  target: { kind: 'agent', agent: 'kimi' },
  scope: 'account',
  fields: [
    {
      id: 'kimiAcpPythonSelector',
      title: {
        key: 'settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.title',
        fallback: 'Python stdio selector',
      },
      description: {
        key: 'settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.subtitle',
        fallback: "Choose how Happier starts Kimi ACP's Python stdio loop.",
      },
      schema: {
        type: 'string',
        description: 'Kimi ACP Python stdio selector compatibility mode',
        enum: [...KIMI_ACP_PYTHON_SELECTOR_VALUES],
      },
      default: 'auto',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
      },
      presentation: {
        control: 'select',
        options: KIMI_ACP_PYTHON_SELECTOR_VALUES.map((value) => ({
          value,
          title: {
            key: `settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.${value}.title`,
            fallback: KIMI_ACP_PYTHON_SELECTOR_PRESENTATION[value].title,
          },
          description: {
            key: `settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.${value}.subtitle`,
            fallback: KIMI_ACP_PYTHON_SELECTOR_PRESENTATION[value].description,
          },
        })),
      },
    },
  ],
  presentation: {
    icon: { ionName: 'leaf-outline', color: { kind: 'theme', token: 'green' } },
    subagentSections: [],
    sections: [
      {
        id: 'kimi-compatibility',
        title: {
          key: 'settingsAgents.plugins.kimi.sections.compatibility.title',
          fallback: 'Compatibility',
        },
        description: {
          key: 'settingsAgents.plugins.kimi.sections.compatibility.footer',
          fallback: 'Use compatibility mode only for Linux/container environments where Kimi ACP startup hangs.',
        },
        fields: ['kimiAcpPythonSelector'],
      },
    ],
  },
} satisfies PluginSettingsContribution;
