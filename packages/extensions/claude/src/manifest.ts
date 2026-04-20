import type { ExtensionManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this extension’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const EXTENSION_MANIFEST: ExtensionManifestV2 = {
  schemaVersion: 2,
  id: 'claude',
  version: '0.0.0',
  displayName: 'claude',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  permissions: [],
  contributions: [],
};
