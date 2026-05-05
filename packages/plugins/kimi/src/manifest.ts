import type { PluginManifestV2 } from '@happier-dev/protocol';

// Skeleton manifest reserved for Stage E.4 extraction.
// Substantive capabilities + contributions land during E.4 (Kimi — Tier 2 activate-hook).
// L-2 violation in current source (`src/permissions/` flat) will be fixed during extraction.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'kimi',
  version: '0.0.0',
  displayName: 'kimi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
};
