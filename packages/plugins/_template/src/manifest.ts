import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: '__pluginId__',
  version: '0.0.0',
  displayName: '__pluginId__',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
} satisfies PluginManifestV2);
