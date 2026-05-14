import type { PluginManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in provider-owned CLI modules.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.agent.pi',
  version: '0.0.0',
  displayName: 'pi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'pi',
        agentId: 'pi',
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
