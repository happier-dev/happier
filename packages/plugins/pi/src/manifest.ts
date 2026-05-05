import type { PluginManifestV2 } from '@happier-dev/protocol';

// Skeleton manifest reserved for Stage E.10 extraction.
// Substantive capabilities + contributions land during E.10 (Pi — Tier 3 native, single-role RPC leaf through ACP factory).
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  id: 'pi',
  version: '0.0.0',
  displayName: 'pi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
};
