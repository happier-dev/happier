import type { ExtensionManifestV2 } from '@happier-dev/protocol';

// Thin composition file that declares this extension’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const EXTENSION_MANIFEST: ExtensionManifestV2 = Object.freeze({
  schemaVersion: 2,
  id: '__extensionId__',
  version: '0.0.0',
  displayName: '__extensionId__',
  description: undefined,
  engines: Object.freeze({ happier: '^0.0.0' }),
  runtime: Object.freeze({ apiVersion: 1, capabilities: Object.freeze([]) }),
  targets: Object.freeze({}),
  permissions: Object.freeze([]),
  contributions: Object.freeze([]),
});
