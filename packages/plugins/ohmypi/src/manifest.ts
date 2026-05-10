import type { PluginManifestV2 } from '@happier-dev/protocol';

// Skeleton manifest reserved for Stage E.9 extraction.
// Substantive capabilities + contributions land during E.9 (OhMyPi — Tier 1 ACP session runtime + external sessions + connected services).
export const PLUGIN_MANIFEST: PluginManifestV2 = {
  schemaVersion: 2,
  // Package path/name stay lowercase (`packages/plugins/ohmypi`), while the runtime/provider id
  // remains the existing wire contract `ohMyPi`.
  id: 'happier.agent.ohmypi',
  version: '0.0.0',
  displayName: 'ohmypi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
};
