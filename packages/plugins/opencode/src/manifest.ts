import type { PluginManifestV2 } from '@happier-dev/protocol';

const OPENCODE_BACKEND_ID = 'opencode';

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.agent.opencode',
  version: '0.0.0',
  displayName: 'opencode',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: OPENCODE_BACKEND_ID,
        agentId: 'opencode',
        engine: { kind: 'custom' },
        capabilities: {
          executionRun: { supported: false },
          session: {
            media: {
              emitsSessionMedia: {
                supported: true,
                mediaKinds: ['image'],
                sources: ['acp-content', 'mcp-content'],
                storage: 'session-media-file',
              },
              nativeImageGeneration: { supported: false },
            },
          },
        },
      },
    ],
  },
};
