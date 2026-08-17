import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const ANTIGRAVITY_RUNTIME_MODE_VALUES = ['auto', 'cliPrint', 'sdk'] as const;
export type AntigravityRuntimeMode = (typeof ANTIGRAVITY_RUNTIME_MODE_VALUES)[number];

const ANTIGRAVITY_RUNTIME_MODE_PRESENTATION = {
  auto: {
    title: 'Auto',
    description: 'Prefer the subscription CLI when available, then SDK credentials.',
  },
  cliPrint: {
    title: 'Antigravity CLI (subscription)',
    description: 'Uses agy print mode with your local login; live tool approvals are degraded.',
  },
  sdk: {
    title: 'Antigravity SDK (Gemini API / Vertex)',
    description: 'Uses Gemini API key or Vertex credentials through the SDK.',
  },
} satisfies Record<AntigravityRuntimeMode, { title: string; description: string }>;

export const ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.antigravity.title', fallback: 'Antigravity' },
  target: { kind: 'agent', agent: 'antigravity' },
  scope: 'account',
  fields: [
    {
      id: 'antigravityRuntimeMode',
      title: {
        key: 'settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.title',
        fallback: 'Runtime mode',
      },
      description: {
        key: 'settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.subtitle',
        fallback: 'Select automatic routing, subscription CLI print mode, or SDK mode.',
      },
      schema: {
        type: 'string',
        description: 'Preferred Antigravity runtime mode',
        enum: [...ANTIGRAVITY_RUNTIME_MODE_VALUES],
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
        options: ANTIGRAVITY_RUNTIME_MODE_VALUES.map((value) => ({
          value,
          title: {
            key: `settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.${value}.title`,
            fallback: ANTIGRAVITY_RUNTIME_MODE_PRESENTATION[value].title,
          },
          description: {
            key: `settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.${value}.subtitle`,
            fallback: ANTIGRAVITY_RUNTIME_MODE_PRESENTATION[value].description,
          },
        })),
      },
    },
  ],
  presentation: {
    icon: { ionName: 'rocket-outline', color: { kind: 'theme', token: 'blue' } },
    subagentSections: [],
    sections: [
      {
        id: 'antigravity-runtime',
        title: {
          key: 'settingsAgents.plugins.antigravity.sections.runtime.title',
          fallback: 'Runtime',
        },
        description: {
          key: 'settingsAgents.plugins.antigravity.sections.runtime.footer',
          fallback: 'Choose how Antigravity sessions start. CLI mode uses your subscription login with degraded live controls; SDK mode uses Gemini API or Vertex credentials.',
        },
        fields: ['antigravityRuntimeMode'],
      },
    ],
  },
} satisfies PluginSettingsContribution;
