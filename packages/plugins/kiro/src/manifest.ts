import { definePluginManifest, type PluginManifestV2 } from '@happier-dev/plugin-sdk';

// Skeleton manifest reserved for Stage E.6 extraction.
// Kiro is a Tier 1 PLACEHOLDER — vendor CLI not generally available yet.
// This reservation package keeps the id and stage ownership explicit, but it is
// intentionally not shipped through the bundled-plugin path until Stage E.6
// lands the real backend/provider topology and the protocol exposes the
// canonical vendor-incomplete contract. See
// .project/plans/runtime-unification-v2/stages/stage-E/E.6.md.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.kiro',
  version: '0.0.0',
  displayName: 'kiro',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: [] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {},
} satisfies PluginManifestV2);
