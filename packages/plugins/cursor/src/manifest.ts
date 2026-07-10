import {
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

const CURSOR_BACKEND_ID = 'cursor';

type CursorPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.cursor',
  version: '0.0.0',
  displayName: 'Cursor',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:cursor'],
  uses: ['agents'],
  entrypoints: { main: './dist/index.js' },
  permissions: {
    required: [
      {
        capability: 'env',
        reason: 'Read CURSOR_API_KEY when the user chooses environment-based Cursor authentication.',
        scope: 'CURSOR_API_KEY',
      },
    ],
    optional: [],
  },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: CURSOR_BACKEND_ID,
        runtime: { kind: 'custom' },
        surfaceHandlers: [],
        capabilities: {
          executionRun: { supported: false },
          session: {
            media: {
              acceptsImageInput: { supported: false },
              emitsSessionMedia: { supported: false },
              nativeImageGeneration: { supported: false },
            },
          },
        },
      },
    ],
  },
} satisfies CursorPluginManifestV2);
