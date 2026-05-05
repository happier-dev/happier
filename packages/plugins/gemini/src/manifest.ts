import type { PluginManifestV2 } from '@happier-dev/protocol';

// Skeleton manifest reserved for Stage E.8 extraction.
// Substantive capabilities + contributions land during E.8.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'gemini',
  version: '0.0.0',
  displayName: 'gemini',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
};
