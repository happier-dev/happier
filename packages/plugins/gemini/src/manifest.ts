import type { PluginManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this plugin’s canonical manifest.
// Keep unsupported media defaults explicit until a source-real media event is mapped.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.agent.gemini',
  version: '0.0.0',
  displayName: 'gemini',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'gemini',
        agentId: 'gemini',
        engine: { kind: 'custom' },
        capabilities: {
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
};
