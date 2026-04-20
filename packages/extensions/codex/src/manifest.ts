import type { ExtensionManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this extension’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const EXTENSION_MANIFEST: ExtensionManifestV2 = {
  schemaVersion: 2,
  id: 'codex',
  version: '0.0.0',
  displayName: 'codex',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['providers', 'backends'] },
  targets: {},
  permissions: [],
  contributions: [],
};
