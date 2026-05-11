import type { PluginManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this plugin’s canonical manifest.
// Keep unsupported media defaults explicit until a source-real media event is mapped.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  // Package path/name stay lowercase (`packages/plugins/ohmypi`), while the runtime/provider id
  // remains the existing wire contract `ohMyPi`.
  id: 'happier.agent.ohmypi',
  version: '0.0.0',
  displayName: 'ohmypi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'ohMyPi',
        agentId: 'ohMyPi',
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
