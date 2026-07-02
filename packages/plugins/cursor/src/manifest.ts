import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

const CURSOR_BACKEND_ID = 'cursor';

type CursorPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.cursor',
  version: '0.0.0',
  displayName: 'Cursor',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: {
    permissions: [
      {
        capability: 'env',
        reason: 'Read CURSOR_API_KEY when the user chooses environment-based Cursor authentication.',
        scope: 'CURSOR_API_KEY',
      },
    ],
    optionalPermissions: [],
  },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: CURSOR_BACKEND_ID,
        agentId: 'cursor',
        engine: { kind: 'custom' },
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
