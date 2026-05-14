import type { PluginManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.agent.claude',
  version: '0.0.0',
  displayName: 'claude',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'claude',
        agentId: 'claude',
        engine: { kind: 'custom' },
        capabilities: {
          session: {
            media: {
              emitsSessionMedia: {
                supported: true,
                mediaKinds: ['image'],
                sources: ['tool-output'],
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
