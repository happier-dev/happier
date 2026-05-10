import type { PluginManifestV2 } from '@happier-dev/protocol';

// Skeleton manifest reserved for Stage E.5 extraction.
// Substantive capabilities + contributions land during E.5 (Kilo — Tier 2 activate-hook).
// L-2 violations in current source (`src/agent/acp.ts` plus `src/permissions/**`) will be fixed during extraction.
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'happier.agent.kilo',
  version: '0.0.0',
  displayName: 'kilo',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
};
