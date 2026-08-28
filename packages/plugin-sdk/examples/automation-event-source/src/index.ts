import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';

const repositoryInputSchema = {
  type: 'object',
  properties: { repository: { type: 'string', minLength: 1 } },
  required: ['repository'],
  additionalProperties: false,
} as const;

export const { manifest, activate } = definePlugin({
  id: 'examples.automation-event-source',
  version: '0.1.0',
  displayName: 'Automation Event Source Setup Example',
  description: 'External Event source declaration and optional setup presentation.',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: { required: [], optional: [] },
  actions: {
    'setup-repository': {
      title: 'Choose repository',
      description: 'Choose the repository whose pushes should trigger this Automation.',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: repositoryInputSchema,
      inputHints: {
        title: 'Repository',
        fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }],
      },
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, repositoryInputSchema),
      run: async (input: Readonly<{ repository: string }>) => ({
        v: 1 as const,
        sourceInstanceId: input.repository,
        sourceContractVersion: 1 as const,
        sourceConfig: { repository: input.repository },
        displayLabel: input.repository,
      }),
    },
  },
  events: {
    'repository-pushed': {
      declaration: {
        kind: 'event',
        title: 'Repository pushed',
        description: 'A push was observed in the selected repository.',
        payloadSchema: {
          type: 'object',
          properties: {
            repository: { type: 'string' },
            ref: { type: 'string' },
          },
          required: ['repository', 'ref'],
          additionalProperties: false,
        },
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: repositoryInputSchema,
            setupActionRef: {
              pluginId: 'examples.automation-event-source',
              localId: 'setup-repository',
            },
            setupSurface: {
              renderer: 'repository-picker',
              fallbackRenderers: ['repository-picker-fallback'],
            },
          },
        },
      },
    },
  },
  ui: {
    views: [],
    renderers: [{
      id: 'repository-picker',
      kind: 'hostedWeb',
      source: { kind: 'artifact', artifact: 'repository-picker' },
      requiredHostMethods: ['context', 'settleEphemeralInput'],
    }, {
      // A declarative fallback needs no build artifact and is the smallest
      // way to show that the setup surface is one renderer chain: the daemon
      // selects the available member and the host never falls back locally.
      id: 'repository-picker-fallback',
      kind: 'declarative',
      root: {
        kind: 'text',
        text: 'The hosted repository picker is unavailable here. Cancel this setup and retry on a supported surface.',
      },
    }],
    translations: [],
  },
});
