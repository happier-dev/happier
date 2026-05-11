import type { PluginManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.agent.codex',
  version: '0.0.0',
  displayName: 'codex',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['agents', 'backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'codex',
        agentId: 'codex',
        engine: { kind: 'custom' },
        capabilities: {
          session: {
            media: {
              emitsSessionMedia: {
                supported: true,
                mediaKinds: ['image'],
                sources: ['provider-generated'],
                storage: 'session-media-file',
              },
              nativeImageGeneration: {
                supported: true,
                mediaKinds: ['image'],
                streamingPartials: false,
              },
            },
          },
        },
      },
    ],
  },
};
