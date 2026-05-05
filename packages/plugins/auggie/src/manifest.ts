import type { PluginManifestV2 } from '@happier-dev/protocol';

// Skeleton manifest reserved for Stage E.2 extraction.
// Substantive capabilities + contributions land during E.2 (Auggie — Tier 2 activate-hook).
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'auggie',
  version: '0.0.0',
  displayName: 'auggie',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
};
